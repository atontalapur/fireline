import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeriesResponse } from "@/lib/contracts";
import { compareToBaseline, exportCsv, fireTools, getSeries, resolveArea } from "@/lib/fire-tools";
import { presetKeyFor } from "@/lib/fire-tools/area";
import { SeriesError } from "@/lib/series/area";
import { POST } from "@/app/api/tools/[name]/route";

const expected = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "..", "contracts", "mock", "series-pantanal.json"), "utf8"),
) as SeriesResponse;

// Central Pantanal, inside the region polygon.
const PANTANAL_VIEWPORT = { northeast: { lat: -17.6, lng: -56.6 }, southwest: { lat: -18.0, lng: -57.0 } };

function geocodeReply(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolve_area", () => {
  it.each([
    ["Pantanal", "pantanal"],
    ["  brazilian PANTANAL ", "pantanal"],
    ["Western Canada", "w_canada"],
    ["BC", "w_canada"],
    ["Alberta", "w_canada"],
    ["punjab", "punjab"],
    ["Cuiaba", null],
  ])("preset lookup %s", (name, key) => {
    expect(presetKeyFor(name)).toBe(key);
  });

  it("presets resolve without geocoding", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const out = await resolveArea.execute({ name: "Pantanal" });
    expect(out).toMatchObject({ label: "Brazilian Pantanal", region: "pantanal", cells: [], warnings: [] });
    expect(out.area_km2).toBeGreaterThan(100_000);
    const ab = await resolveArea.execute({ name: "alberta" });
    expect(ab.region).toBe("w_canada");
    expect(ab.warnings[0]).toMatch(/both provinces/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("geocodes other names: viewport to cells", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "test-key");
    const fetch = geocodeReply({
      status: "OK",
      results: [{ formatted_address: "Somewhere, MT, Brazil", geometry: { location: { lat: -17.8, lng: -56.8 }, viewport: PANTANAL_VIEWPORT } }],
    });
    vi.stubGlobal("fetch", fetch);
    const out = await resolveArea.execute({ name: "Somewhere" });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("address=Somewhere&key=test-key");
    expect(out.label).toBe("Somewhere, MT, Brazil");
    expect(out.region).toBeNull();
    expect(out.cells.length).toBeGreaterThan(20);
    expect(out.area_km2).toBeGreaterThan(1000);
    expect(out.warnings).toEqual([]);
  });

  it("warns when the place is outside the covered regions", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "k");
    vi.stubGlobal(
      "fetch",
      geocodeReply({
        status: "OK",
        results: [{ formatted_address: "Paris, France", geometry: { location: { lat: 48.8566, lng: 2.3522 }, viewport: { northeast: { lat: 48.9, lng: 2.47 }, southwest: { lat: 48.81, lng: 2.22 } } } }],
      }),
    );
    const out = await resolveArea.execute({ name: "Paris" });
    expect(out.cells.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toMatch(/outside the covered regions/);
  });

  it("a town smaller than a cell falls back to the cell at its location", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "k");
    vi.stubGlobal(
      "fetch",
      geocodeReply({
        status: "OK",
        results: [{ formatted_address: "Tiny", geometry: { location: { lat: -17.8, lng: -56.8 }, viewport: { northeast: { lat: -17.799, lng: -56.799 }, southwest: { lat: -17.801, lng: -56.801 } } } }],
      }),
    );
    const out = await resolveArea.execute({ name: "Tiny" });
    expect(out.cells).toHaveLength(1);
  });

  it("errors: no key, no result, huge area", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "");
    await expect(resolveArea.execute({ name: "Cuiaba" })).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "k");
    vi.stubGlobal("fetch", geocodeReply({ status: "ZERO_RESULTS", results: [] }));
    await expect(resolveArea.execute({ name: "Nowhere" })).rejects.toMatchObject({ status: 404 });
    vi.stubGlobal(
      "fetch",
      geocodeReply({
        status: "OK",
        results: [{ formatted_address: "Russia", geometry: { location: { lat: 61, lng: 105 }, viewport: { northeast: { lat: 82, lng: 180 }, southwest: { lat: 41, lng: 19 } } } }],
      }),
    );
    await expect(resolveArea.execute({ name: "Russia" })).rejects.toBeInstanceOf(SeriesError);
  });

  it("polygon input", async () => {
    const [s, w, n, e] = [-18.0, -57.0, -17.6, -56.6];
    const out = await resolveArea.execute({
      polygon: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    });
    expect(out.label).toBe("Drawn area");
    expect(out.cells.length).toBeGreaterThan(20);
    expect(out.warnings).toEqual([]);
  });
});

