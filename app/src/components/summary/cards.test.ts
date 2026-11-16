import { describe, expect, it } from "vitest";
import type { SeriesResponse } from "@/lib/contracts";
import {
  annualTrend,
  buildCards,
  currentCard,
  peakMonths,
  trendCard,
  worstMonthsCard,
  worstYearCard,
} from "./cards";
import { loadMockSeries } from "./test-fixtures";

const mock = loadMockSeries();

function withAnnual(series: SeriesResponse, totals: number[], firstYear = 2000): SeriesResponse {
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    ...series,
    summary: {
      ...series.summary,
      annual: totals.map((total, i) => ({
        year: firstYear + i,
        total,
        rank: 1 + sorted.filter((t) => t > total).length,
        complete: true,
      })),
    },
  };
}

describe("summary cards on the Pantanal mock", () => {
  it("describes the current month against normal and flags it", () => {
    const card = currentCard(mock)!;
    expect(card.headline).toBe("Oct 2026: 99 fire cell-days, 0.78x the October median, 20th percentile.");
    expect(card.detail).toBe("A normal October has 127 fire cell-days (baseline median).");
    expect(card.flags).toEqual([
      "Partial month: 28 of 31 days observed.",
      "Provisional: near-real-time data, may be revised.",
    ]);
  });

  it("names the peak calendar months by baseline median", () => {
    expect(peakMonths(mock).map((p) => p.month)).toEqual([9, 8, 10]);
    expect(worstMonthsCard(mock)!.headline).toBe("September, August and October are the worst months for fire.");
  });

  it("names the worst complete year", () => {
    const card = worstYearCard(mock)!;
    expect(card.headline).toBe("2020 was the worst year: 2,645 fire cell-days.");
    expect(card.detail).toMatch(/ranked across 24 complete years\.$/);
  });

  it("hides the trend card when Mann-Kendall is not significant", () => {
    const t = annualTrend(mock)!;
    expect(t.n).toBe(24);
    expect(t.firstYear).toBe(2002);
    expect(t.lastYear).toBe(2025);
    expect(t.p).toBeCloseTo(0.7098, 3);
    expect(trendCard(mock)).toBeNull();
    expect(buildCards(mock).map((c) => c.id)).toEqual(["current", "months", "year"]);
  });
});

describe("summary cards edge cases", () => {
  it("shows a rising trend when the data supports it", () => {
    const series = withAnnual(mock, Array.from({ length: 15 }, (_, i) => 100 + 10 * i + (i % 3)));
    const card = trendCard(series)!;
    expect(card.headline).toMatch(/^Fire activity is rising by about 10 fire cell-days a year\.$/);
    expect(card.detail).toMatch(/15 complete years \(2000-2014\), Mann-Kendall p < 0\.001\./);
  });

  it("does not test a trend on too few years", () => {
    expect(annualTrend(withAnnual(mock, [1, 2, 3, 4, 5]))).toBeNull();
  });

  it("handles a month with no data and missing baselines", () => {
    const series: SeriesResponse = {
      ...mock,
      summary: {
        ...mock.summary,
        current: {
          ...mock.summary.current,
          harmonized: null,
          baseline_median: null,
          ratio_to_median: null,
          percentile: null,
          z: null,
          provisional: false,
          partial: false,
        },
      },
    };
    expect(currentCard(series)!.headline).toBe("Oct 2026: no satellite data.");
    expect(currentCard(series)!.flags).toEqual([]);
  });

  it("omits ratio and percentile when null", () => {
    const series: SeriesResponse = {
      ...mock,
      summary: {
        ...mock.summary,
        current: { ...mock.summary.current, ratio_to_median: null, percentile: null, baseline_median: 0 },
      },
    };
    const card = currentCard(series)!;
    expect(card.headline).toBe("Oct 2026: 99 fire cell-days.");
    expect(card.detail).toBe("A normal October has no fire cell-days.");
  });

  it("hides worst year and worst months when there is nothing to rank", () => {
    const empty: SeriesResponse = {
      ...mock,
      months: mock.months.map((m) => ({ ...m, baseline_median: null })),
      summary: { ...mock.summary, peak_year: null, annual: mock.summary.annual.map((a) => ({ ...a, rank: null, complete: false })) },
    };
    expect(worstYearCard(empty)).toBeNull();
    expect(worstMonthsCard(empty)).toBeNull();
    expect(annualTrend(empty)).toBeNull();
  });

  it("mentions ties for the worst year", () => {
    const series = withAnnual(mock, [5, 9, 9, 3]);
    expect(worstYearCard(series)!.headline).toBe("2001 was the worst year (tied with 2002): 9 fire cell-days.");
  });
});
