// Plain-sentence summary cards, all derived from one SeriesResponse.
import type { SeriesResponse } from "@/lib/contracts";
import {
  MONTH_LONG,
  daysInMonth,
  formatCount,
  formatP,
  formatRatio,
  formatYearMonth,
  joinList,
  ordinal,
  parseYearMonth,
} from "./format";
import { mannKendall, median, theilSen } from "./stats";

export type CardId = "current" | "months" | "year" | "trend";

export type SummaryCard = {
  id: CardId;
  title: string;
  headline: string;
  detail?: string;
  flags: string[];
};

const UNIT = "fire cell-days";

/** Minimum complete years before a trend test is attempted. */
export const TREND_MIN_YEARS = 10;
export const TREND_ALPHA = 0.05;

export function currentCard(series: SeriesResponse): SummaryCard | null {
  const c = series.summary.current;
  if (!c.month) return null;
  const label = formatYearMonth(c.month);
  const { year, month } = parseYearMonth(c.month);
  const monthName = MONTH_LONG[month - 1];
  const entry = series.months.find((m) => m.month === c.month);

  const flags: string[] = [];
  if (c.partial) {
    const total = daysInMonth(year, month);
    flags.push(
      entry && entry.valid_days > 0
        ? `Partial month: ${entry.valid_days} of ${total} days observed.`
        : "Partial month.",
    );
  }
  if (c.provisional) flags.push("Provisional: near-real-time data, may be revised.");

  if (c.harmonized === null) {
    return {
      id: "current",
      title: "This month vs normal",
      headline: `${label}: no satellite data.`,
      flags,
    };
  }

  const parts = [`${formatCount(c.harmonized)} ${UNIT}`];
  if (c.ratio_to_median !== null) parts.push(`${formatRatio(c.ratio_to_median)} the ${monthName} median`);
  if (c.percentile !== null) parts.push(`${ordinal(Math.round(c.percentile))} percentile`);

  let detail: string | undefined;
  if (c.baseline_median !== null) {
    detail =
      c.baseline_median === 0
        ? `A normal ${monthName} has no fire cell-days.`
        : `A normal ${monthName} has ${formatCount(c.baseline_median)} ${UNIT} (baseline median).`;
  }

  return {
    id: "current",
    title: "This month vs normal",
    headline: `${label}: ${parts.join(", ")}.`,
    detail,
    flags,
  };
}

/** Baseline median per calendar month (index 0 = January); null where unknown. */
export function calendarMedians(series: SeriesResponse): (number | null)[] {
  const out: (number | null)[] = Array(12).fill(null);
  for (const m of series.months) {
    const i = parseYearMonth(m.month).month - 1;
    if (out[i] === null && m.baseline_median !== null) out[i] = m.baseline_median;
  }
  return out;
}

/** Calendar months (1-12) ordered by baseline median, highest first; zero and null left out. */
export function peakMonths(series: SeriesResponse, count = 3): { month: number; median: number }[] {
  return calendarMedians(series)
    .map((median, i) => ({ month: i + 1, median }))
    .filter((d): d is { month: number; median: number } => d.median !== null && d.median > 0)
    .sort((a, b) => b.median - a.median || a.month - b.month)
    .slice(0, count);
}

export function worstMonthsCard(series: SeriesResponse): SummaryCard | null {
  const peaks = peakMonths(series);
  if (peaks.length === 0) return null;
  const names = peaks.map((p) => MONTH_LONG[p.month - 1]);
  const values = peaks.map((p) => formatCount(p.median));
  return {
    id: "months",
    title: "Worst months",
    headline:
      names.length === 1
        ? `${names[0]} is the worst month for fire.`
        : `${joinList(names)} are the worst months for fire.`,
    detail: `Normal ${names.length === 1 ? "level" : "levels"}: ${joinList(values)} ${UNIT} (baseline median).`,
    flags: [],
  };
}

export function worstYearCard(series: SeriesResponse): SummaryCard | null {
  const complete = series.summary.annual.filter((a) => a.complete);
  const top = complete.filter((a) => a.rank === 1);
  if (top.length === 0) return null;
  const worst = top[0];
  const typical = median(complete.map((a) => a.total));
  const tied = top.length > 1 ? ` (tied with ${joinList(top.slice(1).map((a) => String(a.year)))})` : "";
  const detailParts: string[] = [];
  if (typical !== null && typical > 0) {
    detailParts.push(`${formatRatio(worst.total / typical)} the median year (${formatCount(typical)})`);
  }
  detailParts.push(`ranked across ${complete.length} complete ${complete.length === 1 ? "year" : "years"}`);
  const detail = detailParts.join(", ");
  return {
    id: "year",
    title: "Worst year",
    headline: `${worst.year} was the worst year${tied}: ${formatCount(worst.total)} ${UNIT}.`,
    detail: `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`,
    flags: [],
  };
}

export type TrendResult = {
  firstYear: number;
  lastYear: number;
  n: number;
  slope: number;
  p: number;
};

/** Theil-Sen slope with a Mann-Kendall test over complete years. Null if too few years. */
export function annualTrend(series: SeriesResponse): TrendResult | null {
  const complete = series.summary.annual
    .filter((a) => a.complete)
    .sort((a, b) => a.year - b.year);
  if (complete.length < TREND_MIN_YEARS) return null;
  const years = complete.map((a) => a.year);
  const totals = complete.map((a) => a.total);
  const mk = mannKendall(totals);
  const slope = theilSen(years, totals);
  if (mk === null || slope === null) return null;
  return { firstYear: years[0], lastYear: years[years.length - 1], n: mk.n, slope, p: mk.p };
}

/** Shown only when the trend is significant (p < 0.05) and the slope is non-zero. */
export function trendCard(series: SeriesResponse): SummaryCard | null {
  const t = annualTrend(series);
  if (t === null || t.p >= TREND_ALPHA || t.slope === 0) return null;
  const rising = t.slope > 0;
  return {
    id: "trend",
    title: "Long-term trend",
    headline: `Fire activity is ${rising ? "rising" : "falling"} by about ${formatCount(Math.abs(t.slope))} ${UNIT} a year.`,
    detail: `Theil-Sen slope over ${t.n} complete years (${t.firstYear}-${t.lastYear}), Mann-Kendall ${formatP(t.p)}.`,
    flags: [],
  };
}

export function buildCards(series: SeriesResponse): SummaryCard[] {
  return [currentCard(series), worstMonthsCard(series), worstYearCard(series), trendCard(series)].filter(
    (c): c is SummaryCard => c !== null,
  );
}
