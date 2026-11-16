import { describe, expect, it } from "vitest";
import { daysInMonth, formatCount, formatP, formatRatio, formatYearMonth, joinList, ordinal } from "./format";

describe("format", () => {
  it("formats months, counts and ratios", () => {
    expect(formatYearMonth("2026-09")).toBe("Sep 2026");
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(formatCount(2645.455)).toBe("2,645");
    expect(formatCount(4.25)).toBe("4.3");
    expect(formatRatio(2.345)).toBe("2.3x");
    expect(formatRatio(0.78)).toBe("0.78x");
    expect(formatRatio(12.4)).toBe("12x");
  });

  it("builds ordinals, p-values and lists", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 96, 100].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "96th", "100th",
    ]);
    expect(formatP(0.0004)).toBe("p < 0.001");
    expect(formatP(0.0042)).toBe("p = 0.004");
    expect(formatP(0.031)).toBe("p = 0.03");
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b"])).toBe("a and b");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
  });
});
