import { describe, expect, it } from "vitest";
import type { SeriesResponse } from "@/lib/contracts";
import { loadMockSeries } from "@/components/summary/test-fixtures";
import {
  annualBars,
  annualCaption,
  annualOrder,
  defaultProfileYear,
  profileYears,
  seamBand,
  seamCaption,
  seamMarkers,
  seamRows,
  seamStats,
  seasonCaption,
  seasonProfile,
  yearLine,
} from "./chart-data";

const mock = loadMockSeries();

describe("season profile", () => {
  it("has 12 months with baseline median inside a sane IQR", () => {
    const rows = seasonProfile(mock);
    expect(rows).toHaveLength(12);
    const sep = rows[8];
    expect(sep.label).toBe("Sep");
    expect(sep.median).toBe(194.5);
    expect(sep.q1!).toBeLessThanOrEqual(sep.q3!);
    expect(sep.years).toBe(26); // 2001-2026
    // October 2026 is partial, so October has one fewer year than September.
    expect(rows[9].years).toBe(25);
    // July 2001 has no data.
    expect(rows[6].years).toBe(25);
  });

  it("defaults to the latest complete year and lists years with data", () => {
    expect(defaultProfileYear(mock)).toBe(2025);
    const years = profileYears(mock);
    expect(years[0]).toBe(2000);
    expect(years[years.length - 1]).toBe(2026);
    expect(yearLine(mock, 2026)).toHaveLength(10);
    expect(yearLine(mock, 2026)[9]).toMatchObject({ month: 10, partial: true });
  });

  it("captions the peak and the selected year", () => {
    expect(seasonCaption(mock, 2020)).toMatch(
      /^Fire peaks in September, with a normal 195 fire cell-days\. In 2020 the busiest month was August at 665, 3\.7x normal\.$/,
    );
  });
});

describe("sensor seam", () => {
  it("emits three series per month and keeps nulls as gaps", () => {
    const rows = seamRows(mock);
    expect(rows).toHaveLength(mock.months.length * 3);
    const viirs2011 = rows.find((r) => r.series === "VIIRS raw" && r.month === "2011-12")!;
    expect(viirs2011.value).toBeNull();
    expect(rows[0].date.toISOString()).toBe("2000-11-01T00:00:00.000Z");
  });

  it("places markers at 2012-01 and 2020-01", () => {
    expect(seamMarkers(mock).map((m) => m.month)).toEqual(["2012-01", "2020-01"]);
    const late: SeriesResponse = { ...mock, months: mock.months.filter((m) => m.month >= "2021-01") };
    expect(seamMarkers(late)).toEqual([]);
  });

  it("shows raw VIIRS far above MODIS and harmonized close to MODIS", () => {
    const { rawRatio, harmonizedRatio } = seamStats(mock);
    expect(rawRatio!).toBeGreaterThan(2);
    expect(harmonizedRatio!).toBeGreaterThan(0.8);
    expect(harmonizedRatio!).toBeLessThan(1.3);
    expect(seamCaption(mock)).toContain("over 2012-2019");
    expect(seamBand(mock).every((b) => b.hi > b.lo)).toBe(true);
    expect(seamBand(mock)[0].date >= new Date(Date.UTC(2020, 0, 1))).toBe(true);
  });
});

describe("annual totals", () => {
  it("labels ranks and partial years", () => {
    const bars = annualBars(mock);
    expect(bars[0]).toMatchObject({ year: 2000, label: "partial", complete: false });
    expect(bars.find((b) => b.year === 2020)!.label).toBe("#1");
    const byRank = annualOrder(bars, "rank");
    expect(byRank.slice(0, 2)).toEqual([2020, 2024]);
    expect(byRank.slice(-3)).toEqual([2000, 2001, 2026]);
    expect(annualOrder(bars, "year")[0]).toBe(2000);
  });

  it("captions the ranking", () => {
    expect(annualCaption(mock)).toBe(
      "2020 was the worst of 24 complete years at 2,645 fire cell-days; 2024 was next at 1,594. 2000, 2001 and 2026 are incomplete and not ranked.",
    );
  });
});
