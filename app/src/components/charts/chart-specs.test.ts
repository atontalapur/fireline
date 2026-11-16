import { describe, expect, it } from "vitest";
import { loadMockSeries } from "@/components/summary/test-fixtures";
import { SEAM_SERIES } from "./chart-data";
import { annualSpec, seamSpec, seasonSpec } from "./chart-specs";

const mock = loadMockSeries();

describe("chart specs", () => {
  it("build Plot options for every chart without a DOM", () => {
    expect(seasonSpec(mock, 2025, 600).marks!.filter(Boolean)).toHaveLength(5);
    expect(seasonSpec(mock, null, 600).marks!.filter(Boolean)).toHaveLength(5);
    // rule, band, harmonized line, raw lines, marker rules, two marker labels, tip
    expect(seamSpec(mock, SEAM_SERIES, 900).marks!.filter(Boolean)).toHaveLength(8);
    // band is dropped when the harmonized series is hidden
    expect(seamSpec(mock, ["MODIS raw", "VIIRS raw"], 900).marks!.filter(Boolean)).toHaveLength(7);
    const annual = annualSpec(mock, "rank", 600);
    expect((annual.x as { domain: number[] }).domain.slice(0, 2)).toEqual([2020, 2024]);
  });

  it("keeps chart height within bounds", () => {
    expect(seamSpec(mock, SEAM_SERIES, 200).height).toBe(260);
    expect(seamSpec(mock, SEAM_SERIES, 2000).height).toBe(380);
  });
});
