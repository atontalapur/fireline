// The fire tools as the model sees them. Wraps lib/fire-tools so that:
// - areas are a short `area` string (current selection, preset key, or an id from resolve_area)
//   instead of cell lists the model would have to copy;
// - schemas are flat objects (Gemini function declarations want an object at the top level);
// - outputs are compact (no 300-month dumps) and every call is recorded in the trace.
import { tool } from "ai";
import { z } from "zod";
import { REGION_KEYS } from "@/lib/contracts";
import type { GetSeriesOutput } from "@/lib/fire-tools";
import { daysInMonth } from "@/lib/series/compute";
import type { FireToolSet } from "./example-answers";
import { displayInput } from "./format";
import { selectionArea } from "./selection";
import { summarizeCompare, summarizeExport, summarizeResolveArea, summarizeSeries } from "./summarize";
import type { ChatSelection, TraceEntry } from "./types";

const AREA_DESCRIPTION =
  "Which area to query. Omit it for the user's current selection. Otherwise a preset key " +
  `(${REGION_KEYS.join(", ")}) or an area_id returned by resolve_area.`;
const Area = z.string().max(64).optional().describe(AREA_DESCRIPTION);
const Ym = (what: string) => z.string().max(7).optional().describe(`${what} month, YYYY-MM`);

type AreaArgs = { region: string } | { cells: string[] };

export function compactSeries(s: GetSeriesOutput, windowed: boolean) {
  const rows = windowed ? s.months.slice(-60) : s.months.slice(-12);
  return {
    area_km2: s.meta.area_km2,
    cell_count: s.meta.cell_count,
    warnings: s.meta.warnings.slice(0, 10),
    current: s.summary.current,
    peak_month_of_year: s.summary.peak_month_of_year,
    peak_year: s.summary.peak_year,
    annual: s.summary.annual,
    months: rows.map((m) => {
      // Same rule as summary.current: a partial month isn't compared with a full-month baseline.
      const partial = m.valid_days > 0 && m.valid_days < daysInMonth(m.month);
      return {
        month: m.month,
        harmonized: m.harmonized,
        baseline_median: m.baseline_median,
        z: partial ? null : m.z,
        percentile: partial ? null : m.percentile,
        provisional: m.provisional,
        ...(partial ? { partial: true } : {}),
      };
    }),
    months_note: windowed
      ? s.months.length > rows.length
        ? "Only the last 60 months of the window are listed; narrow start/end for earlier ones."
        : undefined
      : "Only the last 12 months are listed; pass start and end to see others.",
  };
}

export function buildModelTools(opts: { selection: ChatSelection | null; tools: FireToolSet; trace: TraceEntry[] }) {
  const { selection, tools, trace } = opts;
  const areas = new Map<string, AreaArgs>();

  function resolveRef(area: string | undefined): AreaArgs {
    if (!area || area === "selection") {
      const sel = selectionArea(selection);
      if (sel) return sel;
      throw new Error(
        selection
          ? "The selected area is too large to query from the chat. Ask about a preset or a named place."
          : "No area is selected. Ask the user to pick one, or call resolve_area with a place name.",
      );
    }
    if ((REGION_KEYS as readonly string[]).includes(area)) return { region: area };
    const known = areas.get(area);
    if (known) return known;
    throw new Error(`Unknown area "${area}". Use a preset key or call resolve_area first.`);
  }

  /** Build the shared-tool input, run it, and record the call (including failures) in the trace. */
  async function traced<I extends object, O>(
    name: string,
    args: object,
    prepare: () => I,
    run: (input: I) => Promise<O>,
    summarize: (o: O) => string,
  ): Promise<O> {
    const entry: TraceEntry = { tool: name, input: displayInput(args), summary: "" };
    trace.push(entry); // push before awaiting so the trace keeps call order
    try {
      const input = prepare();
      entry.input = displayInput(input);
      const out = await run(input);
      entry.summary = summarize(out);
      return out;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      entry.summary = "failed";
      throw e;
    }
  }

  return {
    resolve_area: tool({
      description: `${tools.resolve_area.description} Returns an area_id to pass as \`area\` to the other tools.`,
      inputSchema: z.object({ name: z.string().min(1).max(200).describe("Place or preset name, e.g. 'Pantanal' or 'Cuiaba'") }),
      execute: async ({ name }) => {
        const out = await traced(
          "resolve_area",
          { name },
          () => ({ name }),
          (i) => tools.resolve_area.execute(i),
          summarizeResolveArea,
        );
        const id = `area_${areas.size + 1}`;
        areas.set(id, out.region ? { region: out.region } : { cells: out.cells });
        return { area_id: id, label: out.label, region: out.region, cell_count: out.cells.length, area_km2: out.area_km2, warnings: out.warnings };
      },
    }),

    get_series: tool({
      description:
        `${tools.get_series.description} Units: MODIS-equivalent fire cell-days. ` +
        "Returns the latest month vs its baseline, annual totals and ranks, the peak month of year, and monthly rows.",
      inputSchema: z.object({ area: Area, start: Ym("First"), end: Ym("Last") }),
      execute: async ({ area, start, end }) => {
        const out = await traced(
          "get_series",
          { area, start, end },
          () => tools.get_series.inputSchema.parse({ ...resolveRef(area), start, end }),
          (i) => tools.get_series.execute(i),
          summarizeSeries,
        );
        return compactSeries(out, Boolean(start || end));
      },
    }),

    compare_to_baseline: tool({
      description: `${tools.compare_to_baseline.description} Pass exactly one of month or year.`,
      inputSchema: z.object({
        area: Area,
        month: Ym("The"),
        year: z.number().int().optional().describe("Calendar year, e.g. 2024"),
      }),
      execute: async ({ area, month, year }) => {
        return traced(
          "compare_to_baseline",
          { area, month, year },
          () => {
            if ((month === undefined) === (year === undefined)) throw new Error("Pass exactly one of month or year.");
            return tools.compare_to_baseline.inputSchema.parse(
              month !== undefined ? { ...resolveRef(area), month } : { ...resolveRef(area), year },
            );
          },
          (i) => tools.compare_to_baseline.execute(i),
          summarizeCompare,
        );
      },
    }),

    export_csv: tool({
      description: tools.export_csv.description,
      inputSchema: z.object({ area: Area, start: Ym("First"), end: Ym("Last") }),
      execute: async ({ area, start, end }) => {
        return traced(
          "export_csv",
          { area, start, end },
          () => tools.export_csv.inputSchema.parse({ ...resolveRef(area), start, end }),
          (i) => tools.export_csv.execute(i),
          summarizeExport,
        );
      },
    }),
  };
}
