// Shared request/response shapes. Source of truth: contracts/api-series.md.
import { z } from "zod";

export const REGION_KEYS = ["pantanal", "w_canada", "punjab"] as const;
export const RegionKey = z.enum(REGION_KEYS);
export type RegionKey = z.infer<typeof RegionKey>;

export const METHOD_VERSION = "1.0";
export const MAX_CELLS = 50_000;
export const DEFAULT_START = "2000-11";
export const DEFAULT_BASELINE: [number, number] = [2003, 2022];

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

export const SeriesRequest = z
  .object({
    cells: z.array(z.string().regex(/^[0-9a-f]{15}$/)).max(MAX_CELLS).nullable().default(null),
    region: RegionKey.nullable().default(null),
    start: YearMonth.default(DEFAULT_START),
    end: YearMonth,
    baseline: z.tuple([z.number().int(), z.number().int()]).default(DEFAULT_BASELINE),
  })
  .refine((r) => (r.cells === null) !== (r.region === null), {
    message: "exactly one of cells and region must be set",
  })
  .refine((r) => r.end >= r.start, { message: "end must be >= start" })
  .refine((r) => r.baseline[0] <= r.baseline[1], { message: "baseline must be [first, last]" });
export type SeriesRequest = z.infer<typeof SeriesRequest>;

export const Source = z.enum(["terra_scaled", "modis", "viirs_scaled"]);
export type Source = z.infer<typeof Source>;

export const SeriesMonth = z.object({
  month: z.string(),
  harmonized: z.number().nullable(),
  lo: z.number().nullable(),
  hi: z.number().nullable(),
  modis_raw: z.number().nullable(),
  viirs_raw: z.number().nullable(),
  source: Source,
  provisional: z.boolean(),
  valid_days: z.number().int(),
  baseline_median: z.number().nullable(),
  baseline_mean: z.number().nullable(),
  z: z.number().nullable(),
  percentile: z.number().nullable(),
});
export type SeriesMonth = z.infer<typeof SeriesMonth>;

export const SeriesResponse = z.object({
  months: z.array(SeriesMonth),
  summary: z.object({
    current: z.object({
      month: z.string(),
      harmonized: z.number().nullable(),
      baseline_median: z.number().nullable(),
      ratio_to_median: z.number().nullable(),
      z: z.number().nullable(),
      percentile: z.number().nullable(),
      provisional: z.boolean(),
      partial: z.boolean(),
    }),
    peak_month_of_year: z.number().int().nullable(),
    peak_year: z.number().int().nullable(),
    annual: z.array(
      z.object({
        year: z.number().int(),
        total: z.number(),
        rank: z.number().int().nullable(),
        complete: z.boolean(),
      }),
    ),
  }),
  meta: z.object({
    method_version: z.string(),
    area_km2: z.number(),
    cell_count: z.number().int(),
    warnings: z.array(z.string()),
  }),
});
export type SeriesResponse = z.infer<typeof SeriesResponse>;

// What the area picker hands to the dashboard.
export type AreaSelection = {
  label: string;
  region: RegionKey | null; // set for presets; null for drawn/typed areas
  cells: string[]; // H3 res-6 cells; empty for a preset (the API resolves it)
  start: string;
  end: string;
  baseline: [number, number];
  warnings: string[];
};

export const Validation = z.object({
  method_version: z.string(),
  regions: z.record(
    z.string(),
    z.object({
      raw_bias: z.number().nullable(),
      harmonized_bias: z.number().nullable(),
      loyo_r: z.number().nullable(),
      loyo_nrmse: z.number().nullable(),
      forward_r: z.number().nullable(),
      seam_ratio: z.number().nullable(),
      changepoint_p: z.number().nullable(),
      placebo: z.array(
        z.object({
          date: z.string(),
          seam_ratio: z.number().nullable(),
          changepoint_p: z.number().nullable(),
        }),
      ),
      peak_month_match: z.number().nullable(),
      figures: z.record(z.string(), z.string()),
    }),
  ),
});
export type Validation = z.infer<typeof Validation>;
