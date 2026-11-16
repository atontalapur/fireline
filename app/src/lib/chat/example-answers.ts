// Deterministic answers to the example questions: call the fire tools directly and fill a sentence
// template from their outputs, so every number in the text comes from a tool output. No model call.
// Results are cached in memory for the life of the server process (with a TTL, since NRT data moves).
import { fireTools } from "@/lib/fire-tools";
import type { CompareToBaselineOutput, GetSeriesOutput } from "@/lib/fire-tools";
import type { z } from "zod";
import { presetFor } from "@/lib/geo";
import type { RegionKey } from "@/lib/contracts";
import { MONTH_NAMES, extractMonths, monthLabel } from "./months";
import { displayInput, fmt, ordinal } from "./format";
import { selectionArea, selectionKey } from "./selection";
import { summarizeCompare, summarizeSeries } from "./summarize";
import type { ChatAnswer, ChatSelection, TraceEntry } from "./types";
import type { ExampleId } from "./examples";

export type FireToolSet = typeof fireTools;
type SeriesInput = z.infer<FireToolSet["get_series"]["inputSchema"]>;
type CompareInput = z.infer<FireToolSet["compare_to_baseline"]["inputSchema"]>;

const TTL_MS = 60 * 60 * 1000;
type Entry<T> = { at: number; value: Promise<T> };
const answerCache = new Map<string, Entry<ChatAnswer>>();
const toolCache = new Map<string, Entry<unknown>>();

export function clearExampleCaches() {
  answerCache.clear();
  toolCache.clear();
}

function cached<T>(cache: Map<string, Entry<unknown>>, key: string, run: () => Promise<T>): { value: Promise<T>; hit: boolean } {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { value: hit.value as Promise<T>, hit: true };
  const value = run();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return { value, hit: false };
}

/** Tool calls for one answer: cached when the input has no cell list, and recorded in the trace. */
class Calls {
  readonly trace: TraceEntry[] = [];
  constructor(private tools: FireToolSet) {}

  private async run<I extends object, O>(name: string, input: I, exec: (i: I) => Promise<O>, summarize: (o: O) => string): Promise<O> {
    const cacheable = !("cells" in input && input.cells);
    const out = cacheable
      ? await cached(toolCache, `${name}:${JSON.stringify(input)}`, () => exec(input)).value
      : await exec(input);
    this.trace.push({ tool: name, input: displayInput(input), summary: summarize(out) });
    return out;
  }

  series(input: SeriesInput): Promise<GetSeriesOutput> {
    return this.run("get_series", input, (i) => this.tools.get_series.execute(i), summarizeSeries);
  }

  compare(input: CompareInput): Promise<CompareToBaselineOutput> {
    return this.run("compare_to_baseline", input, (i) => this.tools.compare_to_baseline.execute(i), summarizeCompare);
  }
}

const regionName = (key: RegionKey) => presetFor(key).name;
const calendarMonth = (ym: string) => Number(ym.slice(5, 7));

function verdict(z: number | null, percentile: number | null): string | null {
  if (z !== null) {
    if (z >= 2) return "unusually high";
    if (z <= -2) return "unusually low";
    if (z >= 1) return "above normal";
    if (z <= -1) return "below normal";
    return "close to normal";
  }
  if (percentile !== null) {
    if (percentile >= 90) return "unusually high";
    if (percentile <= 10) return "unusually low";
    return "within the normal range";
  }
  return null;
}

const PROVISIONAL = "The data for this period is provisional (near-real-time or incomplete), so it may change.";

