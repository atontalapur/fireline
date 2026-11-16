// The four Fireline tools, mirrored from app/src/lib/fire-tools/index.ts (not imported: this
// package builds on its own). Each tool forwards its input to POST /api/tools/<name>.
//
// MCP clients need a JSON Schema of type "object" for every tool input, so the two union inputs
// in the app (resolve_area, compare_to_baseline) are flattened into one object here and the
// "exactly one of" rule is checked in the handler before the request goes out.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, type FirelineClient } from "./client.js";

export const REGION_KEYS = ["pantanal", "w_canada", "punjab"] as const;
export const MAX_CELLS = 50_000;
/** Cells listed in resolve_area text output; more than this and the text gives a count only. */
export const MAX_CELLS_IN_TEXT = 3_000;
/** Months shown in get_series text output unless `full: true`. */
export const RECENT_MONTHS = 24;

const YearMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM")
  .describe("Month as YYYY-MM, e.g. '2024-09'");
const Cells = z
  .array(z.string())
  .max(MAX_CELLS)
  .describe(
    "H3 resolution-6 cell ids (hex strings) from resolve_area. Use either cells or region, not both.",
  );
const Region = z
  .enum(REGION_KEYS)
  .describe(
    "Preset region key: 'pantanal' (Brazilian Pantanal), 'w_canada' (Western Canada: British Columbia + Alberta), 'punjab' (Indian Punjab). Use either region or cells, not both.",
  );
const Polygon = z
  .object({
    type: z.enum(["Polygon", "MultiPolygon"]),
    coordinates: z.array(z.any()).describe("GeoJSON coordinates, [lng, lat] order"),
  })
  .describe("GeoJSON Polygon or MultiPolygon geometry, coordinates in [lng, lat] order");

const COVERAGE =
  "Fireline covers three regions only: the Brazilian Pantanal (preset 'pantanal'), Western Canada = British Columbia + Alberta ('w_canada') and Indian Punjab ('punjab'). Areas outside them return an error.";
const UNITS =
  "Values are MODIS-equivalent fire cell-days per month: one fire cell-day is one H3 resolution-8 cell (about 0.74 km2) with at least one satellite fire detection on one local day. MODIS (Terra + Aqua) is used from 2000-11; from 2020-01 VIIRS is scaled to MODIS-equivalent with a per-region, per-calendar-month ratio, so the record is comparable across 2000 to today.";

export const ResolveAreaInput = z.object({
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Place or preset name, e.g. 'Pantanal', 'Cuiaba', 'Western Canada', 'Punjab'"),
  polygon: Polygon.optional(),
});

export const GetSeriesInput = z.object({
  cells: Cells.optional(),
  region: Region.optional(),
  start: YearMonth.optional().describe("First month, YYYY-MM. Default: start of the record (2000-11)"),
  end: YearMonth.optional().describe("Last month, YYYY-MM. Default: latest available month"),
  baseline: z
    .tuple([z.number().int(), z.number().int()])
    .optional()
    .describe("Baseline years [first, last], inclusive. Default [2003, 2022]"),
  full: z
    .boolean()
    .optional()
    .describe(
      `Set true to list every month in the text output. Default false: the text lists the last ${RECENT_MONTHS} months plus annual totals; narrow start/end to see a specific period.`,
    ),
});

export const CompareToBaselineInput = z.object({
  cells: Cells.optional(),
  region: Region.optional(),
  month: YearMonth.optional().describe("Month to compare, YYYY-MM. Give month or year, not both"),
  year: z.number().int().optional().describe("Year to compare, e.g. 2020. Give month or year, not both"),
});

export const ExportCsvInput = z.object({
  cells: Cells.optional(),
  region: Region.optional(),
  start: YearMonth.optional(),
  end: YearMonth.optional(),
});

type ToolText = { text: string; structured?: Record<string, unknown> };

function ok({ text, structured }: ToolText): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireArea(input: { cells?: string[]; region?: string }): string | null {
  const hasCells = input.cells !== undefined;
  const hasRegion = input.region !== undefined;
  if (hasCells === hasRegion) {
    return "Give exactly one of 'region' (a preset key) or 'cells' (from resolve_area).";
  }
  return null;
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------- text formatting ----------

type Month = Record<string, unknown> & { month?: string };

const MONTH_FIELDS = [
  "month",
  "harmonized",
  "lo",
  "hi",
  "baseline_median",
  "z",
  "percentile",
  "source",
  "provisional",
  "valid_days",
] as const;

function compactMonth(m: Month): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MONTH_FIELDS) if (k in m) out[k] = m[k];
  return out;
}

/** Compact text view of a get_series response: summary, meta, annual totals, recent months. */
export function summarizeSeries(output: unknown, full = false): string {
  const data = asRecord(output);
  if (!data) return JSON.stringify(output);
  const months = Array.isArray(data.months) ? (data.months as Month[]) : [];
  const shown = full ? months : months.slice(-RECENT_MONTHS);
  const view = {
    units: "MODIS-equivalent fire cell-days per month",
    range:
      months.length > 0
        ? { first: months[0]?.month, last: months[months.length - 1]?.month, months: months.length }
        : { months: 0 },
    summary: data.summary,
    meta: data.meta,
    months_shown: full
      ? "all"
      : `last ${shown.length} of ${months.length}; call again with full: true or a narrower start/end for other months`,
    months: shown.map(compactMonth),
  };
  return JSON.stringify(view);
}

