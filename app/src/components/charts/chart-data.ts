// Pure data shaping and caption text for the trend charts. No DOM, no Plot.
import type { SeriesResponse } from "@/lib/contracts";
import { calendarMedians } from "@/components/summary/cards";
import {
  MONTH_LONG,
  MONTH_SHORT,
  daysInMonth,
  formatCount,
  formatRatio,
  joinList,
  parseYearMonth,
} from "@/components/summary/format";
import { quantile } from "@/components/summary/stats";

const UNIT = "fire cell-days";

/** First day of a YYYY-MM month as a UTC Date (Plot's time scales are UTC). */
export function monthDate(ym: string): Date {
  const { year, month } = parseYearMonth(ym);
  return new Date(Date.UTC(year, month - 1, 1));
}

function isFullMonth(m: SeriesResponse["months"][number]): boolean {
  const { year, month } = parseYearMonth(m.month);
  return m.valid_days >= daysInMonth(year, month);
}

// ---------- Season profile ----------

export type ProfileRow = {
  month: number; // 1-12
  label: string; // "Jan"
  median: number | null; // baseline median
  q1: number | null; // 25th percentile across years in the range
  q3: number | null; // 75th percentile across years in the range
  years: number; // years that contributed to q1/q3
};

/**
 * Per calendar month: the baseline median (same number the cards use) and the interquartile
 * range of that month across all years in the range. Partial months are left out of the IQR.
 */
export function seasonProfile(series: SeriesResponse): ProfileRow[] {
  const medians = calendarMedians(series);
  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  for (const m of series.months) {
    if (m.harmonized === null || !isFullMonth(m)) continue;
    byMonth[parseYearMonth(m.month).month - 1].push(m.harmonized);
  }
  return byMonth.map((values, i) => ({
    month: i + 1,
    label: MONTH_SHORT[i],
    median: medians[i],
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    years: values.length,
  }));
}

/** Years with at least one month of data, ascending. */
export function profileYears(series: SeriesResponse): number[] {
  const years = new Set<number>();
  for (const m of series.months) if (m.harmonized !== null) years.add(parseYearMonth(m.month).year);
  return [...years].sort((a, b) => a - b);
}

/** Latest complete year, else the latest year with data, else null. */
export function defaultProfileYear(series: SeriesResponse): number | null {
  const complete = series.summary.annual.filter((a) => a.complete).map((a) => a.year);
  if (complete.length > 0) return Math.max(...complete);
  const years = profileYears(series);
  return years.length > 0 ? years[years.length - 1] : null;
}

export type YearPoint = { month: number; label: string; value: number | null; partial: boolean };

/** The months of one year that are in the range. */
export function yearLine(series: SeriesResponse, year: number): YearPoint[] {
  return series.months
    .filter((m) => parseYearMonth(m.month).year === year)
    .map((m) => {
      const month = parseYearMonth(m.month).month;
      return { month, label: MONTH_SHORT[month - 1], value: m.harmonized, partial: !isFullMonth(m) };
    });
}

export function seasonCaption(series: SeriesResponse, year: number | null): string {
  const profile = seasonProfile(series);
  const peak = profile
    .filter((r): r is ProfileRow & { median: number } => r.median !== null)
    .sort((a, b) => b.median - a.median || a.month - b.month)[0];
  if (!peak) return "Not enough data for a seasonal profile.";
  const parts = [
    `Fire peaks in ${MONTH_LONG[peak.month - 1]}, with a normal ${formatCount(peak.median)} ${UNIT}.`,
  ];
  if (year !== null) {
    const points = yearLine(series, year).filter(
      (p): p is YearPoint & { value: number } => p.value !== null,
    );
    const top = points.sort((a, b) => b.value - a.value || a.month - b.month)[0];
    if (top) {
      const normal = profile[top.month - 1].median;
      const vsNormal = normal !== null && normal > 0 ? `, ${formatRatio(top.value / normal)} normal` : "";
      parts.push(
        `In ${year} the busiest month was ${MONTH_LONG[top.month - 1]} at ${formatCount(top.value)}${vsNormal}.`,
      );
    }
  }
  return parts.join(" ");
}

// ---------- Sensor seam ----------

export const SEAM_SERIES = ["MODIS raw", "VIIRS raw", "Harmonized"] as const;
export type SeamSeries = (typeof SEAM_SERIES)[number];

export type SeamRow = { date: Date; month: string; series: SeamSeries; value: number | null };
export type SeamBandRow = { date: Date; lo: number; hi: number };

export const SEAM_MARKERS = [
  { month: "2012-01", label: "VIIRS starts" },
  { month: "2020-01", label: "Harmonized switches to scaled VIIRS" },
] as const;