function monthComparison(c: CompareToBaselineOutput, place: string): string[] {
  const month = monthLabel(c.period);
  const name = MONTH_NAMES[calendarMonth(c.period) - 1];
  if (c.value === null) return [`There is no harmonized value for ${month} in ${place}, so I can't compare it to normal.`];
  const v = verdict(c.z, c.percentile);
  const out = [
    `${month} in ${place} had ${fmt(c.value)} fire cell-days` +
      (c.median !== null ? ` against the ${name} baseline median of ${fmt(c.median)}` : "") +
      (c.ratio !== null ? ` (${fmt(c.ratio)}x the median)` : "") +
      (v ? `, which is ${v}.` : "."),
  ];
  if (c.rank !== null)
    out.push(
      `It ranks ${ordinal(c.rank)} of ${c.of} ${name}s on record` +
        (c.percentile !== null ? `, at the ${ordinal(c.percentile)} percentile of the baseline.` : "."),
    );
  if (c.provisional) out.push(PROVISIONAL);
  return out;
}

type Built = { sentences: string[]; months?: string[] };

async function pantanalAug2024(calls: Calls): Promise<Built> {
  const c = await calls.compare({ region: "pantanal", month: "2024-08" });
  return { sentences: monthComparison(c, `the ${regionName("pantanal")}`) };
}

async function wCanadaTopYear(calls: Calls): Promise<Built> {
  const s = await calls.series({ region: "w_canada" });
  const place = regionName("w_canada");
  const ranked = s.summary.annual
    .filter((a) => a.complete && a.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number));
  const top = ranked[0];
  if (!top) return { sentences: [`No complete year is ranked yet for ${place}.`] };
  const out = [
    `${top.year} burned most in ${place}, with ${fmt(top.total)} fire cell-days, the highest annual total among complete years.`,
  ];
  const second = ranked[1];
  if (second) out.push(`The next highest was ${second.year}, with ${fmt(second.total)}.`);
  const best = s.months
    .filter((m) => m.month.startsWith(`${top.year}-`) && m.harmonized !== null)
    .sort((a, b) => (b.harmonized as number) - (a.harmonized as number))[0];
  if (best) out.push(`Its biggest month was ${monthLabel(best.month)}, with ${fmt(best.harmonized as number)}.`);
  return { sentences: out };
}

async function punjabPeakMonth(calls: Calls): Promise<Built> {
  const s = await calls.series({ region: "punjab" });
  const place = regionName("punjab");
  const p = s.summary.peak_month_of_year;
  if (p === null) return { sentences: [`There isn't enough baseline data to name a peak fire month for ${place}.`] };
  const name = MONTH_NAMES[p - 1];
  const rows = s.months.filter((m) => calendarMonth(m.month) === p);
  const mean = rows.findLast((m) => m.baseline_mean !== null)?.baseline_mean ?? null;
  const out = [
    `The peak fire month in ${place} is ${name}: it has the highest baseline mean of any calendar month` +
      (mean !== null ? `, ${fmt(mean)} fire cell-days.` : "."),
  ];
  const best = rows
    .filter((m) => m.harmonized !== null)
    .sort((a, b) => (b.harmonized as number) - (a.harmonized as number))[0];
  if (best) out.push(`The biggest ${name} on record was ${monthLabel(best.month)}, with ${fmt(best.harmonized as number)}.`);
  return { sentences: out };
}

async function thisMonth(calls: Calls, selection: ChatSelection | null): Promise<Built> {
  const area = selectionArea(selection);
  const lead: string[] = [];
  let place: string;
  let input: SeriesInput;
  if (area && selection) {
    place = `"${selection.label}"`;
    input = area;
    if (selection.approximate && "region" in area)
      lead.push(`Your area is large, so this uses the whole ${regionName(area.region as RegionKey)} preset.`);
  } else {
    place = `the ${regionName("pantanal")}`;
    input = { region: "pantanal" };
    lead.push(`No area is selected, so this uses the ${regionName("pantanal")}.`);
  }
  const s = await calls.series(input);
  const c = s.summary.current;
  if (s.meta.cell_count === 0 || c.harmonized === null)
    return { sentences: [...lead, `There is no harmonized data for ${place} in the latest month; the area may be outside coverage.`] };
  const month = monthLabel(c.month);
  const v = verdict(c.z, c.percentile);
  const out = [
    ...lead,
    `${month} in ${place} has ${fmt(c.harmonized)} fire cell-days` +
      (c.baseline_median !== null ? ` against a baseline median of ${fmt(c.baseline_median)} for that month` : "") +
      (c.ratio_to_median !== null ? ` (${fmt(c.ratio_to_median)}x)` : "") +
      (v ? `, which is ${v}.` : "."),
  ];
  if (c.provisional || c.partial)
    out.push(`This month is ${c.partial ? "still in progress and " : ""}provisional, so the number will change.`);
  if (s.meta.cell_count < 10) out.push("The area is very small, so monthly counts are noisy.");
  return { sentences: out, months: [c.month] };
}