describe("get_series", () => {
  it("region over the full record matches the mock series", async () => {
    const out = await getSeries.execute({ region: "pantanal" });
    expect(out.months).toHaveLength(expected.months.length);
    expect(out.summary.peak_year).toBe(expected.summary.peak_year);
    expect(out.summary.current.harmonized).toBeCloseTo(expected.summary.current.harmonized!, 3);
  });

  it("accepts a preset name and a range", async () => {
    const out = await getSeries.execute({ region: "Pantanal", start: "2024-01", end: "2024-12" });
    expect(out.months.map((m) => m.month)).toEqual(Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}`));
  });

  it("cells from resolve_area", async () => {
    const area = await resolveArea.execute({
      polygon: { type: "Polygon", coordinates: [[[-57, -18], [-56.6, -18], [-56.6, -17.6], [-57, -17.6], [-57, -18]]] },
    });
    const out = await getSeries.execute({ cells: area.cells, start: "2020-01", end: "2020-12" });
    expect(out.meta.cell_count).toBe(area.cells.length);
  });

  it("rejects unknown regions and missing area", async () => {
    await expect(getSeries.execute({ region: "mars" })).rejects.toMatchObject({ status: 400 });
    await expect(getSeries.execute({})).rejects.toMatchObject({ status: 400 });
  });
});

describe("compare_to_baseline", () => {
  it("month: values from the series, rank among the same calendar month", async () => {
    const out = await compareToBaseline.execute({ region: "pantanal", month: "2020-09" });
    const m = expected.months.find((x) => x.month === "2020-09")!;
    expect(out.period).toBe("2020-09");
    expect(out.value).toBeCloseTo(m.harmonized!, 3);
    expect(out.median).toBeCloseTo(m.baseline_median!, 3);
    expect(out.z).toBeCloseTo(m.z!, 3);
    expect(out.percentile).toBe(m.percentile);
    expect(out.ratio).toBeCloseTo(m.harmonized! / m.baseline_median!, 2);
    const septs = expected.months.filter((x) => x.month.endsWith("-09") && x.harmonized !== null);
    expect(out.of).toBe(septs.length);
    expect(out.rank).toBe(1 + septs.filter((x) => x.harmonized! > m.harmonized!).length);
    expect(out.provisional).toBe(false);
  });

  it("month: provisional and partial current month", async () => {
    const out = await compareToBaseline.execute({ region: "pantanal", month: "2026-10" });
    expect(out.provisional).toBe(true);
    expect(out.value).not.toBeNull();
    expect(out.median).not.toBeNull();
    // 28 of 31 days: no comparison with the full-month baseline.
    expect([out.ratio, out.z, out.percentile, out.rank]).toEqual([null, null, null, null]);
    expect(out.warnings.join(" ")).toMatch(/partial/);
    expect(out.warnings.join(" ")).toMatch(/provisional/);
  });

  it("month: no-data month and out-of-record month", async () => {
    const out = await compareToBaseline.execute({ region: "pantanal", month: "2001-07" });
    expect(out.value).toBeNull();
    expect(out.rank).toBeNull();
    expect(out.warnings[0]).toMatch(/no satellite data/);
    await expect(compareToBaseline.execute({ region: "pantanal", month: "1999-01" })).rejects.toMatchObject({ status: 400 });
  });

  it("year: annual total and rank", async () => {
    const out = await compareToBaseline.execute({ region: "pantanal", year: 2020 });
    const a = expected.summary.annual.find((x) => x.year === 2020)!;
    expect(out.period).toBe("2020");
    expect(out.value).toBeCloseTo(a.total, 3);
    expect(out.rank).toBe(1);
    expect(out.of).toBe(expected.summary.annual.filter((x) => x.complete).length);
    expect(out.ratio).toBeGreaterThan(1);
    expect(out.z).toBeGreaterThan(0);
    expect(out.percentile).toBe(97.5); // 2020 is itself a baseline year: (19 + 0.5) / 20
  });

  it("year: incomplete year is not ranked", async () => {
    const out = await compareToBaseline.execute({ region: "pantanal", year: 2026 });
    expect(out.rank).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/incomplete/);
  });
});

describe("export_csv", () => {
  it("GET URL, relative without PUBLIC_BASE_URL", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    const out = await exportCsv.execute({ region: "pantanal", start: "2020-01" });
    expect(out).toEqual({ url: "/api/analytics.csv?region=pantanal&start=2020-01&end=2026-10&baseline=2003,2022", method: "GET" });
  });

  it("absolute URL with PUBLIC_BASE_URL; the URL works against the route", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://fireline.example/");
    const out = await exportCsv.execute({ region: "pantanal", start: "2024-01", end: "2024-02" });
    expect(out.url).toBe("https://fireline.example/api/analytics.csv?region=pantanal&start=2024-01&end=2024-02&baseline=2003,2022");
    const { GET } = await import("@/app/api/analytics.csv/route");
    const res = await GET(new Request(out.url));
    expect(res.status).toBe(200);
    expect((await res.text()).split("\r\n").filter(Boolean)).toHaveLength(4);
  });

  it("falls back to POST for long cell lists", async () => {
    const area = await resolveArea.execute({
      polygon: { type: "Polygon", coordinates: [[[-58, -19], [-56, -19], [-56, -17], [-58, -17], [-58, -19]]] },
    });
    expect(area.cells.length).toBeGreaterThan(600);
    const out = await exportCsv.execute({ cells: area.cells, end: "2024-12" });
    expect(out.method).toBe("POST");
    expect(out.url).toMatch(/\/api\/analytics\.csv$/);
    expect(out.body).toMatchObject({ cells: area.cells, start: "2000-11", end: "2024-12" });
  });
});

describe("POST /api/tools/[name]", () => {
  const call = (name: string, body: unknown) =>
    POST(
      new Request(`http://localhost/api/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ name }) },
    );

  it("runs a tool", async () => {
    const res = await call("compare_to_baseline", { region: "pantanal", year: 2020 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rank: number }).rank).toBe(1);
  });

  it("404 for an unknown tool", async () => {
    expect((await call("drop_tables", {})).status).toBe(404);
    expect((await call("toString", {})).status).toBe(404);
  });

  it("400 for schema errors and bad input", async () => {
    const res = await call("get_series", { start: "June" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/start/);
    expect((await call("get_series", { region: "mars" })).status).toBe(400);
    // Without `end`, resolveArea used to run before validation and throw a 500 on a bad cell.
    expect((await call("get_series", { cells: ["fffffffffffffff"] })).status).toBe(400);
  });

  it("every tool is reachable", () => {
    expect(Object.keys(fireTools)).toEqual(["resolve_area", "get_series", "compare_to_baseline", "export_csv"]);
  });
});
