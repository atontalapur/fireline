// Request/response shapes for POST /api/cells (monthly hex map layer, #27).
import { z } from "zod";
import { H3CellR6, MAX_CELLS, RegionKey } from "@/lib/contracts";

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

export const CellsRequest = z
  .object({
    region: RegionKey.nullable().default(null),
    cells: z.array(H3CellR6).min(1).max(MAX_CELLS).nullable().default(null),
    month: YearMonth,
  })
  .refine((r) => (r.cells === null) !== (r.region === null), {
    message: "exactly one of cells and region must be set",
  });
export type CellsRequest = z.infer<typeof CellsRequest>;

export type CellsResponse = {
  month: string; // YYYY-MM
  cells: { h3: string; harmonized: number }[]; // cells with no row had no fire and are omitted
  max: number; // largest harmonized value in `cells`, 0 when empty
  valid_days: number | null; // region-month days with satellite data; 0 or null = no data, not zero fire
};
