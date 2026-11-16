// Pure parsing and formatting for the method page validation table (#22).
// Contract: contracts/validation.md.
import { Validation } from "@/lib/contracts";

export type RegionMetrics = Validation["regions"][string];

export type ValidationLoad =
  | { status: "ok"; data: Validation; mock: boolean }
  | { status: "missing" }
  | { status: "invalid"; error: string };

/** Parse validation.json text. Extra top-level keys (such as `"mock": true`) are allowed. */
export function parseValidation(text: string): ValidationLoad {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { status: "invalid", error: `not valid JSON: ${(e as Error).message}` };
  }
  const parsed = Validation.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return { status: "invalid", error: `${first?.message ?? "schema mismatch"}${where}` };
  }
  const mock = typeof raw === "object" && raw !== null && (raw as { mock?: unknown }).mock === true;
  return { status: "ok", data: parsed.data, mock };
}

export const NA = "n/a";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Dimensionless ratio, e.g. 2.18x. */
export function formatRatio(v: number | null | undefined): string {
  return finite(v) ? `${v.toFixed(2)}x` : NA;
}

/** Plain number with two decimals (correlations, NRMSE). */
export function formatNumber(v: number | null | undefined): string {
  return finite(v) ? v.toFixed(2) : NA;
}

/** p-value: "< 0.001" below 0.001, else three decimals below 0.01, else two. */
export function formatP(v: number | null | undefined): string {
  if (!finite(v)) return NA;
  if (v < 0.001) return "< 0.001";
  return v < 0.01 ? v.toFixed(3) : v.toFixed(2);
}

/** Share in 0-1 shown as a whole percent. */
export function formatShare(v: number | null | undefined): string {
  return finite(v) ? `${Math.round(v * 100)}%` : NA;
}

type MetricKey =
  | "raw_bias"
  | "harmonized_bias"
  | "loyo_r"
  | "loyo_nrmse"
  | "forward_r"
  | "seam_ratio"
  | "changepoint_p"
  | "peak_month_match";

export type MetricDef = {
  key: MetricKey;
  label: string;
  expected: string;
  format: (v: number | null | undefined) => string;
};

export const METRICS: MetricDef[] = [
  { key: "raw_bias", label: "Raw bias, VIIRS / MODIS", expected: "about 3x to 6x", format: formatRatio },
  { key: "harmonized_bias", label: "Harmonized bias, harmonized / MODIS", expected: "close to 1x", format: formatRatio },
  { key: "loyo_r", label: "Leave-one-year-out r", expected: "close to 1", format: formatNumber },
  { key: "loyo_nrmse", label: "Leave-one-year-out NRMSE", expected: "close to 0", format: formatNumber },
  { key: "forward_r", label: "Forward r, 2020 to 2025", expected: "close to 1 (drift lowers it)", format: formatNumber },
  { key: "seam_ratio", label: "Seam ratio at Jan 2020", expected: "close to 1x", format: formatRatio },
  { key: "changepoint_p", label: "Change-point p at Jan 2020", expected: "above 0.05 (no step)", format: formatP },
  { key: "peak_month_match", label: "Peak-month match, 2012 to 2019", expected: "close to 100%", format: formatShare },
];

/** "2015-01: 0.97x (p 0.55)" per placebo date, joined with "; ". */
export function formatPlacebo(placebo: RegionMetrics["placebo"]): string {
  if (placebo.length === 0) return NA;
  return placebo
    .map((p) => `${p.date}: ${formatRatio(p.seam_ratio)} (p ${formatP(p.changepoint_p)})`)
    .join("; ");
}

export type RegionColumn = { key: string; name: string; metrics: RegionMetrics };

/**
 * Regions in display order: known presets first (in the given order), then any other keys
 * in file order. Names come from `names`, falling back to the key.
 */
export function regionColumns(
  data: Validation,
  presets: readonly { key: string; name: string }[],
): RegionColumn[] {
  const known = presets.filter((p) => p.key in data.regions).map((p) => p.key);
  const rest = Object.keys(data.regions).filter((k) => !known.includes(k));
  const nameOf = new Map(presets.map((p) => [p.key, p.name]));
  return [...known, ...rest].map((key) => ({
    key,
    name: nameOf.get(key) ?? key,
    metrics: data.regions[key],
  }));
}

export const FIGURE_LABELS: Record<string, string> = {
  seam: "Seam chart",
  scatter: "Harmonized vs MODIS scatter",
};

export type Figure = { name: string; label: string; src: string };

/** Absolute figure URLs, or none when there is no public base URL. */
export function figureList(figures: Record<string, string>, baseUrl: string | null): Figure[] {
  if (!baseUrl) return [];
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return Object.entries(figures)
    .filter(([, rel]) => rel.length > 0)
    .map(([name, rel]) => ({
      name,
      label: FIGURE_LABELS[name] ?? name,
      src: base + rel.replace(/^\/+/, ""),
    }));
}
