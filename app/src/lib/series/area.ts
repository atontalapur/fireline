// Turns a validated SeriesRequest into the region to query and the cells of the area.
import type { RegionKey, SeriesRequest } from "@/lib/contracts";
import { polygonToCellsR6, presetFor, regionOfCell } from "@/lib/geo";

/** Error with an HTTP status, raised for bad input (400), missing data (404) or an upstream failure (502/503). */
export class SeriesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "SeriesError";
  }
}

export type ResolvedArea = {
  region: RegionKey;
  /** Cells to filter monthly/hotspots rows by; null for a whole-region request. */
  cells: string[] | null;
  /** Cells that make up the area, for meta.area_km2 and cell_count. */
  areaCells: string[];
  warnings: string[];
};

const regionCellsCache = new Map<RegionKey, string[]>();

/** Every res-6 cell whose center is inside the region polygon (cached per process). */
export function regionCells(region: RegionKey): string[] {
  let cells = regionCellsCache.get(region);
  if (!cells) {
    cells = polygonToCellsR6(presetFor(region).geometry).sort();
    regionCellsCache.set(region, cells);
  }
  return cells;
}

export function resolveArea(req: Pick<SeriesRequest, "cells" | "region">): ResolvedArea {
  if (req.region) {
    return { region: req.region, cells: null, areaCells: regionCells(req.region), warnings: [] };
  }
  const unique = [...new Set(req.cells ?? [])];
  if (unique.length === 0) throw new SeriesError("cells is empty");

  const byRegion = new Map<RegionKey, string[]>();
  let outside = 0;
  for (const c of unique) {
    const r = regionOfCell(c);
    if (!r) {
      outside++;
      continue;
    }
    const list = byRegion.get(r);
    if (list) list.push(c);
    else byRegion.set(r, [c]);
  }
  if (byRegion.size === 0) throw new SeriesError("cells are outside every covered region");
  if (byRegion.size > 1)
    throw new SeriesError(`cells span several regions (${[...byRegion.keys()].join(", ")}); pick one region`);

  const [[region, inside]] = [...byRegion.entries()];
  const warnings: string[] = [];
  if (outside > 0)
    warnings.push(`${outside} of ${unique.length} cells are outside the ${presetFor(region).name} region and were left out.`);
  return { region, cells: inside, areaCells: inside, warnings };
}
