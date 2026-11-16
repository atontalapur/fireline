import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GetSeriesOutput } from "@/lib/fire-tools";
import { compactSeries } from "./model-tools";

const series = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../contracts/mock/series-pantanal.json"), "utf8"),
) as GetSeriesOutput;

describe("compactSeries", () => {
  it("drops z and percentile for the partial last month, matching summary.current", () => {
    const out = compactSeries(series, false);
    const last = out.months.at(-1)!;
    expect(last.month).toBe("2026-10"); // 28 of 31 days in the mock
    expect(last).toMatchObject({ z: null, percentile: null, partial: true });
    expect(out.current).toMatchObject({ month: "2026-10", z: null, percentile: null, partial: true });
    const full = out.months.at(-2)!;
    expect(full.partial).toBeUndefined();
    expect(full.z).not.toBeNull();
  });
});
