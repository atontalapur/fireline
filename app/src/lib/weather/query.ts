import { access } from "node:fs/promises";
import { dataFile } from "@/lib/data-dir";
import type { RegionKey } from "@/lib/contracts";
import { queryRows } from "@/lib/series/db";
import { WEATHER_VARIABLES, WeatherVariable, type WeatherResponse } from "./types";

export const WEATHER_FILE = "weather.parquet";

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Weather for one region-month, or the region's latest month when `month` is null.
// Returns null when the file is absent or has no rows for the region-month.
export async function getWeather(
  region: RegionKey,
  month: string | null,
): Promise<WeatherResponse | null> {
  const file = dataFile(WEATHER_FILE);
  try {
    await access(file);
  } catch {
    return null;
  }

  const src = `read_parquet(${sqlString(file)})`;
  const monthFilter =
    month === null
      ? `month = (SELECT max(month) FROM ${src} WHERE region = $region)`
      : `strftime(month, '%Y-%m') = $month`;
  const rows = await queryRows(
    `SELECT strftime(month, '%Y-%m') AS month, variable, value, anomaly, anomaly_z, unit, source, license
     FROM ${src}
     WHERE region = $region AND ${monthFilter}`,
    month === null ? { region } : { region, month },
  );
  if (rows.length === 0) return null;

  const variables = WEATHER_VARIABLES.flatMap((key) => {
    const row = rows.find((r) => r.variable === key);
    if (!row) return [];
    return [
      {
        variable: WeatherVariable.parse(key),
        value: num(row.value),
        anomaly: num(row.anomaly),
        anomaly_z: num(row.anomaly_z),
        unit: String(row.unit ?? ""),
      },
    ];
  });
  if (variables.length === 0) return null;

  return {
    region,
    month: String(rows[0].month),
    variables,
    source: String(rows[0].source ?? ""),
    license: String(rows[0].license ?? ""),
  };
}
