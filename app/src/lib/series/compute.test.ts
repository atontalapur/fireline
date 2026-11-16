import { readFileSync } from "node:fs";
import path from "node:path";
import { LIST, VARCHAR, listValue } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { SeriesRequest, SeriesResponse } from "@/lib/contracts";
import { computeSeries, daysInMonth, median, round } from "@/lib/series/compute";
import { queryRows } from "@/lib/series/db";
import { dataFile } from "@/lib/data-dir";
import { regionOfCell } from "@/lib/geo";
import { POST } from "@/app/api/series/route";

const expected = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "..", "contracts", "mock", "series-pantanal.json"), "utf8"),
) as SeriesResponse;

const pantanal = SeriesRequest.parse({ region: "pantanal", start: "2000-11", end: "2026-10", baseline: [2003, 2022] });

// Deep compare with an absolute tolerance on numbers.
function expectClose(actual: unknown, want: unknown, at = "$"): void {
  if (typeof want === "number" && typeof actual === "number") {
    if (Math.abs(actual - want) > 1e-3) throw new Error(`${at}: ${actual} != ${want}`);
    return;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(actual) || actual.length !== want.length)
      throw new Error(`${at}: length ${Array.isArray(actual) ? actual.length : "n/a"} != ${want.length}`);
    want.forEach((w, i) => expectClose(actual[i], w, `${at}[${i}]`));
    return;
  }
  if (want && typeof want === "object") {
    if (!actual || typeof actual !== "object") throw new Error(`${at}: not an object`);
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(want), ...Object.keys(a)]);
    for (const k of keys) expectClose(a[k], (want as Record<string, unknown>)[k], `${at}.${k}`);
    return;
  }
  if (actual !== want) throw new Error(`${at}: ${JSON.stringify(actual)} != ${JSON.stringify(want)}`);
}

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("helpers", () => {
  it("rounds without -0 and handles nulls", () => {
    expect(round(-0.0001)).toBe(0);
    expect(round(1.23456)).toBe(1.235);
    expect(round(NaN)).toBeNull();
    expect(round(null)).toBeNull();
  });
  it("median of even and odd lists", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("days in month", () => {
    expect(daysInMonth("2024-02")).toBe(29);
    expect(daysInMonth("2026-10")).toBe(31);
  });
});

describe("computeSeries against the mock", () => {
  it("matches series-pantanal.json (months and summary)", async () => {
    const got = await computeSeries(pantanal);
    expect(SeriesResponse.safeParse(got).success).toBe(true);
    expectClose(got.months, expected.months, "months");
    expectClose(got.summary, expected.summary, "summary");
    // The mock's area is the bbox (9788 cells); the app uses the region polygon, so only the
    // warnings are compared exactly.
    expect(got.meta.warnings).toEqual(expected.meta.warnings);
    expect(got.meta.method_version).toBe("1.0");
    expect(got.meta.cell_count).toBeGreaterThan(0);
    expect(got.meta.area_km2).toBeGreaterThan(0);
  });

  it("runs a preset in under 1 s once warm", async () => {
    await computeSeries(pantanal);
    const t0 = performance.now();
    await computeSeries(pantanal);
    const ms = performance.now() - t0;
    console.log(`computeSeries(pantanal) warm: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });

  it("a cells request sums only those cells and drops cells outside the polygon", async () => {
    const cells = (
      await queryRows<{ h3_r6: string }>("SELECT DISTINCT h3_r6 FROM read_parquet($p) ORDER BY 1", {
        p: dataFile("monthly.parquet"),
      })
    ).map((r) => r.h3_r6);
    // The mock drew its 60 cells from the bbox; only some are inside the region polygon.
    const inside = cells.filter((c) => regionOfCell(c) === "pantanal");
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.length).toBeLessThan(cells.length);

    const got = await computeSeries(SeriesRequest.parse({ ...pantanal, region: null, cells }));
    expect(got.meta.cell_count).toBe(inside.length);
    expect(got.meta.warnings[0]).toBe(
      `${cells.length - inside.length} of ${cells.length} cells are outside the Brazilian Pantanal region and were left out.`,
    );
    const [{ total }] = await queryRows<{ total: number }>(
      "SELECT sum(harmonized)::DOUBLE AS total FROM read_parquet($p) WHERE month = DATE '2020-09-01' AND list_contains($c, h3_r6)",
      { p: dataFile("monthly.parquet"), c: listValue(inside) },
      { c: LIST(VARCHAR) },
    );
    const sep = got.months.find((m) => m.month === "2020-09")!;
    expect(sep.harmonized).toBeCloseTo(total, 3);
    // Region-level fields do not depend on the cells.
    expect(got.months.map((m) => [m.source, m.provisional, m.valid_days])).toEqual(
      expected.months.map((m) => [m.source, m.provisional, m.valid_days]),
    );
  });

  it("zero versus missing", async () => {
    const got = await computeSeries({ ...pantanal, start: "2001-07", end: "2005-02" });
    const nodata = got.months.find((m) => m.month === "2001-07")!;
    expect(nodata.harmonized).toBeNull();
    expect(nodata.percentile).toBeNull();
    const nofire = got.months.find((m) => m.month === "2005-02")!;
    expect(nofire.harmonized).toBe(0);
    expect(nofire.modis_raw).toBe(0);
    expect(nofire.viirs_raw).toBeNull(); // no VIIRS before 2012
    expect(nofire.source).toBe("modis");
    // Baselines come from the full record, not the window.
    const full = expected.months.find((m) => m.month === "2005-02")!;
    expect(nofire.baseline_median).toBeCloseTo(full.baseline_median!, 3);
  });

  it("clips the range to the record with a warning", async () => {
    const got = await computeSeries({ ...pantanal, start: "1999-01", end: "2030-12" });
    expect(got.months[0].month).toBe("2000-11");
    expect(got.months.at(-1)!.month).toBe("2026-10");
    expect(got.meta.warnings[0]).toBe("Requested range clipped to the record 2000-11 to 2026-10.");
  });

  it("nulls z and warns when MAD = 0", async () => {
    // The sparsest mock cell inside the polygon: most off-season baseline values are 0, so MAD is 0.
    const rows = await queryRows<{ h3_r6: string }>(
      "SELECT h3_r6 FROM read_parquet($p) GROUP BY 1 ORDER BY count(*), 1",
      { p: dataFile("monthly.parquet") },
    );
    const h3_r6 = rows.find((r) => regionOfCell(r.h3_r6) === "pantanal")!.h3_r6;
    const got = await computeSeries(SeriesRequest.parse({ ...pantanal, region: null, cells: [h3_r6] }));
    const madWarnings = got.meta.warnings.filter((w) => w.startsWith("Baseline MAD is 0"));
    expect(madWarnings.length).toBeGreaterThan(0);
    const name = madWarnings[0].match(/for (\w+);/)![1];
    const moy = new Date(`${name} 1, 2000`).getMonth() + 1;
    const m = got.months.find((x) => Number(x.month.slice(5)) === moy && x.harmonized !== null)!;
    expect(m.z).toBeNull();
  });
});

describe("POST /api/series", () => {
  it("returns the series", async () => {
    const res = await post({ region: "pantanal", cells: null, start: "2024-01", end: "2024-12" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SeriesResponse;
    expect(body.months).toHaveLength(12);
    expect(body.summary.annual).toEqual([{ year: 2024, total: expect.any(Number), rank: 1, complete: true }]);
  });

  it.each([
    ["not JSON", "{"],
    ["both cells and region", { region: "pantanal", cells: ["86a8100c7ffffff"], end: "2024-01" }],
    ["neither", { end: "2024-01" }],
    ["end before start", { region: "pantanal", start: "2024-02", end: "2024-01" }],
    ["bad month", { region: "pantanal", end: "2024-13" }],
    ["unknown region", { region: "mars", end: "2024-01" }],
    ["cells outside every region", { cells: ["862a1072fffffff"], end: "2024-01" }],
    ["an invalid H3 cell", { cells: ["fffffffffffffff"], end: "2024-01" }],
    ["a cell at another resolution", { cells: ["85a84373fffffff"], end: "2024-01" }],
  ])("400 for %s", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  it("400 for cells spanning regions", async () => {
    const { latLngToCell } = await import("h3-js");
    const cells = [latLngToCell(-18.5, -57, 6), latLngToCell(30.9, 75.8, 6)]; // Pantanal + Punjab
    const res = await post({ cells, end: "2024-01" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/span/);
  });
});
