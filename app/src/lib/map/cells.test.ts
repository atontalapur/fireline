import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/cells/route";
import { circlePolygon, presetFor, polygonToCellsR6 } from "@/lib/geo";
import { queryMonthCells, queryMonthValidDays } from "@/lib/map/cells-db";
import { CellsRequest, type CellsResponse } from "@/lib/map/cells-request";
import { cividisColor, log1pPosition } from "@/lib/map/color";

// Known values in contracts/mock/monthly.parquet (pantanal only).
const TOP_CELL = "86a85d1afffffff";
const TOP_SEP_2020 = 35.23927782682632;

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/cells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("CellsRequest", () => {
  it("accepts a region or a cell list with a month", () => {
    expect(CellsRequest.safeParse({ region: "pantanal", month: "2020-09" }).success).toBe(true);
    expect(CellsRequest.safeParse({ cells: [TOP_CELL], month: "2020-09" }).success).toBe(true);
  });

  it("rejects bad months and ambiguous areas", () => {
    expect(CellsRequest.safeParse({ region: "pantanal", month: "2020-13" }).success).toBe(false);
    expect(CellsRequest.safeParse({ region: "pantanal", month: "2020-9" }).success).toBe(false);
    expect(CellsRequest.safeParse({ region: "pantanal" }).success).toBe(false);
    expect(CellsRequest.safeParse({ month: "2020-09" }).success).toBe(false);
    expect(CellsRequest.safeParse({ region: "pantanal", cells: [TOP_CELL], month: "2020-09" }).success).toBe(false);
    expect(CellsRequest.safeParse({ cells: [], month: "2020-09" }).success).toBe(false);
    expect(CellsRequest.safeParse({ cells: ["not-a-cell"], month: "2020-09" }).success).toBe(false);
    expect(CellsRequest.safeParse({ region: "mars", month: "2020-09" }).success).toBe(false);
  });
});

describe("queryMonthCells", () => {
  it("returns every stored cell of a region-month", async () => {
    const rows = await queryMonthCells("pantanal", "2020-09", null);
    expect(rows).toHaveLength(60);
    const top = rows.reduce((a, b) => (b.harmonized > a.harmonized ? b : a));
    expect(top.h3).toBe(TOP_CELL);
    expect(top.harmonized).toBeCloseTo(TOP_SEP_2020, 9);
  });

  it("filters to the given cells", async () => {
    const rows = await queryMonthCells("pantanal", "2020-09", [TOP_CELL, "86a85d1a7ffffff"]);
    expect(rows.map((r) => r.h3)).toContain(TOP_CELL);
    expect(rows.every((r) => r.h3 === TOP_CELL || r.h3 === "86a85d1a7ffffff")).toBe(true);
  });

  it("returns nothing for a month with no fire and for other regions", async () => {
    expect(await queryMonthCells("pantanal", "2005-02", null)).toEqual([]);
    expect(await queryMonthCells("punjab", "2020-09", null)).toEqual([]);
  });
});

describe("queryMonthValidDays", () => {
  it("reads coverage_month, keeping no data apart from zero fire", async () => {
    expect(await queryMonthValidDays("pantanal", "2020-09")).toBe(30);
    expect(await queryMonthValidDays("pantanal", "2005-02")).toBe(28); // data, no fire
    expect(await queryMonthValidDays("pantanal", "2001-07")).toBe(0); // no data
    expect(await queryMonthValidDays("pantanal", "2026-10")).toBe(28); // partial month
    expect(await queryMonthValidDays("pantanal", "1999-01")).toBeNull(); // not covered
    expect(await queryMonthValidDays("punjab", "2020-09")).toBeNull(); // not in the mock
  });
});

describe("POST /api/cells", () => {
  it("serves a region-month", async () => {
    const res = await post({ region: "pantanal", month: "2020-09" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CellsResponse;
    expect(body.month).toBe("2020-09");
    expect(body.cells).toHaveLength(60);
    expect(body.max).toBeCloseTo(TOP_SEP_2020, 9);
    expect(body.valid_days).toBe(30);
  });

  it("serves a cell list, resolving its region", async () => {
    const res = await post({ cells: [TOP_CELL], month: "2020-09" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CellsResponse;
    expect(body.cells).toEqual([{ h3: TOP_CELL, harmonized: TOP_SEP_2020 }]);
    expect(body.max).toBe(TOP_SEP_2020);
  });

  it("returns empty cells and max 0 for a month without fire", async () => {
    const body = (await (await post({ region: "pantanal", month: "2005-02" })).json()) as CellsResponse;
    expect(body).toEqual({ month: "2005-02", cells: [], max: 0, valid_days: 28 });
  });

  it("marks a no-data month with valid_days 0", async () => {
    const res = await post({ region: "pantanal", month: "2001-07" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ month: "2001-07", cells: [], max: 0, valid_days: 0 });
    const byCells = (await (await post({ cells: [TOP_CELL], month: "2001-07" })).json()) as CellsResponse;
    expect(byCells.valid_days).toBe(0);
  });

  it("rejects invalid bodies with 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ region: "pantanal", month: "2020-13" })).status).toBe(400);
    expect((await post({ month: "2020-09" })).status).toBe(400);
  });

  it("rejects cells entirely outside coverage or spanning regions, drops partly outside cells", async () => {
    const nowhere = polygonToCellsR6(circlePolygon(0, 0, 20))[0];
    const outside = await post({ cells: [nowhere], month: "2020-09" });
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/outside every supported region/);
    // Cells outside coverage are dropped when the rest sit in one region, as in /api/series.
    const partly = await post({ cells: [TOP_CELL, nowhere], month: "2020-09" });
    expect(partly.status).toBe(200);
    expect(((await partly.json()) as CellsResponse).cells.map((c) => c.h3)).toEqual([TOP_CELL]);
    const punjab = polygonToCellsR6(presetFor("punjab").geometry)[0];
    const res = await post({ cells: [TOP_CELL, punjab], month: "2020-09" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/more than one region/);
  });
});

describe("cividis log1p scale", () => {
  it("maps 0 to the low end and max to the high end", () => {
    expect(log1pPosition(0, 10)).toBe(0);
    expect(log1pPosition(10, 10)).toBe(1);
    expect(log1pPosition(5, 0)).toBe(0);
    const mid = log1pPosition(3, 10);
    expect(mid).toBeCloseTo(Math.log1p(3) / Math.log1p(10), 12);
    const lo = cividisColor(0, 10);
    const hi = cividisColor(10, 10);
    expect(lo.every(Number.isInteger)).toBe(true);
    expect(lo[3]).toBe(180);
    // cividis runs dark blue -> yellow
    expect(hi[0] + hi[1]).toBeGreaterThan(lo[0] + lo[1]);
  });
});
