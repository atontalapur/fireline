import { describe, expect, it } from "vitest";
import { mannKendall, median, normalCdf, quantile, theilSen } from "./stats";

describe("stats", () => {
  it("computes quantiles with linear interpolation and drops nulls", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, null, 3, Number.NaN], 0.5)).toBe(2);
    expect(median([])).toBeNull();
    expect(median([null])).toBeNull();
  });

  it("approximates the normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
  });

  it("runs Mann-Kendall on a strictly increasing series", () => {
    const mk = mannKendall([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(mk).not.toBeNull();
    expect(mk!.s).toBe(45);
    // var = 10*9*25/18 = 125, z = 44 / sqrt(125)
    expect(mk!.z).toBeCloseTo(44 / Math.sqrt(125), 9);
    expect(mk!.p).toBeLessThan(0.001);
  });

  it("applies the tie correction and handles flat or short series", () => {
    const tied = mannKendall([1, 1, 2, 2, 3, 3]);
    // ties: three groups of 2 -> 3 * 2*1*9 = 54; var = (6*5*17 - 54)/18 = 25.333...
    expect(tied!.s).toBe(12);
    expect(tied!.z).toBeCloseTo(11 / Math.sqrt((6 * 5 * 17 - 54) / 18), 9);
    expect(mannKendall([5, 5, 5, 5])).toEqual({ n: 4, s: 0, z: 0, p: 1 });
    expect(mannKendall([1, 2])).toBeNull();
  });

  it("computes the Theil-Sen slope and resists an outlier", () => {
    expect(theilSen([0, 1, 2, 3, 4], [0, 2, 4, 6, 100])).toBe(2);
    expect(theilSen([1], [1])).toBeNull();
  });
});