async function pantanal2024Year(calls: Calls): Promise<Built> {
  const c = await calls.compare({ region: "pantanal", year: 2024 });
  const place = `the ${regionName("pantanal")}`;
  if (c.value === null) return { sentences: [`There is no harmonized total for ${c.period} in ${place}.`] };
  const v = verdict(c.z, c.percentile);
  const out = [
    `${c.period} had ${fmt(c.value)} fire cell-days in ${place}` +
      (c.median !== null ? `, against a median year of ${fmt(c.median)}` : "") +
      (c.ratio !== null ? ` (${fmt(c.ratio)}x)` : "") +
      (v ? `, which is ${v}.` : "."),
  ];
  out.push(
    c.rank !== null
      ? `It ranks ${ordinal(c.rank)} of ${c.of} years on record.`
      : `It isn't ranked because the year is incomplete.`,
  );
  if (c.provisional) out.push(PROVISIONAL);
  return { sentences: out };
}

async function pantanalWorstMonth(calls: Calls): Promise<Built> {
  const s = await calls.series({ region: "pantanal" });
  const place = `the ${regionName("pantanal")}`;
  const valued = s.months.filter((m) => m.harmonized !== null);
  const worst = [...valued].sort((a, b) => (b.harmonized as number) - (a.harmonized as number))[0];
  if (!worst) return { sentences: [`There is no harmonized data for ${place}.`] };
  const name = MONTH_NAMES[calendarMonth(worst.month) - 1];
  const out = [
    `The worst month on record in ${place} was ${monthLabel(worst.month)}, with ${fmt(worst.harmonized as number)} fire cell-days` +
      (worst.baseline_median !== null ? ` against the ${name} baseline median of ${fmt(worst.baseline_median)}.` : "."),
    `The record starts in ${monthLabel(s.months[0].month)}.`,
  ];
  if (worst.provisional) out.push(PROVISIONAL);
  return { sentences: out, months: [worst.month] };
}

const BUILDERS: Record<ExampleId, (calls: Calls, selection: ChatSelection | null) => Promise<Built>> = {
  "pantanal-aug-2024": pantanalAug2024,
  "w-canada-top-year": wCanadaTopYear,
  "punjab-peak-month": punjabPeakMonth,
  "this-month": thisMonth,
  "pantanal-2024-year": pantanal2024Year,
  "pantanal-worst-month": pantanalWorstMonth,
};

async function build(id: ExampleId, selection: ChatSelection | null, tools: FireToolSet): Promise<ChatAnswer> {
  const calls = new Calls(tools);
  const built = await BUILDERS[id](calls, selection);
  const text = built.sentences.join(" ");
  return { text, trace: calls.trace, months: built.months ?? extractMonths(text), source: "example" };
}

/** Answer an example question from the tools. Only "this-month" depends on the selection. */
export async function answerExample(
  id: ExampleId,
  selection: ChatSelection | null,
  tools: FireToolSet = fireTools,
): Promise<{ answer: ChatAnswer; cached: boolean }> {
  const key = id === "this-month" ? `${id}|${selectionKey(selection)}` : id;
  const { value, hit } = cached(answerCache as Map<string, Entry<unknown>>, key, () => build(id, selection, tools));
  return { answer: await value, cached: hit };
}
