import { afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { WeatherResponse } from "@/lib/weather/types";
import { GET } from "./route";

const MOCK_DIR = path.resolve(__dirname, "../../../../../contracts/mock");

function get(query: string) {
  return GET(new Request(`http://localhost/api/weather?${query}`));
}

beforeAll(() => {
  process.env.APP_DATA_DIR = MOCK_DIR;
});

afterEach(() => {
  process.env.APP_DATA_DIR = MOCK_DIR;
});

describe("GET /api/weather", () => {
  it("returns the four variables for a region-month", async () => {
    const res = await get("region=pantanal&month=2020-09");
    expect(res.status).toBe(200);
    const body = WeatherResponse.parse(await res.json());
    expect(body.month).toBe("2020-09");
    expect(body.region).toBe("pantanal");
    expect(body.variables.map((v) => v.variable)).toEqual([
      "t2m_mean",
      "rh2m_mean",
      "wind10m_mean",
      "precip_total",
    ]);
    expect(body.source).toBe("Open-Meteo (ERA5)");
    expect(body.license).toBe("CC BY 4.0");
    const byVar = Object.fromEntries(body.variables.map((v) => [v.variable, v]));
    expect(byVar.t2m_mean.unit).toBe("degC");
    // The mock has a hot, dry spell in 2020-08..10.
    expect(byVar.t2m_mean.anomaly).toBeGreaterThan(0);
    expect(byVar.rh2m_mean.anomaly).toBeLessThan(0);
    expect(byVar.precip_total.anomaly).toBeLessThan(0);
    expect(byVar.precip_total.anomaly_z).toBeLessThan(-1);
  });

  it("defaults to the latest month", async () => {
    const res = await get("region=pantanal");
    expect(res.status).toBe(200);
    const body = WeatherResponse.parse(await res.json());
    expect(body.month).toBe("2026-10");
    expect(body.variables).toHaveLength(4);
  });

  it("404s for a month outside the file", async () => {
    const res = await get("region=pantanal&month=1999-01");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no weather data/);
  });

  it("404s for a region with no rows", async () => {
    const res = await get("region=punjab&month=2020-09");
    expect(res.status).toBe(404);
  });

  it("404s when weather.parquet is absent", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "weather-empty-"));
    process.env.APP_DATA_DIR = empty;
    try {
      const res = await get("region=pantanal&month=2020-09");
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty("error");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("400s on bad input", async () => {
    expect((await get("region=atlantis&month=2020-09")).status).toBe(400);
    expect((await get("region=pantanal&month=2020-13")).status).toBe(400);
    expect((await get("month=2020-09")).status).toBe(400);
  });
});
