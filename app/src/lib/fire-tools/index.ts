// Fire-history tools shared by the AI analyst (#25) and the MCP server (#26, over HTTP at
// POST /api/tools/<name>). Pure TypeScript + Zod, no framework imports.
//
// Names, input schemas and output types are the agreed interface. Errors are SeriesError (from
// @/lib/series/area) carrying an HTTP status: 400 bad input, 404 no data or no place found,
// 502/503 geocoding failures.
import { z } from "zod";
import { DEFAULT_BASELINE, type SeriesResponse } from "@/lib/contracts";
import type { PolygonGeometry } from "@/lib/geo";
import { SeriesError } from "@/lib/series/area";
import { computeSeries, daysInMonth, median, round } from "@/lib/series/compute";
import { searchParamsFor } from "@/lib/csv/request";
import { geocodeArea, polygonArea, presetKeyFor, presetOutput, seriesRequestFor } from "@/lib/fire-tools/area";

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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const resolveArea: FireTool<typeof ResolveAreaInput, ResolveAreaOutput> = {
  name: "resolve_area",
  description:
    "Turn a place name, preset region or polygon into H3 res-6 cells. Presets (Pantanal, Western Canada / BC / Alberta, Punjab) " +
    "return `region` and an empty cell list: pass `region` to the other tools. Other places are geocoded; pass their `cells`.",
  inputSchema: ResolveAreaInput,
  execute: async (input) => {
    if ("polygon" in input) return polygonArea(input.polygon as unknown as PolygonGeometry);
    const key = presetKeyFor(input.name);
    return key ? presetOutput(key, input.name) : geocodeArea(input.name);
  },
};

export const getSeries: FireTool<typeof GetSeriesInput, GetSeriesOutput> = {
  name: "get_series",
  description:
    "Monthly harmonized fire cell-days with baselines and anomalies for an area (`region` or `cells`). " +
    "start/end are YYYY-MM and default to the whole record; baseline defaults to [2003, 2022].",
  inputSchema: GetSeriesInput,
  execute: async (input) => computeSeries(await seriesRequestFor(input)),
};

export const compareToBaseline: FireTool<typeof CompareToBaselineInput, CompareToBaselineOutput> = {
  name: "compare_to_baseline",
  description:
    "Compare one month (YYYY-MM) or one year to the area's 2003-2022 baseline: value, median, ratio, robust z, percentile and rank.",
  inputSchema: CompareToBaselineInput,
  execute: async (input) => {
    const series = await computeSeries(await seriesRequestFor({ cells: input.cells, region: input.region }));
    const areaWarnings = series.meta.warnings.filter((w) => w.includes("cells are outside"));
    return "month" in input ? compareMonth(series, input.month, areaWarnings) : compareYear(series, input.year, areaWarnings);
  },
};

function compareMonth(series: SeriesResponse, month: string, warnings: string[]): CompareToBaselineOutput {
  const m = series.months.find((x) => x.month === month);
  if (!m) {
    const first = series.months[0]?.month;
    const last = series.months.at(-1)?.month;
    throw new SeriesError(`${month} is outside the record ${first} to ${last}`);
  }
  const moy = Number(month.slice(5, 7));
  const same = series.months.filter((x) => Number(x.month.slice(5, 7)) === moy && x.harmonized !== null);
  const value = m.harmonized;
  const out = [...warnings];
  if (m.valid_days === 0) out.push(`${month}: no satellite data (valid_days = 0).`);
  else if (m.valid_days < daysInMonth(month)) out.push(`${month} is partial: ${m.valid_days} of ${daysInMonth(month)} days have data.`);
  if (m.provisional) out.push(`${month} is provisional (NRT or incomplete).`);
  const madWarning = series.meta.warnings.find((w) => w.startsWith(`Baseline MAD is 0 for ${MONTH_NAMES[moy - 1]};`));
  if (madWarning) out.push(madWarning);
  return {
    period: month,
    value,
    median: m.baseline_median,
    ratio: value !== null && m.baseline_median ? round(value / m.baseline_median, 2) : null,
    z: m.z,
    percentile: m.percentile,
    rank: value === null ? null : 1 + same.filter((x) => (x.harmonized as number) > value).length,
    of: same.length,
    provisional: m.provisional,
    warnings: out,
  };
}

function compareYear(series: SeriesResponse, year: number, warnings: string[]): CompareToBaselineOutput {
  const a = series.summary.annual.find((x) => x.year === year);
  if (!a) throw new SeriesError(`${year} is outside the record`);
  const complete = series.summary.annual.filter((x) => x.complete);
  // Baseline: complete years in the default baseline window.
  const [b0, b1] = DEFAULT_BASELINE;
  const b = complete.filter((x) => x.year >= b0 && x.year <= b1).map((x) => x.total);
  const out = [...warnings];
  let med: number | null = null;
  let z: number | null = null;
  let pct: number | null = null;
  if (b.length) {
    med = median([...b].sort((x, y) => x - y));
    const mad = median(b.map((v) => Math.abs(v - (med as number))).sort((x, y) => x - y));
    if (mad > 0) z = (a.total - med) / (1.4826 * mad);
    pct = (100 * (b.filter((v) => v < a.total).length + 0.5 * b.filter((v) => v === a.total).length)) / b.length;
  }
  if (!a.complete) out.push(`${year} is incomplete (missing months or months without data); it is not ranked.`);
  const months = series.months.filter((m) => m.month.startsWith(`${year}-`));
  const provisional = months.some((m) => m.provisional);
  if (provisional) out.push(`${year} includes provisional months.`);
  return {
    period: String(year),
    value: a.total,
    median: round(med),
    ratio: med ? round(a.total / med, 2) : null,
    z: round(z),
    percentile: round(pct, 1),
    rank: a.rank,
    of: complete.length,
    provisional,
    warnings: out,
  };
}

export const exportCsv: FireTool<typeof ExportCsvInput, ExportCsvOutput> = {
  name: "export_csv",
  description: "Link to download the monthly analytics CSV for an area (`region` or `cells`, optional start/end YYYY-MM).",
  inputSchema: ExportCsvInput,
  execute: async (input) => {
    const req = await seriesRequestFor(input);
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
    const path = `${base}/api/analytics.csv`;
    const url = `${path}?${searchParamsFor(req)}`;
    // Long cell lists do not fit in a URL; hand back a POST instead.
    if (url.length > 8000) return { url: path, method: "POST", body: req };
    return { url, method: "GET" };
  },
};

export const fireTools = {
  resolve_area: resolveArea,
  get_series: getSeries,
  compare_to_baseline: compareToBaseline,
  export_csv: exportCsv,
} as const;
export type FireToolName = keyof typeof fireTools;
