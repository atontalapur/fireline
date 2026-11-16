// Plain-language anomaly text for the weather panel. Pure; safe on client and server.
import type { WeatherValue, WeatherVariable } from "./types";

export const WEATHER_LABELS: Record<WeatherVariable, string> = {
  t2m_mean: "Temperature",
  rh2m_mean: "Humidity",
  wind10m_mean: "Wind",
  precip_total: "Rainfall",
};

// Below this monthly normal (mm) a percentage change is noise, so rain is described in mm.
const MIN_RAIN_FOR_PERCENT_MM = 5;

export function formatUnit(unit: string): string {
  return unit === "degC" ? "°C" : unit;
}

export function formatValue(v: WeatherValue): string {
  if (v.value === null) return "no data";
  const digits = v.variable === "precip_total" || v.variable === "rh2m_mean" ? 0 : 1;
  const unit = formatUnit(v.unit);
  return `${v.value.toFixed(digits)}${unit === "%" || unit === "°C" ? "" : " "}${unit}`;
}

// "2.1 °C warmer than normal", "38% less rain than normal", "about normal".
export function describeAnomaly(v: WeatherValue): string {
  const a = v.anomaly;
  if (a === null || v.value === null) return "no baseline for this month";

  if (v.variable === "precip_total") {
    const normal = v.value - a;
    if (normal >= MIN_RAIN_FOR_PERCENT_MM) {
      const pct = Math.round((Math.abs(a) / normal) * 100);
      if (pct === 0) return "about normal rainfall";
      return `${pct}% ${a > 0 ? "more" : "less"} rain than normal`;
    }
    const mm = Math.round(Math.abs(a));
    if (mm === 0) return "about normal rainfall";
    return `${mm} mm ${a > 0 ? "more" : "less"} rain than normal`;
  }

  if (v.variable === "rh2m_mean") {
    const pts = Math.round(Math.abs(a));
    if (pts === 0) return "about normal humidity";
    return `${pts} percentage ${pts === 1 ? "point" : "points"} ${a > 0 ? "more humid" : "drier"} than normal`;
  }

  const mag = Math.abs(a).toFixed(1);
  if (mag === "0.0") return v.variable === "t2m_mean" ? "about normal temperature" : "about normal wind";
  if (v.variable === "t2m_mean") return `${mag} °C ${a > 0 ? "warmer" : "cooler"} than normal`;
  return `${mag} m/s ${a > 0 ? "windier" : "calmer"} than normal`;
}

// Extra note when the month sits well outside the baseline spread.
export function describeUnusual(z: number | null): string | null {
  if (z === null || Math.abs(z) < 2) return null;
  return Math.abs(z) >= 3 ? "far outside the usual range" : "outside the usual range";
}

// "2020-09" -> "September 2020"
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
