// Text for tooltips, cell labels and the table view.
import type { SeriesMonth, Source } from "@/lib/contracts";
import { monthLabel, type CalendarCell } from "./calendar-grid";

export const SOURCE_LABELS: Record<Source, string> = {
  terra_scaled: "Terra, scaled to Terra + Aqua",
  modis: "MODIS (Terra + Aqua)",
  viirs_scaled: "VIIRS, scaled to MODIS",
};

const DASH = "—";
const MINUS = "−";

export function formatCount(v: number | null): string {
  if (v === null) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function formatBand(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return DASH;
  return `${formatCount(lo)}–${formatCount(hi)}`;
}

export function formatZ(z: number | null): string {
  if (z === null) return DASH;
  const s = Math.abs(z).toFixed(2);
  if (Number(s) === 0) return "0.00";
  return z > 0 ? `+${s}` : `${MINUS}${s}`;
}

export function formatPercentile(p: number | null): string {
  if (p === null) return DASH;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}`;
}

/** Short status flags, e.g. ["provisional", "partial: 28 of 31 days"]. */
export function cellFlags(cell: CalendarCell): string[] {
  const flags: string[] = [];
  if (cell.status === "nodata") flags.push("no satellite data");
  if (cell.provisional) flags.push("provisional");
  if (cell.partial) flags.push(`partial: ${cell.data.valid_days} of ${cell.daysInMonth} days`);
  return flags;
}

export type TooltipRow = { label: string; value: string };

export function tooltipRows(m: SeriesMonth): TooltipRow[] {
  const nodata = m.valid_days === 0 || m.harmonized === null;
  return [
    { label: "Harmonized", value: nodata ? "no data" : formatCount(m.harmonized) },
    { label: "90% band", value: formatBand(m.lo, m.hi) },
    { label: "Baseline median", value: formatCount(m.baseline_median) },
    { label: "z", value: formatZ(m.z) },
    { label: "Percentile", value: formatPercentile(m.percentile) },
    { label: "Raw MODIS", value: formatCount(m.modis_raw) },
    { label: "Raw VIIRS", value: formatCount(m.viirs_raw) },
    { label: "Source", value: SOURCE_LABELS[m.source] ?? m.source },
  ];
}

/** One-line description for a cell's accessible name. */
export function cellAriaLabel(
  cell: CalendarCell,
  opts: { highlighted?: boolean; selected?: boolean } = {},
): string {
  const m = cell.data;
  const parts = [monthLabel(cell.month)];
  if (cell.status === "nodata") {
    parts.push("no satellite data");
  } else {
    parts.push(`${formatCount(m.harmonized)} fire cell-days (90% band ${formatBand(m.lo, m.hi)})`);
    parts.push(`baseline median ${formatCount(m.baseline_median)}`);
    parts.push(`z ${formatZ(m.z)}`);
    parts.push(`percentile ${formatPercentile(m.percentile)}`);
  }
  parts.push(`source ${SOURCE_LABELS[m.source] ?? m.source}`);
  if (cell.provisional) parts.push("provisional");
  if (cell.partial) parts.push(`partial month, ${m.valid_days} of ${cell.daysInMonth} days`);
  if (opts.highlighted) parts.push("referenced by the analyst");
  if (opts.selected) parts.push("selected");
  return parts.join(", ");
}

export type TableRow = {
  month: string;
  label: string;
  harmonized: string;
  band: string;
  median: string;
  z: string;
  percentile: string;
  modis: string;
  viirs: string;
  source: string;
  flags: string;
};

export function tableRow(cell: CalendarCell): TableRow {
  const m = cell.data;
  const nodata = cell.status === "nodata";
  return {
    month: cell.month,
    label: monthLabel(cell.month),
    harmonized: nodata ? "no data" : formatCount(m.harmonized),
    band: formatBand(m.lo, m.hi),
    median: formatCount(m.baseline_median),
    z: formatZ(m.z),
    percentile: formatPercentile(m.percentile),
    modis: formatCount(m.modis_raw),
    viirs: formatCount(m.viirs_raw),
    source: SOURCE_LABELS[m.source] ?? m.source,
    flags: cellFlags(cell).join("; "), // empty when there is nothing to note
  };
}
