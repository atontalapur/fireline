// Area helpers shared by the area picker (#17), the series API (#18) and the AI tools (#24).
// All GeoJSON here is [lng, lat]; h3-js is called with isGeoJson = true.
import { cellArea, cellToLatLng, polygonToCells } from "h3-js";
import regionsGeojson from "@/lib/regions.geojson.json";
import { REGION_KEYS, type RegionKey } from "@/lib/contracts";

export const H3_RES = 6;

type Ring = number[][];
export type PolygonGeometry =
  | { type: "Polygon"; coordinates: Ring[] }
  | { type: "MultiPolygon"; coordinates: Ring[][] };

type RegionFeature = {
  type: "Feature";
  properties: { region: string; name: string; source: string; license: string };
  geometry: PolygonGeometry;
};

export type RegionPreset = {
  key: RegionKey;
  name: string;
  geometry: PolygonGeometry;
  bbox: [number, number, number, number]; // west, south, east, north
};

function bboxOf(geometry: PolygonGeometry): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polygonsOf(geometry))
    for (const [lng, lat] of poly[0]) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

function polygonsOf(geometry: PolygonGeometry): Ring[][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

export const REGION_PRESETS: RegionPreset[] = (
  (regionsGeojson as unknown as { features: RegionFeature[] }).features
)
  .filter((f): f is RegionFeature => (REGION_KEYS as readonly string[]).includes(f.properties.region))
  .map((f) => ({
    key: f.properties.region as RegionKey,
    name: f.properties.name,
    geometry: f.geometry,
    bbox: bboxOf(f.geometry),
  }));

export function presetFor(key: RegionKey): RegionPreset {
  const p = REGION_PRESETS.find((r) => r.key === key);
  if (!p) throw new Error(`unknown region ${key}`);
  return p;
}

/** H3 res-6 cells whose centers fall inside the polygon. */
export function polygonToCellsR6(geometry: PolygonGeometry): string[] {
  const out = new Set<string>();
  for (const poly of polygonsOf(geometry))
    for (const c of polygonToCells(poly, H3_RES, true)) out.add(c);
  return [...out];
}

/** Approximate circle as a GeoJSON polygon. */
export function circlePolygon(lat: number, lng: number, radiusKm: number, steps = 64): PolygonGeometry {
  const R = 6371.0088;
  const d = radiusKm / R;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const ring: Ring = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (2 * Math.PI * (i % steps)) / steps;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 =
      lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([(((lng2 * 180) / Math.PI + 540) % 360) - 180, (lat2 * 180) / Math.PI]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function cellsAreaKm2(cells: string[]): number {
  let total = 0;
  for (const c of cells) total += cellArea(c, "km2");
  return Math.round(total * 10) / 10;
}

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(lng: number, lat: number, geometry: PolygonGeometry): boolean {
  return polygonsOf(geometry).some(
    (poly) => pointInRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => pointInRing(lng, lat, hole)),
  );
}

/** Region whose polygon contains the cell center, or null. */
export function regionOfCell(cell: string): RegionKey | null {
  const [lat, lng] = cellToLatLng(cell);
  for (const p of REGION_PRESETS) {
    const [w, s, e, n] = p.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    if (pointInGeometry(lng, lat, p.geometry)) return p.key;
  }
  return null;
}

/** Classify a cell set: the single region it sits in, how many cells fall outside, and whether it spans regions. */
export function regionOfCells(cells: string[]): { region: RegionKey | null; outside: number; mixed: boolean } {
  const counts = new Map<RegionKey, number>();
  let outside = 0;
  for (const c of cells) {
    const r = regionOfCell(c);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
    else outside++;
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { region: ranked[0]?.[0] ?? null, outside, mixed: ranked.length > 1 };
}
