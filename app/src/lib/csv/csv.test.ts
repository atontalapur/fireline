import { describe, expect, it } from "vitest";
import type { SeriesResponse } from "@/lib/contracts";
import {
  ANALYTICS_COLUMNS,
  BOM,
  HOTSPOT_COLUMNS,
  analyticsCsv,
  csvField,
  csvFilename,
  headerComment,
} from "@/lib/csv/format";
import { nextMonthStart } from "@/lib/csv/hotspots";
import { requestFromSearchParams } from "@/lib/csv/request";
import { GET as analyticsGET, POST as analyticsPOST } from "@/app/api/analytics.csv/route";
import { GET as hotspotsGET, POST as hotspotsPOST } from "@/app/api/hotspots.csv/route";

// Response.text() and TextDecoder drop the BOM, so it is checked on the raw bytes separately.
const HEADER =
  /^# Fireline method v1\.0 · sources: NASA FIRMS MODIS C6\.1, VIIRS 375 m · generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function lines(text: string): string[] {
  return text.split("\r\n").filter((l) => l !== "");
}

describe("csv formatting", () => {
  it("header comment", () => {
    expect(headerComment(new Date("2026-11-15T04:30:12.345Z"))).toBe(
      "# Fireline method v1.0 · sources: NASA FIRMS MODIS C6.1, VIIRS 375 m · generated 2026-11-15T04:30:12Z",
    );
  });

  it("fields", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(NaN)).toBe("");
    expect(csvField(1.5)).toBe("1.5");
    expect(csvField(-0.25)).toBe("-0.25");
    expect(csvField(true)).toBe("true");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("filenames", () => {
    expect(csvFilename({ region: "pantanal", start: "2000-11", end: "2026-10" }, "analytics")).toBe(
      "fireline_pantanal_2000-11_2026-10_analytics.csv",
    );
    expect(csvFilename({ region: null, start: "2024-01", end: "2024-12" }, "hotspots")).toBe(
      "fireline_area_2024-01_2024-12_hotspots.csv",
    );
  });

  it("analytics rows: nulls empty, booleans as true/false", () => {
    const series = {
      months: [
        {
          month: "2001-07", harmonized: null, lo: null, hi: null, modis_raw: null, viirs_raw: null,
          source: "terra_scaled", provisional: false, valid_days: 0, baseline_median: 1.5,
          baseline_mean: 2.25, z: null, percentile: null,
        },
        {
          month: "2026-10", harmonized: 99.253, lo: 90.1, hi: 101.2, modis_raw: 80, viirs_raw: 300.5,
          source: "viirs_scaled", provisional: true, valid_days: 28, baseline_median: 127,
          baseline_mean: 130.5, z: -0.814, percentile: 20,
        },
      ],
    } as unknown as SeriesResponse;
    const out = lines(analyticsCsv(series, new Date("2026-11-15T00:00:00Z")));
    expect(out[0].startsWith(BOM + "# Fireline")).toBe(true);
    expect(out[1]).toBe(ANALYTICS_COLUMNS.join(","));
    expect(out[2]).toBe("2001-07,,,,,,1.5,2.25,,,terra_scaled,false");
    expect(out[3]).toBe("2026-10,99.253,90.1,101.2,80,300.5,127,130.5,-0.814,20,viirs_scaled,true");
  });

  it("GET params", () => {
    expect(
      requestFromSearchParams(new URLSearchParams("cells=86a8100c7ffffff, 86a8100cfffffff&start=2024-01&end=2024-12&baseline=2003,2022")),
    ).toEqual({ cells: ["86a8100c7ffffff", "86a8100cfffffff"], start: "2024-01", end: "2024-12", baseline: [2003, 2022] });
    expect(requestFromSearchParams(new URLSearchParams("region=pantanal&end=2024-12"))).toEqual({
      region: "pantanal",
      end: "2024-12",
    });
  });

  it("next month start", () => {
    expect(nextMonthStart("2024-12")).toBe("2025-01-01");
    expect(nextMonthStart("2024-02")).toBe("2024-03-01");
  });
});

const body = { region: "pantanal", cells: null, start: "2020-01", end: "2020-12", baseline: [2003, 2022] };

