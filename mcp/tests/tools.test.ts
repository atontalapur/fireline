import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/client.js";
import { createServer } from "../src/server.js";
import { RECENT_MONTHS, summarizeSeries } from "../src/tools.js";

const BASE = "http://fireline.test";

type Call = { url: string; init: RequestInit | undefined; body: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<FetchLike>(async (url, init) => {
    const call = { url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  });
  const server = createServer({ baseUrl: `${BASE}/`, fetch: fetchMock });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, server, calls, fetchMock, call };
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

function makeSeries(n: number) {
  const months = Array.from({ length: n }, (_, i) => {
    const y = 2001 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, "0");
    return {
      month: `${y}-${m}`,
      harmonized: i,
      lo: i - 1,
      hi: i + 1,
      modis_raw: i,
      viirs_raw: null,
      source: "modis",
      provisional: false,
      valid_days: 30,
      baseline_median: 5,
      baseline_mean: 6,
      z: 0.1,
      percentile: 50,
    };
  });
  return {
    months,
    summary: {
      current: {
        month: months[n - 1]!.month,
        harmonized: n - 1,
        baseline_median: 5,
        ratio_to_median: 2,
        z: 1,
        percentile: 90,
        provisional: true,
        partial: false,
      },
      peak_month_of_year: 9,
      peak_year: 2020,
      annual: [{ year: 2020, total: 1000, rank: 1, complete: true }],
    },
    meta: { method_version: "1.0", area_km2: 150000, cell_count: 4000, warnings: [] },
  };
}

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.client.close();
  ctx = undefined;
});

describe("tool listing", () => {
  it("lists the four tools with object input schemas", async () => {
    ctx = await setup(() => jsonResponse(200, {}));
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_to_baseline",
      "export_csv",
      "get_series",
      "resolve_area",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
    const series = tools.find((t) => t.name === "get_series")!;
    expect(Object.keys(series.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["cells", "region", "start", "end", "baseline", "full"]),
    );
    expect(series.description).toMatch(/MODIS-equivalent fire cell-days/);
    expect(series.description).toMatch(/Pantanal/);
  });
});