/** Long-format rows for the seam chart. Nulls are kept so Plot draws gaps. */
export function seamRows(series: SeriesResponse): SeamRow[] {
  const rows: SeamRow[] = [];
  for (const m of series.months) {
    const date = monthDate(m.month);
    rows.push({ date, month: m.month, series: "MODIS raw", value: m.modis_raw });
    rows.push({ date, month: m.month, series: "VIIRS raw", value: m.viirs_raw });
    rows.push({ date, month: m.month, series: "Harmonized", value: m.harmonized });
  }
  return rows;
}

/** Uncertainty band of the harmonized series (only where it differs from the line). */
export function seamBand(series: SeriesResponse): SeamBandRow[] {
  return series.months
    .filter((m) => m.lo !== null && m.hi !== null && m.hi > m.lo)
    .map((m) => ({ date: monthDate(m.month), lo: m.lo as number, hi: m.hi as number }));
}

/** Markers that fall inside the series range. */
export function seamMarkers(series: SeriesResponse): { date: Date; month: string; label: string }[] {
  const first = series.months[0]?.month;
  const last = series.months[series.months.length - 1]?.month;
  if (!first || !last) return [];
  return SEAM_MARKERS.filter((m) => m.month > first && m.month <= last).map((m) => ({
    ...m,
    date: monthDate(m.month),
  }));
}

/** Ratio of sums of a / b over months where both are non-null and the filter holds. */
function sumRatio(
  series: SeriesResponse,
  a: (m: SeriesResponse["months"][number]) => number | null,
  b: (m: SeriesResponse["months"][number]) => number | null,
  keep: (ym: string) => boolean,
): number | null {
  let sa = 0;
  let sb = 0;
  for (const m of series.months) {
    const va = a(m);
    const vb = b(m);
    if (va === null || vb === null || !keep(m.month)) continue;
    sa += va;
    sb += vb;
  }
  return sb > 0 ? sa / sb : null;
}

export function seamStats(series: SeriesResponse): {
  rawRatio: number | null; // VIIRS raw / MODIS raw, 2012-2019
  harmonizedRatio: number | null; // harmonized / MODIS raw, 2020 on
} {
  return {
    rawRatio: sumRatio(series, (m) => m.viirs_raw, (m) => m.modis_raw, (ym) => ym >= "2012-01" && ym < "2020-01"),
    harmonizedRatio: sumRatio(series, (m) => m.harmonized, (m) => m.modis_raw, (ym) => ym >= "2020-01"),
  };
}

export function seamCaption(series: SeriesResponse): string {
  const { rawRatio, harmonizedRatio } = seamStats(series);
  const parts: string[] = [];
  if (rawRatio !== null) {
    parts.push(
      `Raw VIIRS counts run ${formatRatio(rawRatio)} MODIS over 2012-2019 because its smaller pixels see more fires, so stitching raw counts would fake a jump in 2012.`,
    );
  }
  if (harmonizedRatio !== null) {
    parts.push(
      `The harmonized series uses MODIS to 2019 and scaled VIIRS from 2020, where it runs at ${formatRatio(harmonizedRatio)} MODIS.`,
    );
  }
  return parts.length > 0
    ? parts.join(" ")
    : "Monthly fire cell-days from each sensor and the harmonized series.";
}

// ---------- Annual totals ----------

export type AnnualBar = {
  year: number;
  total: number;
  rank: number | null;
  complete: boolean;
  label: string; // "#1" or "partial"
};

export function annualBars(series: SeriesResponse): AnnualBar[] {
  return series.summary.annual
    .map((a) => ({
      year: a.year,
      total: a.total,
      rank: a.rank,
      complete: a.complete,
      label: a.complete && a.rank !== null ? `#${a.rank}` : "partial",
    }))
    .sort((a, b) => a.year - b.year);
}

/** Year order for the x axis: chronological, or by rank with incomplete years last. */
export function annualOrder(bars: readonly AnnualBar[], by: "year" | "rank"): number[] {
  const sorted = [...bars];
  if (by === "rank") {
    sorted.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.year - b.year);
  } else {
    sorted.sort((a, b) => a.year - b.year);
  }
  return sorted.map((b) => b.year);
}

export function annualCaption(series: SeriesResponse): string {
  const bars = annualBars(series);
  const ranked = bars.filter((b) => b.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
  const partial = bars.filter((b) => !b.complete).map((b) => String(b.year));
  const parts: string[] = [];
  if (ranked.length > 0) {
    const [first, second] = ranked;
    parts.push(
      `${first.year} was the worst of ${ranked.length} complete ${ranked.length === 1 ? "year" : "years"} at ${formatCount(first.total)} ${UNIT}${second ? `; ${second.year} was next at ${formatCount(second.total)}` : ""}.`,
    );
  } else {
    parts.push("No complete years in this range, so years are not ranked.");
  }
  if (partial.length > 0) {
    parts.push(`${joinList(partial)} ${partial.length === 1 ? "is" : "are"} incomplete and not ranked.`);
  }
  return parts.join(" ");
}
