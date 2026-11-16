// Area resolution and request building for the fire tools (#24).
import { cellArea, latLngToCell } from "h3-js";
import {
  DEFAULT_BASELINE,
  DEFAULT_START,
  MAX_CELLS,
  REGION_KEYS,
  type RegionKey,
  type SeriesRequest,
} from "@/lib/contracts";
import { H3_RES, REGION_PRESETS, cellsAreaKm2, polygonToCellsR6, presetFor, regionOfCell, regionOfCells, type PolygonGeometry } from "@/lib/geo";
import { SeriesError, regionCells, resolveArea } from "@/lib/series/area";
import { recordRange } from "@/lib/series/compute";
import { parseSeriesRequest } from "@/lib/series/request";
import type { ResolveAreaOutput } from "@/lib/fire-tools";

const ALIASES: Record<string, RegionKey> = {
  pantanal: "pantanal",
  "brazilian pantanal": "pantanal",
  "pantanal brazil": "pantanal",
  "western canada": "w_canada",
  "w canada": "w_canada",
  w_canada: "w_canada",
  bc: "w_canada",
  "b.c.": "w_canada",
  "british columbia": "w_canada",
  alberta: "w_canada",
  "bc + alberta": "w_canada",
  "bc and alberta": "w_canada",
  "western canada (bc + alberta)": "w_canada",
  punjab: "punjab",
  "indian punjab": "punjab",
  "punjab india": "punjab",
};

/** Preset key for a preset name or key (case-insensitive), else null. */
export function presetKeyFor(name: string): RegionKey | null {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/,/g, "");
  if ((REGION_KEYS as readonly string[]).includes(n)) return n as RegionKey;
  return ALIASES[n] ?? REGION_PRESETS.find((p) => p.name.toLowerCase() === n)?.key ?? null;
}

function regionNames(): string {
  return REGION_PRESETS.map((p) => p.name).join(", ");
}

// Rough res-6 cell area, to refuse huge areas before enumerating cells.
const R6_KM2 = cellArea(latLngToCell(0, 0, H3_RES), "km2");
// ~0.5 s of polygonToCells; larger areas are refused before enumeration.
const MAX_ENUMERATE = 250_000;

function bboxAreaKm2(w: number, s: number, e: number, n: number): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const width = (((e - w) % 360) + 360) % 360 || 360;
  return R * R * width * rad * Math.abs(Math.sin(n * rad) - Math.sin(s * rad));
}