describe("/api/analytics.csv", () => {
  it("POST JSON", async () => {
    const res = await analyticsPOST(
      new Request("http://localhost/api/analytics.csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fireline_pantanal_2020-01_2020-12_analytics.csv"',
    );
    const out = lines(await res.text());
    expect(out[0]).toMatch(HEADER);
    expect(out[1]).toBe(ANALYTICS_COLUMNS.join(","));
    expect(out).toHaveLength(2 + 12);
    expect(out[2].startsWith("2020-01,")).toBe(true);
    expect(out[2].split(",")).toHaveLength(ANALYTICS_COLUMNS.length);
  });

  it("POST form field `request`", async () => {
    const form = new URLSearchParams({ request: JSON.stringify(body) });
    const res = await analyticsPOST(
      new Request("http://localhost/api/analytics.csv", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x23]); // BOM then "#"
    expect(lines(new TextDecoder().decode(bytes))).toHaveLength(14);
  });

  it("GET query params", async () => {
    const res = await analyticsGET(new Request("http://localhost/api/analytics.csv?region=pantanal&start=2024-01&end=2024-03"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("fireline_pantanal_2024-01_2024-03_analytics.csv");
    expect(lines(await res.text())).toHaveLength(5);
  });

  it("400 on bad input", async () => {
    const res = await analyticsGET(new Request("http://localhost/api/analytics.csv?region=pantanal"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/end/);
    const form = await analyticsPOST(
      new Request("http://localhost/api/analytics.csv", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "request=nope",
      }),
    );
    expect(form.status).toBe(400);
  });
});

describe("/api/hotspots.csv", () => {
  it("streams detections with k for VIIRS months after the switch", async () => {
    const res = await hotspotsPOST(
      new Request("http://localhost/api/hotspots.csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fireline_pantanal_2020-01_2020-12_hotspots.csv"',
    );
    expect(res.body).toBeInstanceOf(ReadableStream);
    const out = lines(await res.text());
    expect(out[0]).toMatch(HEADER);
    expect(out[1]).toBe(HOTSPOT_COLUMNS.join(","));
    const rows = out.slice(2).map((l) => l.split(","));
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) {
      expect(r).toHaveLength(HOTSPOT_COLUMNS.length);
      const [date, time, local, lat, lon, sensor, product, confidence, , daynight, h3, k] = r;
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(time).toMatch(/^\d{2}:\d{2}$/);
      expect(local >= "2020-01-01" && local < "2021-01-01").toBe(true);
      expect(Number(lat)).toBeLessThan(0);
      expect(Number(lon)).toBeLessThan(0);
      expect(["SP", "NRT"]).toContain(product);
      expect(["nominal", "high"]).toContain(confidence);
      expect(["D", "N"]).toContain(daynight);
      expect(h3).toMatch(/^[0-9a-f]{15}$/);
      if (sensor.startsWith("VIIRS")) expect(Number(k)).toBeGreaterThan(0);
      else expect(k).toBe("");
    }
  });

  it("streams in more than one chunk for the full record", async () => {
    const res = await hotspotsGET(new Request("http://localhost/api/hotspots.csv?region=pantanal&start=2000-11&end=2026-10"));
    const reader = res.body!.getReader();
    let chunks = 0;
    let text = "";
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      text += dec.decode(value, { stream: true });
    }
    expect(chunks).toBeGreaterThan(2); // header + at least two 2048-row chunks (mock has ~5000 rows)
    expect(lines(text).length - 2).toBeGreaterThan(4000);
  });

  it("filters by cells", async () => {
    const all = lines(
      await (await hotspotsGET(new Request("http://localhost/api/hotspots.csv?region=pantanal&start=2020-01&end=2020-12"))).text(),
    ).slice(2);
    const cell = all[0].split(",")[10];
    const res = await hotspotsGET(
      new Request(`http://localhost/api/hotspots.csv?cells=${cell}&start=2020-01&end=2020-12`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("fireline_area_2020-01_2020-12_hotspots.csv");
    const rows = lines(await res.text()).slice(2);
    expect(rows.length).toBe(all.filter((l) => l.split(",")[10] === cell).length);
  });

  it("404 when the region has no hotspot file", async () => {
    const res = await hotspotsGET(new Request("http://localhost/api/hotspots.csv?region=punjab&end=2024-01"));
    expect(res.status).toBe(404);
  });
});
