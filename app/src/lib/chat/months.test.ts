import { describe, expect, it } from "vitest";
import { extractMonths, monthLabel } from "./months";

describe("extractMonths", () => {
  it("finds ISO, full-name and short-name months in order of appearance", () => {
    const text = "August 2024 was high; 2020-09 was the record, and Sep 2021 and Sept. 2019 were close.";
    expect(extractMonths(text)).toEqual(["2024-08", "2020-09", "2021-09", "2019-09"]);
  });

  it("deduplicates and is case-insensitive", () => {
    expect(extractMonths("AUGUST 2024 vs aug 2024 vs 2024-08")).toEqual(["2024-08"]);
  });

  it("ignores bare years, full dates, invalid months and month names without a year", () => {
    expect(extractMonths("In 2024, on 2024-08-15, 2024-13 and in August the area burned")).toEqual([]);
  });

  it("accepts a comma between month and year", () => {
    expect(extractMonths("October, 2023 was quiet")).toEqual(["2023-10"]);
  });

  it("labels months", () => {
    expect(monthLabel("2024-08")).toBe("August 2024");
    expect(monthLabel("2000-11")).toBe("November 2000");
  });
});