function cellsOfGeometry(geometry: PolygonGeometry): string[] {
  try {
    return polygonToCellsR6(geometry);
  } catch (err) {
    throw new SeriesError(`invalid polygon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Output for an arbitrary cell set, with coverage warnings; trims to covered regions past MAX_CELLS. */
function cellsOutput(label: string, cells: string[]): ResolveAreaOutput {
  if (cells.length === 0) throw new SeriesError("the area is smaller than one H3 res-6 cell; draw a larger area");
  const warnings: string[] = [];
  if (cells.length > MAX_CELLS) {
    const inside = cells.filter((c) => regionOfCell(c) !== null);
    if (inside.length === 0 || inside.length > MAX_CELLS)
      throw new SeriesError(`the area has ${cells.length} cells; the limit is ${MAX_CELLS}`);
    warnings.push(`The area was trimmed to the ${inside.length} cells inside the covered regions.`);
    cells = inside;
  }
  const { region, outside, mixed } = regionOfCells(cells);
  if (region === null) warnings.push(`The area is outside the covered regions (${regionNames()}); there is no data for it.`);
  else if (outside > 0)
    warnings.push(`${outside} of ${cells.length} cells are outside the covered regions (${regionNames()}); they have no data.`);
  if (mixed) warnings.push("The area spans more than one covered region; series requests need cells in one region.");
  return { label, region: null, cells: [...cells].sort(), area_km2: cellsAreaKm2(cells), warnings };
}

export function presetOutput(key: RegionKey, asked?: string): ResolveAreaOutput {
  const preset = presetFor(key);
  const warnings: string[] = [];
  if (asked && /alberta|british columbia|^b\.?c\.?$/i.test(asked.trim()))
    warnings.push(`"${asked}" maps to the ${preset.name} preset, which covers both provinces.`);
  // Presets return no cell list (it can run to tens of thousands); pass `region` to the other tools.
  return { label: preset.name, region: key, cells: [], area_km2: cellsAreaKm2(regionCells(key)), warnings };
}

type GeocodeResult = {
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
    viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
    bounds?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
  };
};

export async function geocodeArea(name: string): Promise<ResolveAreaOutput> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new SeriesError(`"${name}" is not a preset (${regionNames()}) and geocoding is not configured`, 503);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name)}&key=${encodeURIComponent(key)}`;
  let body: { status: string; results?: GeocodeResult[]; error_message?: string };
  try {
    const res = await fetch(url);
    body = await res.json();
  } catch (err) {
    throw new SeriesError(`geocoding failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (body.status === "ZERO_RESULTS" || (body.status === "OK" && !body.results?.length))
    throw new SeriesError(`no place found for "${name}"`, 404);
  if (body.status !== "OK") throw new SeriesError(`geocoding failed: ${body.status}${body.error_message ? ` (${body.error_message})` : ""}`, 502);

  const top = body.results![0];
  const box = top.geometry.viewport ?? top.geometry.bounds;
  const { lat, lng } = top.geometry.location;
  const centerCell = latLngToCell(lat, lng, H3_RES);
  if (!box) return cellsOutput(top.formatted_address, [centerCell]);
  const { northeast: ne, southwest: sw } = box;
  if (bboxAreaKm2(sw.lng, sw.lat, ne.lng, ne.lat) / R6_KM2 > MAX_ENUMERATE)
    throw new SeriesError(`"${top.formatted_address}" is too large; pick a smaller area or a preset`);
  const ring = [
    [sw.lng, sw.lat],
    [ne.lng, sw.lat],
    [ne.lng, ne.lat],
    [sw.lng, ne.lat],
    [sw.lng, sw.lat],
  ];
  // A viewport smaller than one res-6 cell (a town) falls back to the cell at the location.
  const cells = cellsOfGeometry({ type: "Polygon", coordinates: [ring] });
  return cellsOutput(top.formatted_address, cells.length ? cells : [centerCell]);
}

export function polygonArea(geometry: PolygonGeometry): ResolveAreaOutput {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let cellsEstimate = 0;
  for (const poly of polys) {
    const outer = poly?.[0];
    if (!Array.isArray(outer) || outer.length < 3) throw new SeriesError("invalid polygon: each polygon needs an outer ring");
    const lngs = outer.map((p) => p[0]);
    const lats = outer.map((p) => p[1]);
    cellsEstimate += bboxAreaKm2(Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)) / R6_KM2;
  }
  if (cellsEstimate > MAX_ENUMERATE) throw new SeriesError("the polygon is too large; draw a smaller area");
  return cellsOutput("Drawn area", cellsOfGeometry(geometry));
}

type AreaInput = { cells?: string[]; region?: string };

/** Region key from a preset key or name; throws 400 for anything else. */
function regionKey(region: string): RegionKey {
  const key = presetKeyFor(region);
  if (!key) throw new SeriesError(`unknown region "${region}"; use one of ${REGION_KEYS.join(", ")}`);
  return key;
}

/**
 * A validated SeriesRequest from tool input. Cells win over region when both are given and
 * cells is non-empty. Missing start/end default to the whole record.
 */
export async function seriesRequestFor(
  input: AreaInput & { start?: string; end?: string; baseline?: [number, number] },
): Promise<SeriesRequest> {
  const cells = input.cells?.length ? input.cells : null;
  if (!cells && !input.region) throw new SeriesError("pass region or cells");
  const region = cells ? null : regionKey(input.region!);
  let end = input.end;
  if (!end) {
    const dataRegion = region ?? resolveArea({ cells, region: null }).region;
    const range = await recordRange(dataRegion);
    if (!range) throw new SeriesError(`no data for region ${dataRegion}`, 404);
    end = range.end;
  }
  return parseSeriesRequest({
    cells,
    region,
    start: input.start ?? DEFAULT_START,
    end,
    baseline: input.baseline ?? DEFAULT_BASELINE,
  });
}
