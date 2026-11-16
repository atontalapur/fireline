// Fire-history tools shared by the AI analyst (#25) and the MCP server (#26, over HTTP at
// POST /api/tools/<name>). Pure TypeScript + Zod, no framework imports.
//
// Stub interface: #24 replaces the execute bodies. Names, input schemas and output types are the
// agreed interface; change them only in #24.
import { z } from "zod";
import type { SeriesResponse } from "@/lib/contracts";

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Cells = z.array(z.string()).max(50_000);
const Polygon = z.object({
  type: z.enum(["Polygon", "MultiPolygon"]),
  coordinates: z.array(z.any()),
});

export const ResolveAreaInput = z.union([
  z.object({ name: z.string().min(1).describe("Place or preset name, e.g. 'Pantanal' or 'Cuiaba'") }),
  z.object({ polygon: Polygon.describe("GeoJSON Polygon or MultiPolygon, [lng, lat]") }),
]);
export type ResolveAreaOutput = {
  label: string;
  region: string | null; // preset key when the area is a preset
  cells: string[];
  area_km2: number;
  warnings: string[];
};

export const GetSeriesInput = z.object({
  cells: Cells.optional(),
  region: z.string().optional().describe("Preset key: pantanal, w_canada, punjab"),
  start: YearMonth.optional(),
  end: YearMonth.optional(),
  baseline: z.tuple([z.number().int(), z.number().int()]).optional(),
});
export type GetSeriesOutput = SeriesResponse;

export const CompareToBaselineInput = z.union([
  z.object({ cells: Cells.optional(), region: z.string().optional(), month: YearMonth }),
  z.object({ cells: Cells.optional(), region: z.string().optional(), year: z.number().int() }),
]);
export type CompareToBaselineOutput = {
  period: string; // YYYY-MM or YYYY
  value: number | null;
  median: number | null;
  ratio: number | null;
  z: number | null;
  percentile: number | null;
  rank: number | null; // month: rank among the same calendar month in all years; year: annual rank
  of: number; // number of values ranked
  provisional: boolean;
  warnings: string[];
};

export const ExportCsvInput = z.object({
  cells: Cells.optional(),
  region: z.string().optional(),
  start: YearMonth.optional(),
  end: YearMonth.optional(),
});
export type ExportCsvOutput = { url: string; method: "POST" | "GET"; body?: unknown };

export type FireTool<I extends z.ZodType, O> = {
  name: string;
  description: string;
  inputSchema: I;
  execute: (input: z.infer<I>) => Promise<O>;
};

const notImplemented = async (): Promise<never> => {
  throw new Error("fire-tools: not implemented yet (#24)");
};

export const resolveArea: FireTool<typeof ResolveAreaInput, ResolveAreaOutput> = {
  name: "resolve_area",
  description: "Turn a place name, preset region or polygon into H3 res-6 cells.",
  inputSchema: ResolveAreaInput,
  execute: notImplemented,
};

export const getSeries: FireTool<typeof GetSeriesInput, GetSeriesOutput> = {
  name: "get_series",
  description: "Monthly harmonized fire cell-days with baselines and anomalies for an area.",
  inputSchema: GetSeriesInput,
  execute: notImplemented,
};

export const compareToBaseline: FireTool<typeof CompareToBaselineInput, CompareToBaselineOutput> = {
  name: "compare_to_baseline",
  description: "Compare one month or one year to the area's historical baseline.",
  inputSchema: CompareToBaselineInput,
  execute: notImplemented,
};

export const exportCsv: FireTool<typeof ExportCsvInput, ExportCsvOutput> = {
  name: "export_csv",
  description: "Link to download the monthly analytics CSV for an area.",
  inputSchema: ExportCsvInput,
  execute: notImplemented,
};

export const fireTools = {
  resolve_area: resolveArea,
  get_series: getSeries,
  compare_to_baseline: compareToBaseline,
  export_csv: exportCsv,
} as const;
export type FireToolName = keyof typeof fireTools;
