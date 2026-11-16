import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  METRICS,
  NA,
  figureList,
  formatNumber,
  formatP,
  formatPlacebo,
  formatRatio,
  formatShare,
  parseValidation,
  regionColumns,
} from "@/lib/method/validation";
import { REGION_PRESETS } from "@/lib/geo";

const MOCK = path.resolve(__dirname, "../../../../contracts/mock/validation.json");

const region = {
  raw_bias: 3.9,
  harmonized_bias: 1.02,
  loyo_r: 0.94,
  loyo_nrmse: null,
  forward_r: 0.88,
  seam_ratio: 1.05,
  changepoint_p: 0.41,
  placebo: [],
  peak_month_match: 0.875,
  figures: {},
};

describe("parseValidation", () => {
  it("parses the repo mock and flags it as mock", () => {
    const r = parseValidation(readFileSync(MOCK, "utf8"));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.mock).toBe(true);
    expect(Object.keys(r.data.regions).sort()).toEqual(["pantanal", "punjab", "w_canada"]);
  });

  it("is not mock without the flag", () => {
    const r = parseValidation(JSON.stringify({ method_version: "1.0", regions: { pantanal: region } }));
    expect(r).toMatchObject({ status: "ok", mock: false });
  });

  it("rejects bad JSON and schema mismatches", () => {
    expect(parseValidation("{").status).toBe("invalid");
    const bad = parseValidation(
      JSON.stringify({ method_version: "1.0", regions: { pantanal: { ...region, loyo_r: "x" } } }),
    );
    expect(bad.status).toBe("invalid");
    if (bad.status === "invalid") expect(bad.error).toContain("regions.pantanal.loyo_r");
  });
});

describe("formatting", () => {
  it("formats values and shows n/a for null", () => {
    expect(formatRatio(2.181)).toBe("2.18x");
    expect(formatNumber(0.975)).toBe("0.97");
    expect(formatShare(0.875)).toBe("88%");
    expect(formatP(0.41)).toBe("0.41");
    expect(formatP(0.0042)).toBe("0.004");
    expect(formatP(0.0004)).toBe("< 0.001");
    for (const f of [formatRatio, formatNumber, formatShare, formatP]) {
      expect(f(null)).toBe(NA);
      expect(f(undefined)).toBe(NA);
      expect(f(Number.NaN)).toBe(NA);
    }
    expect(NA).toBe("n/a");
  });

  it("formats placebo dates", () => {
    expect(formatPlacebo([])).toBe(NA);
    expect(
      formatPlacebo([
        { date: "2008-01", seam_ratio: 0.97, changepoint_p: 0.55 },
        { date: "2015-01", seam_ratio: null, changepoint_p: null },
      ]),
    ).toBe("2008-01: 0.97x (p 0.55); 2015-01: n/a (p n/a)");
  });

  it("covers every numeric contract field", () => {
    expect(METRICS.map((m) => m.key).sort()).toEqual(
      [
        "changepoint_p",
        "forward_r",
        "harmonized_bias",
        "loyo_nrmse",
        "loyo_r",
        "peak_month_match",
        "raw_bias",
        "seam_ratio",
      ].sort(),
    );
  });
});

describe("regionColumns", () => {
  it("orders presets first, uses preset names, keeps unknown keys", () => {
    const data = {
      method_version: "1.0",
      regions: { other: region, punjab: region, pantanal: region },
    };
    const cols = regionColumns(data, [
      { key: "pantanal", name: "Brazilian Pantanal" },
      { key: "w_canada", name: "Western Canada" },
      { key: "punjab", name: "Indian Punjab" },
    ]);
    expect(cols.map((c) => [c.key, c.name])).toEqual([
      ["pantanal", "Brazilian Pantanal"],
      ["punjab", "Indian Punjab"],
      ["other", "other"],
    ]);
  });

  it("names every mock region from REGION_PRESETS", () => {
    const r = parseValidation(readFileSync(MOCK, "utf8"));
    if (r.status !== "ok") throw new Error("mock did not parse");
    const cols = regionColumns(r.data, REGION_PRESETS);
    for (const c of cols) expect(c.name).not.toBe(c.key);
  });
});

describe("figureList", () => {
  const figs = { seam: "figures/seam_pantanal.png", scatter: "/figures/scatter_pantanal.png", x: "" };

  it("returns nothing without a base URL", () => {
    expect(figureList(figs, null)).toEqual([]);
  });

  it("joins paths to the base URL", () => {
    expect(figureList(figs, "https://storage.googleapis.com/b/public/v1")).toEqual([
      {
        name: "seam",
        label: "Seam chart",
        src: "https://storage.googleapis.com/b/public/v1/figures/seam_pantanal.png",
      },
      {
        name: "scatter",
        label: "Harmonized vs MODIS scatter",
        src: "https://storage.googleapis.com/b/public/v1/figures/scatter_pantanal.png",
      },
    ]);
  });
});
