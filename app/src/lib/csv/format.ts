// CSV formatting for the analytics and hotspot exports (#21).
import type { SeriesRequest, SeriesResponse } from "@/lib/contracts";
import { METHOD_VERSION } from "@/lib/contracts";

export type CsvKind = "analytics" | "hotspots";
type Cell = string | number | boolean | null | undefined;

/** UTF-8 byte order mark, so spreadsheet apps read the "·" in the header line correctly. */
export const BOM = "\uFEFF";

export const ANALYTICS_COLUMNS = [
  "month", "harmonized", "lo", "hi", "modis_raw", "viirs_raw", "baseline_median",
  "baseline_mean", "z", "percentile", "source", "provisional",
] as const;

export const HOTSPOT_COLUMNS = [
  "date", "time_utc", "local_date", "lat", "lon", "sensor", "product", "confidence", "frp",
  "daynight", "h3_r6", "k",
] as const;

/** First line of every export. */
export function headerComment(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `# Fireline method v${METHOD_VERSION} · sources: NASA FIRMS MODIS C6.1, VIIRS 375 m · generated ${ts}`;
}

/** One CSV field: empty for null, quoted when it holds a comma, quote or line break. */
export function csvField(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csvRow(values: readonly Cell[]): string {
  return values.map(csvField).join(",") + "\r\n";
}

/** Filename part for the area: the preset key, else "area". */
export function areaSlug(req: Pick<SeriesRequest, "region">): string {
  return req.region ?? "area";
}

export function csvFilename(req: Pick<SeriesRequest, "region" | "start" | "end">, kind: CsvKind): string {
  return `fireline_${areaSlug(req)}_${req.start}_${req.end}_${kind}.csv`;
}

export function csvHeaders(filename: string): HeadersInit {
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  };
}

/** The whole analytics file: BOM, header comment, column row, one row per month. */
export function analyticsCsv(series: SeriesResponse, now: Date = new Date()): string {
  let out = BOM + headerComment(now) + "\r\n" + csvRow(ANALYTICS_COLUMNS);
  for (const m of series.months) {
    out += csvRow([
      m.month, m.harmonized, m.lo, m.hi, m.modis_raw, m.viirs_raw, m.baseline_median,
      m.baseline_mean, m.z, m.percentile, m.source, m.provisional,
    ]);
  }
  return out;
}