/** Text view of a resolve_area response; very large cell lists are summarized, not listed. */
export function summarizeArea(output: unknown): string {
  const data = asRecord(output);
  if (!data) return JSON.stringify(output);
  const cells = Array.isArray(data.cells) ? (data.cells as unknown[]) : [];
  const view: Record<string, unknown> = { ...data, cell_count: cells.length };
  if (cells.length > MAX_CELLS_IN_TEXT) {
    view.cells = `${cells.length} cells, too many to list here`;
    const hint = data.region
      ? `Use region '${String(data.region)}' in the other tools.`
      : "This area is too large to pass as cells; use a preset region or a smaller polygon.";
    view.note = hint;
  } else if (data.region) {
    view.note = `Preset area: pass region '${String(data.region)}' to the other tools.`;
  } else {
    view.note = "Pass these cells to get_series, compare_to_baseline or export_csv.";
  }
  return JSON.stringify(view);
}

function absoluteUrl(url: unknown, baseUrl: string): unknown {
  if (typeof url !== "string") return url;
  try {
    return new URL(url, `${baseUrl}/`).toString();
  } catch {
    return url;
  }
}

// ---------- registration ----------

export function registerFireTools(server: McpServer, client: FirelineClient): void {
  async function forward(
    name: string,
    body: unknown,
    format: (output: unknown) => ToolText,
  ): Promise<CallToolResult> {
    try {
      const output = await client.callTool(name, body);
      return ok(format(output));
    } catch (err) {
      return toolError(errorMessage(err));
    }
  }

  server.registerTool(
    "resolve_area",
    {
      title: "Resolve area",
      description: [
        "Turn a place name, preset region name or GeoJSON polygon into the area used by the other tools (H3 resolution-6 cells, area in km2, and the preset key if it is a preset).",
        "Give exactly one of name or polygon.",
        COVERAGE,
        "For a whole preset region you can skip this tool and pass region directly to the other tools.",
      ].join(" "),
      inputSchema: ResolveAreaInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const hasName = input.name !== undefined;
      const hasPolygon = input.polygon !== undefined;
      if (hasName === hasPolygon) return toolError("Give exactly one of 'name' or 'polygon'.");
      const body = hasName ? { name: input.name } : { polygon: input.polygon };
      return forward("resolve_area", body, (output) => {
        // Large cell lists stay out of structuredContent too, so a client that shows it to the model is not swamped.
        const cells = asRecord(output)?.cells;
        const small = !Array.isArray(cells) || cells.length <= MAX_CELLS_IN_TEXT;
        return { text: summarizeArea(output), structured: small ? asRecord(output) : undefined };
      });
    },
  );

  server.registerTool(
    "get_series",
    {
      title: "Get monthly fire series",
      description: [
        "Monthly harmonized fire history for an area, with uncertainty band (lo, hi), baseline median, z-score and percentile per month, plus a summary: the latest month vs its baseline, peak month of year, peak year and annual totals with ranks.",
        UNITS,
        COVERAGE,
        "Give exactly one of region (preset key) or cells (from resolve_area). Months are YYYY-MM.",
        `The text output lists annual totals and the last ${RECENT_MONTHS} months; set full: true, or narrow start/end, to see other months.`,
        "provisional = recent data that may still change; partial = month with missing satellite days.",
      ].join(" "),
      inputSchema: GetSeriesInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const areaError = requireArea(input);
      if (areaError) return toolError(areaError);
      const { full, ...rest } = input;
      return forward("get_series", dropUndefined(rest), (output) => ({
        text: summarizeSeries(output, full === true),
        // The full series (every month) only on request, matching the text output.
        structured: full === true ? asRecord(output) : undefined,
      }));
    },
  );

  server.registerTool(
    "compare_to_baseline",
    {
      title: "Compare to baseline",
      description: [
        "Compare one month (YYYY-MM) or one calendar year to the area's historical baseline: value, baseline median, ratio to median, z-score, percentile, and rank (a month is ranked among the same calendar month in every year; a year among all years; 'of' is how many were ranked). A partial month (some days without data, such as the current month) gets no ratio, z-score, percentile or rank.",
        UNITS,
        COVERAGE,
        "Give exactly one of region or cells, and exactly one of month or year.",
      ].join(" "),
      inputSchema: CompareToBaselineInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const areaError = requireArea(input);
      if (areaError) return toolError(areaError);
      if ((input.month === undefined) === (input.year === undefined)) {
        return toolError("Give exactly one of 'month' (YYYY-MM) or 'year'.");
      }
      return forward("compare_to_baseline", dropUndefined(input), (output) => ({
        text: JSON.stringify(output),
        structured: asRecord(output),
      }));
    },
  );

  server.registerTool(
    "export_csv",
    {
      title: "Export CSV",
      description: [
        "Get a link to download the monthly analytics CSV (harmonized cell-days, raw MODIS and VIIRS counts, bands, baselines) for an area. Returns url and HTTP method; when method is POST, send body as JSON to url.",
        COVERAGE,
        "Give exactly one of region or cells. Optional start/end as YYYY-MM.",
      ].join(" "),
      inputSchema: ExportCsvInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const areaError = requireArea(input);
      if (areaError) return toolError(areaError);
      return forward("export_csv", dropUndefined(input), (output) => {
        const data = asRecord(output);
        const fixed = data ? { ...data, url: absoluteUrl(data.url, client.baseUrl) } : undefined;
        return { text: JSON.stringify(fixed ?? output), structured: fixed };
      });
    },
  );
}
