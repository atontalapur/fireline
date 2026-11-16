// GET /api/weather response. Columns come from weather.parquet (pipeline/weather.py).
import { z } from "zod";

// Variable keys as written by pipeline/weather.py, in display order.
export const WEATHER_VARIABLES = ["t2m_mean", "rh2m_mean", "wind10m_mean", "precip_total"] as const;
export const WeatherVariable = z.enum(WEATHER_VARIABLES);
export type WeatherVariable = z.infer<typeof WeatherVariable>;

export const WeatherValue = z.object({
  variable: WeatherVariable,
  value: z.number().nullable(),
  anomaly: z.number().nullable(),
  anomaly_z: z.number().nullable(),
  unit: z.string(),
});
export type WeatherValue = z.infer<typeof WeatherValue>;

export const WeatherResponse = z.object({
  region: z.string(),
  month: z.string(), // YYYY-MM
  variables: z.array(WeatherValue),
  source: z.string(),
  license: z.string(),
});
export type WeatherResponse = z.infer<typeof WeatherResponse>;