describe("forwarding", () => {
  it("resolve_area posts the name to /api/tools/resolve_area", async () => {
    const out = { label: "Pantanal", region: "pantanal", cells: [], area_km2: 150000, warnings: [] };
    ctx = await setup(() => jsonResponse(200, out));
    const res = await ctx.call("resolve_area", { name: "Pantanal" });
    expect(res.isError).toBeFalsy();
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.url).toBe(`${BASE}/api/tools/resolve_area`);
    expect(ctx.calls[0]!.init?.method).toBe("POST");
    expect(new Headers(ctx.calls[0]!.init?.headers).get("content-type")).toBe("application/json");
    expect(ctx.calls[0]!.body).toEqual({ name: "Pantanal" });
    expect(res.structuredContent).toEqual(out);
    expect(JSON.parse(text(res))).toMatchObject({ label: "Pantanal", region: "pantanal" });
  });

  it("resolve_area posts a polygon", async () => {
    const polygon = {
      type: "Polygon",
      coordinates: [[[-57, -18], [-56, -18], [-56, -17], [-57, -18]]],
    };
    ctx = await setup(() =>
      jsonResponse(200, { label: "Drawn area", region: null, cells: ["86a8100c7ffffff"], area_km2: 36, warnings: [] }),
    );
    const res = await ctx.call("resolve_area", { polygon });
    expect(ctx.calls[0]!.body).toEqual({ polygon });
    expect(JSON.parse(text(res)).cells).toEqual(["86a8100c7ffffff"]);
  });

  it("resolve_area rejects both or neither of name/polygon without calling the API", async () => {
    ctx = await setup(() => jsonResponse(200, {}));
    const res = await ctx.call("resolve_area", {});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/exactly one of 'name' or 'polygon'/);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("resolve_area summarizes very large cell lists in the text", async () => {
    const cells = Array.from({ length: 5000 }, (_, i) => `cell${i}`);
    ctx = await setup(() =>
      jsonResponse(200, { label: "Big", region: "w_canada", cells, area_km2: 1, warnings: [] }),
    );
    const res = await ctx.call("resolve_area", { name: "Alberta" });
    const view = JSON.parse(text(res));
    expect(view.cell_count).toBe(5000);
    expect(typeof view.cells).toBe("string");
    expect(view.note).toMatch(/w_canada/);
    expect(res.structuredContent).toBeUndefined();
  });

  it("get_series forwards the input without `full` and returns a compact summary", async () => {
    const series = makeSeries(60);
    ctx = await setup(() => jsonResponse(200, series));
    const res = await ctx.call("get_series", {
      region: "pantanal",
      start: "2001-01",
      end: "2005-12",
      baseline: [2003, 2022],
    });
    expect(ctx.calls[0]!.url).toBe(`${BASE}/api/tools/get_series`);
    expect(ctx.calls[0]!.body).toEqual({
      region: "pantanal",
      start: "2001-01",
      end: "2005-12",
      baseline: [2003, 2022],
    });
    const view = JSON.parse(text(res));
    expect(view.months).toHaveLength(RECENT_MONTHS);
    expect(view.months[RECENT_MONTHS - 1].month).toBe("2005-12");
    expect(view.months[0]).not.toHaveProperty("modis_raw");
    expect(view.summary.annual).toEqual(series.summary.annual);
    expect(view.meta).toEqual(series.meta);
    expect(view.range).toEqual({ first: "2001-01", last: "2005-12", months: 60 });
    expect(res.structuredContent).toBeUndefined();
    const fullRes = await ctx.call("get_series", { region: "pantanal", full: true });
    expect(fullRes.structuredContent).toEqual(series);
  });

  it("get_series with full: true lists every month and does not forward `full`", async () => {
    ctx = await setup(() => jsonResponse(200, makeSeries(60)));
    const res = await ctx.call("get_series", { region: "punjab", full: true });
    expect(ctx.calls[0]!.body).toEqual({ region: "punjab" });
    expect(JSON.parse(text(res)).months).toHaveLength(60);
  });

  it("get_series requires exactly one of region or cells", async () => {
    ctx = await setup(() => jsonResponse(200, {}));
    const both = await ctx.call("get_series", { region: "pantanal", cells: ["a"] });
    const neither = await ctx.call("get_series", {});
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("get_series rejects a bad month format before calling the API", async () => {
    ctx = await setup(() => jsonResponse(200, {}));
    const res = await ctx.call("get_series", { region: "pantanal", start: "2020-13" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/YYYY-MM/);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("compare_to_baseline forwards a month query", async () => {
    const out = {
      period: "2020-09",
      value: 80000,
      median: 20000,
      ratio: 4,
      z: 3.1,
      percentile: 100,
      rank: 1,
      of: 26,
      provisional: false,
      warnings: [],
    };
    ctx = await setup(() => jsonResponse(200, out));
    const res = await ctx.call("compare_to_baseline", { region: "pantanal", month: "2020-09" });
    expect(ctx.calls[0]!.url).toBe(`${BASE}/api/tools/compare_to_baseline`);
    expect(ctx.calls[0]!.body).toEqual({ region: "pantanal", month: "2020-09" });
    expect(JSON.parse(text(res))).toEqual(out);
    expect(res.structuredContent).toEqual(out);
  });

  it("compare_to_baseline forwards a year query with cells", async () => {
    ctx = await setup(() => jsonResponse(200, { period: "2021", of: 25, warnings: [] }));
    await ctx.call("compare_to_baseline", { cells: ["86a8100c7ffffff"], year: 2021 });
    expect(ctx.calls[0]!.body).toEqual({ cells: ["86a8100c7ffffff"], year: 2021 });
  });

  it("compare_to_baseline requires exactly one of month or year", async () => {
    ctx = await setup(() => jsonResponse(200, {}));
    const res = await ctx.call("compare_to_baseline", { region: "pantanal", month: "2020-09", year: 2020 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/exactly one of 'month'/);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("export_csv forwards and makes a relative url absolute", async () => {
    ctx = await setup(() =>
      jsonResponse(200, { url: "/api/export?region=w_canada", method: "GET" }),
    );
    const res = await ctx.call("export_csv", { region: "w_canada", start: "2015-01" });
    expect(ctx.calls[0]!.url).toBe(`${BASE}/api/tools/export_csv`);
    expect(ctx.calls[0]!.body).toEqual({ region: "w_canada", start: "2015-01" });
    expect(JSON.parse(text(res))).toEqual({
      url: `${BASE}/api/export?region=w_canada`,
      method: "GET",
    });
  });
});

describe("error mapping", () => {
  it("maps a 400 {error} to a tool error with the message", async () => {
    ctx = await setup(() => jsonResponse(400, { error: "cells outside every region" }));
    const res = await ctx.call("get_series", { cells: ["86a8100c7ffffff"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Fireline API error 400 for get_series: cells outside every region");
  });

  it("maps a 404 to an unknown-tool error", async () => {
    ctx = await setup(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));
    const res = await ctx.call("export_csv", { region: "punjab" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/404: tool 'export_csv' not found at http:\/\/fireline\.test/);
  });

  it("maps a 500 with a non-JSON body", async () => {
    ctx = await setup(() => new Response("upstream exploded", { status: 500 }));
    const res = await ctx.call("compare_to_baseline", { region: "punjab", year: 2019 });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Fireline API error 500 for compare_to_baseline: upstream exploded");
  });

  it("maps a network failure without crashing the server", async () => {
    ctx = await setup(() => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3000") });
    });
    const res = await ctx.call("resolve_area", { name: "Pantanal" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Could not reach the Fireline API at http:\/\/fireline\.test: fetch failed/);
    expect(text(res)).toMatch(/ECONNREFUSED/);
    // The server keeps serving after the failure.
    const { tools } = await ctx.client.listTools();
    expect(tools).toHaveLength(4);
  });

  it("maps a 200 with a non-JSON body", async () => {
    ctx = await setup(() => new Response("<html>", { status: 200 }));
    const res = await ctx.call("resolve_area", { name: "Pantanal" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/non-JSON response/);
  });
});

describe("summarizeSeries", () => {
  it("handles an empty series", () => {
    const view = JSON.parse(summarizeSeries({ months: [], summary: {}, meta: {} }));
    expect(view.months).toEqual([]);
    expect(view.range).toEqual({ months: 0 });
  });
});
