// Pure selection logic for the area picker: period validation, cell conversion and area warnings.
import {
  DEFAULT_BASELINE,
  DEFAULT_START,
  MAX_CELLS,
  REGION_KEYS,
  type AreaSelection,
  type RegionKey,
} from "@/lib/contracts";
import {
  cellsAreaKm2,
  circlePolygon,
  polygonToCellsR6,
  presetFor,
  regionOfCells,
  type PolygonGeometry,
} from "@/lib/geo";

export const MIN_AREA_KM2 = 500;
export const MAX_RADIUS_KM = 1000;
const FIRST_MONTH = DEFAULT_START; // first month with MODIS data
const FIRST_YEAR = Number(DEFAULT_START.slice(0, 4));
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type Period = { start: string; end: string; baseline: [number, number] };

/** Raw form values for the date range and baseline years. */
export type PeriodInputs = { start: string; end: string; baselineFirst: string; baselineLast: string };

/** An area chosen by the user, before the period is attached. */
export type AreaSource =
  | { kind: "preset"; key: RegionKey }
  | { kind: "cells"; label: string; cells: string[]; warnings: string[] };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** YYYY-MM of the given date, in UTC. */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function defaultPeriodInputs(end: string): PeriodInputs {
  return {
    start: DEFAULT_START,
    end,
    baselineFirst: String(DEFAULT_BASELINE[0]),
    baselineLast: String(DEFAULT_BASELINE[1]),
  };
}

/** Validate the period form. `latest` is the current month; months after it are rejected. */
export function parsePeriod(inputs: PeriodInputs, latest: string): Result<Period> {
  const { start, end } = inputs;
  if (!YEAR_MONTH.test(start)) return { ok: false, error: "Start month must be YYYY-MM." };
  if (!YEAR_MONTH.test(end)) return { ok: false, error: "End month must be YYYY-MM." };
  if (start < FIRST_MONTH) return { ok: false, error: `Start month must be ${FIRST_MONTH} or later (first MODIS month).` };
  if (end > latest) return { ok: false, error: `End month must be ${latest} or earlier.` };
  if (end < start) return { ok: false, error: "End month must be the same as or after the start month." };

  const lastYear = Number(latest.slice(0, 4));
  const first = parseYear(inputs.baselineFirst);
  const last = parseYear(inputs.baselineLast);
  if (first === null || last === null) return { ok: false, error: "Baseline years must be whole years." };
  if (first < FIRST_YEAR || last > lastYear)
    return { ok: false, error: `Baseline years must fall between ${FIRST_YEAR} and ${lastYear}.` };
  if (first > last) return { ok: false, error: "Baseline first year must not be after the last year." };
  return { ok: true, value: { start, end, baseline: [first, last] } };
}

function parseYear(s: string): number | null {
  const t = s.trim();
  if (!/^\d{4}$/.test(t)) return null;
  return Number(t);
}

/** Validate lat/lon/radius form values and build a circle polygon. */
export function parseCircle(
  lat: string,
  lng: string,
  radiusKm: string,
): Result<{ lat: number; lng: number; radiusKm: number; geometry: PolygonGeometry; label: string }> {
  const la = parseNumber(lat);
  const lo = parseNumber(lng);
  const r = parseNumber(radiusKm);
  if (la === null || la < -90 || la > 90) return { ok: false, error: "Latitude must be a number from -90 to 90." };
  if (lo === null || lo < -180 || lo > 180) return { ok: false, error: "Longitude must be a number from -180 to 180." };
  if (r === null || r <= 0 || r > MAX_RADIUS_KM)
    return { ok: false, error: `Radius must be a number above 0 and at most ${MAX_RADIUS_KM} km.` };
  return {
    ok: true,
    value: {
      lat: la,
      lng: lo,
      radiusKm: r,
      geometry: circlePolygon(la, lo, r),
      label: `${formatKm(r)} km around ${la.toFixed(3)}, ${lo.toFixed(3)}`,
    },
  };
}

function parseNumber(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Rectangle polygon (GeoJSON, lng/lat) from a bounding box. Handles boxes that cross the antimeridian. */
export function bboxPolygon(west: number, south: number, east: number, north: number): PolygonGeometry {
  const e = east < west ? east + 360 : east;
  const ring = [
    [west, south],
    [e, south],
    [e, north],
    [west, north],
    [west, south],
  ];
  return { type: "Polygon", coordinates: [ring] };
}

const REGION_NAMES = (key: RegionKey) => presetFor(key).name;

/** Warnings for a cell set: small area, cells outside the covered regions, or spanning regions. */
export function areaWarnings(cells: string[]): string[] {
  const warnings: string[] = [];
  const area = cellsAreaKm2(cells);
  if (area < MIN_AREA_KM2)
    warnings.push(
      `This area is about ${formatKm(area)} km^2, under ${MIN_AREA_KM2} km^2. Monthly fire counts this small are noisy; treat the anomalies with caution.`,
    );
  const { region, outside, mixed } = regionOfCells(cells);
  if (mixed) {
    warnings.push(
      "This area spans more than one covered region. The series API rejects mixed areas: keep the area inside one region.",
    );
  }
  if (region === null) {
    warnings.push(
      `This area is outside the three covered regions (${coveredNames()}). The series API rejects it: pick an area inside one of them.`,
    );
  } else if (outside > 0) {
    warnings.push(
      `${outside} of ${cells.length} cells fall outside ${REGION_NAMES(region)}. Those cells have no data and are left out of the totals.`,
    );
  }
  return warnings;
}

function coveredNames(): string {
  return REGION_KEYS.map(REGION_NAMES).join(", ");
}

/** Convert a drawn, typed or searched polygon to an area source with its warnings. */
export function cellsSource(
  label: string | ((cells: string[]) => string),
  geometry: PolygonGeometry,
): Result<AreaSource> {
  let cells: string[];
  try {
    cells = polygonToCellsR6(geometry);
  } catch {
    return { ok: false, error: "Could not convert this shape to map cells. Try a simpler shape." };
  }
  if (cells.length === 0)
    return { ok: false, error: "This area is too small to contain any map cell (about 36 km^2 each). Make it larger." };
  if (cells.length > MAX_CELLS)
    return { ok: false, error: `This area has ${cells.length} cells, over the ${MAX_CELLS} limit. Make it smaller.` };
  const text = typeof label === "function" ? label(cells) : label;
  return { ok: true, value: { kind: "cells", label: text, cells, warnings: areaWarnings(cells) } };
}

/** Attach the period to an area source to get what the dashboard consumes. */
export function toSelection(source: AreaSource, period: Period): AreaSelection {
  const base = { start: period.start, end: period.end, baseline: [...period.baseline] as [number, number] };
  if (source.kind === "preset")
    return { label: presetFor(source.key).name, region: source.key, cells: [], warnings: [], ...base };
  return { label: source.label, region: null, cells: source.cells, warnings: source.warnings, ...base };
}

/** Label for a drawn shape, with its approximate area. */
export function shapeLabel(kind: string, cells: string[]): string {
  const name = kind === "rectangle" ? "Drawn rectangle" : "Drawn polygon";
  return `${name}, about ${formatKm(cellsAreaKm2(cells))} km^2`;
}

function formatKm(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);
}

/** Bounding box of a GeoJSON polygon as a Google Maps bounds literal. */
export function geometryBounds(geometry: PolygonGeometry): { west: number; south: number; east: number; north: number } {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys)
    for (const [lng, lat] of poly[0]) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  return { west, south, east, north };
}
