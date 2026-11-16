// One-line summaries of tool outputs for the "How I got this" trace.
import type {
  CompareToBaselineOutput,
  ExportCsvOutput,
  GetSeriesOutput,
  ResolveAreaOutput,
} from "@/lib/fire-tools";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(v));

export function summarizeResolveArea(o: ResolveAreaOutput): string {
  const where = o.region ? `preset ${o.region}` : `${o.cells.length} cells`;
  return `${o.label}: ${where}, ${n(o.area_km2)} km²${o.warnings.length ? `, ${o.warnings.length} warning(s)` : ""}`;
}

export function summarizeSeries(o: GetSeriesOutput): string {
  const c = o.summary.current;
  const first = o.months[0]?.month ?? "n/a";
  const last = o.months.at(-1)?.month ?? "n/a";
  return (
    `${o.months.length} months (${first} to ${last}); latest ${c.month}: ${n(c.harmonized)} vs median ` +
    `${n(c.baseline_median)}${c.provisional ? " (provisional)" : ""}; peak year ${n(o.summary.peak_year)}, ` +
    `peak month of year ${n(o.summary.peak_month_of_year)}`
  );
}

export function summarizeCompare(o: CompareToBaselineOutput): string {
  return (
    `${o.period}: ${n(o.value)} vs median ${n(o.median)}, ratio ${n(o.ratio)}, z ${n(o.z)}, ` +
    `percentile ${n(o.percentile)}, rank ${n(o.rank)} of ${o.of}${o.provisional ? " (provisional)" : ""}`
  );
}

export function summarizeExport(o: ExportCsvOutput): string {
  return `${o.method} ${o.url}`;
}
