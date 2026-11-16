import { describe, expect, it } from "vitest";
import type { WeatherValue } from "./types";
import { describeAnomaly, describeUnusual, formatMonth, formatValue } from "./wording";

function v(variable: WeatherValue["variable"], value: number | null, anomaly: number | null, unit: string): WeatherValue {
  return { variable, value, anomaly, anomaly_z: null, unit };
}

describe("describeAnomaly", () => {
  it("temperature", () => {
    expect(describeAnomaly(v("t2m_mean", 29, 2.14, "degC"))).toBe("2.1 °C warmer than normal");
    expect(describeAnomaly(v("t2m_mean", 22, -0.86, "degC"))).toBe("0.9 °C cooler than normal");
    expect(describeAnomaly(v("t2m_mean", 25, 0.02, "degC"))).toBe("about normal temperature");
  });

  it("rainfall as a percentage of normal", () => {
    // normal = 100 - (-60) = 160 mm; 60 / 160 = 37.5% -> 38%
    expect(describeAnomaly(v("precip_total", 100, -60, "mm"))).toBe("38% less rain than normal");
    expect(describeAnomaly(v("precip_total", 150, 50, "mm"))).toBe("50% more rain than normal");
  });

  it("rainfall in mm when the normal is tiny", () => {
    expect(describeAnomaly(v("precip_total", 1, -3, "mm"))).toBe("3 mm less rain than normal");
    expect(describeAnomaly(v("precip_total", 2, 0.2, "mm"))).toBe("about normal rainfall");
  });

  it("humidity and wind", () => {
    expect(describeAnomaly(v("rh2m_mean", 53, -10.7, "%"))).toBe("11 percentage points drier than normal");
    expect(describeAnomaly(v("rh2m_mean", 80, 1.2, "%"))).toBe("1 percentage point more humid than normal");
    expect(describeAnomaly(v("wind10m_mean", 3, 0.38, "m/s"))).toBe("0.4 m/s windier than normal");
    expect(describeAnomaly(v("wind10m_mean", 2, -0.5, "m/s"))).toBe("0.5 m/s calmer than normal");
  });

  it("missing anomaly", () => {
    expect(describeAnomaly(v("t2m_mean", 25, null, "degC"))).toBe("no baseline for this month");
  });
});

describe("helpers", () => {
  it("formats values and months", () => {
    expect(formatValue(v("t2m_mean", 28.92, 1, "degC"))).toBe("28.9°C");
    expect(formatValue(v("precip_total", 13.7, 1, "mm"))).toBe("14 mm");
    expect(formatValue(v("wind10m_mean", 2.95, 1, "m/s"))).toBe("3.0 m/s");
    expect(formatMonth("2020-09")).toBe("September 2020");
  });

  it("flags unusual months by z", () => {
    expect(describeUnusual(null)).toBeNull();
    expect(describeUnusual(1.5)).toBeNull();
    expect(describeUnusual(-2.4)).toBe("outside the usual range");
    expect(describeUnusual(3.1)).toBe("far outside the usual range");
  });
});
