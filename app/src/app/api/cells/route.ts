// POST /api/cells: per-cell harmonized fire cell-days for one month (#27).
import { regionOfCell, regionOfCells } from "@/lib/geo";
import { CellsRequest, type CellsResponse } from "@/lib/map/cells-request";
import { queryMonthCells, queryMonthValidDays } from "@/lib/map/cells-db";

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CellsRequest.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { month, cells } = parsed.data;

  let region = parsed.data.region;
  if (cells) {
    const r = regionOfCells(cells);
    if (r.mixed) return Response.json({ error: "cells span more than one region" }, { status: 400 });
    region = r.region;
  }
  if (!region) return Response.json({ error: "cells are outside every supported region" }, { status: 400 });
  // Cells outside every region have no data; drop them, as /api/series does.
  const inside = cells ? cells.filter((c) => regionOfCell(c) === region) : null;

  try {
    const [rows, valid_days] = await Promise.all([
      queryMonthCells(region, month, inside),
      queryMonthValidDays(region, month),
    ]);
    const max = rows.reduce((m, c) => (c.harmonized > m ? c.harmonized : m), 0);
    const body: CellsResponse = { month, cells: rows, max, valid_days };
    return Response.json(body);
  } catch (err) {
    console.error("/api/cells query failed", err);
    return Response.json({ error: "query failed" }, { status: 500 });
  }
}
