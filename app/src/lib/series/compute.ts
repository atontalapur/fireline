// POST /api/series logic (contracts/api-series.md). Reference: build_series() in
// contracts/make_mock.py.
import { LIST, VARCHAR, listValue } from "@duckdb/node-api";
import { METHOD_VERSION, type SeriesRequest, type SeriesResponse, type Source } from "@/lib/contracts";
import { cellsAreaKm2 } from "@/lib/geo";
import { dataFile } from "@/lib/data-dir";
import { SeriesError, resolveArea } from "@/lib/series/area";
import { queryRows } from "@/lib/series/db";

const TERRA_ONLY_END = "2002-06";
export const SWITCH_MONTH = "2020-01";
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Splice table source for a month with no rows (contracts/monthly.md). */
export function spliceSource(month: string): Source {
  if (month <= TERRA_ONLY_END) return "terra_scaled";
  if (month < SWITCH_MONTH) return "modis";
  return "viirs_scaled";
}

export function round(x: number | null | undefined, digits = 3): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r; // no -0
}

export function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type Row = {
  month: string;
  valid_days: number;
  modis_on: boolean;
  viirs_on: boolean;
  source: string | null;
  provisional: boolean | null;
  harmonized: number | null;
  lo: number | null;
  hi: number | null;
  modis_raw: number | null;
  viirs_raw: number | null;
};

/** Region-month rows over the full record, with sums over the selected cells. */
async function loadRecord(region: string, cells: string[] | null): Promise<Row[]> {
  const sel = cells ? "sel.h3_r6 IS NOT NULL" : "TRUE";
  const join = cells
    ? "LEFT JOIN (SELECT DISTINCT unnest($cells) AS h3_r6) sel ON sel.h3_r6 = m.h3_r6"
    : "";
  const sql = `
    WITH agg AS (
      SELECT m.month,
             any_value(m.source) AS source,
             bool_or(m.provisional) AS provisional,
             sum(m.harmonized) FILTER (WHERE ${sel}) AS harmonized,
             sum(m.harmonized_lo) FILTER (WHERE ${sel}) AS lo,
             sum(m.harmonized_hi) FILTER (WHERE ${sel}) AS hi,
             sum(m.modis_raw) FILTER (WHERE ${sel}) AS modis_raw,
             sum(m.viirs_raw) FILTER (WHERE ${sel}) AS viirs_raw
      FROM read_parquet($monthly) m ${join}
      WHERE m.region = $region
      GROUP BY m.month
    )
    SELECT strftime(c.month, '%Y-%m') AS month,
           c.valid_days::INTEGER AS valid_days,
           c.modis_valid_days > 0 AS modis_on,
           c.viirs_valid_days > 0 AS viirs_on,
           a.source, a.provisional,
           a.harmonized::DOUBLE AS harmonized, a.lo::DOUBLE AS lo, a.hi::DOUBLE AS hi,
           a.modis_raw::DOUBLE AS modis_raw, a.viirs_raw::DOUBLE AS viirs_raw
    FROM read_parquet($coverage) c
    LEFT JOIN agg a ON a.month = c.month
    WHERE c.region = $region
    ORDER BY c.month`;
  const params: Record<string, string | ReturnType<typeof listValue>> = {
    monthly: dataFile("monthly.parquet"),
    coverage: dataFile("coverage_month.parquet"),
    region,
  };
  if (cells) params.cells = listValue(cells);
  return queryRows<Row>(sql, params, cells ? { cells: LIST(VARCHAR) } : undefined);
}

/** First and last month (YYYY-MM) of the region's record in coverage_month, or null if none. */
export async function recordRange(region: string): Promise<{ start: string; end: string } | null> {
  const [row] = await queryRows<{ start: string | null; end: string | null }>(
    `SELECT strftime(min(month), '%Y-%m') AS start, strftime(max(month), '%Y-%m') AS "end"
     FROM read_parquet($coverage) WHERE region = $region`,
    { coverage: dataFile("coverage_month.parquet"), region },
  );
  return row?.start && row.end ? { start: row.start, end: row.end } : null;
}

type Stats = { b: number[]; median: number; mean: number; mad: number };

export async function computeSeries(req: SeriesRequest): Promise<SeriesResponse> {
  const area = resolveArea(req);
  const warnings = [...area.warnings];
  const record = await loadRecord(area.region, area.cells);
  if (record.length === 0) throw new SeriesError(`no data for region ${area.region}`, 404);

  // Zero versus missing: no rows means zero unless valid_days = 0; raw sensors are null when
  // that sensor family had no data.
  const series = record.map((r) => {
    const has = r.valid_days > 0;
    return {
      month: r.month,
      year: Number(r.month.slice(0, 4)),
      moy: Number(r.month.slice(5, 7)),
      valid_days: r.valid_days,
      source: (r.source ?? spliceSource(r.month)) as Source,
      provisional: r.provisional ?? false,
      harmonized: has ? (r.harmonized ?? 0) : null,
      lo: has ? (r.lo ?? 0) : null,
      hi: has ? (r.hi ?? 0) : null,
      modis_raw: has && r.modis_on ? (r.modis_raw ?? 0) : null,
      viirs_raw: has && r.viirs_on ? (r.viirs_raw ?? 0) : null,
    };
  });

  const recordStart = series[0].month;
  const recordEnd = series[series.length - 1].month;
  if (req.start < recordStart || req.end > recordEnd)
    warnings.push(`Requested range clipped to the record ${recordStart} to ${recordEnd}.`);
  const lo = req.start > recordStart ? req.start : recordStart;
  const hi = req.end < recordEnd ? req.end : recordEnd;
  if (lo > hi) throw new SeriesError(`range ${req.start} to ${req.end} is outside the record ${recordStart} to ${recordEnd}`);

  // Baseline per calendar month from the full record.
  const [b0, b1] = req.baseline;
  const stats: (Stats | null)[] = [];
  for (let moy = 1; moy <= 12; moy++) {
    const b = series
      .filter((s) => s.moy === moy && s.year >= b0 && s.year <= b1 && s.harmonized !== null)
      .map((s) => s.harmonized as number);
    if (b.length === 0) {
      stats[moy] = null;
      continue;
    }
    const sorted = [...b].sort((x, y) => x - y);
    const med = median(sorted);
    const mad = median(b.map((v) => Math.abs(v - med)).sort((x, y) => x - y));
    stats[moy] = { b, median: med, mean: b.reduce((s, v) => s + v, 0) / b.length, mad };
    if (mad === 0) warnings.push(`Baseline MAD is 0 for ${MONTH_NAMES[moy - 1]}; z is null for that month.`);
  }

  const window = series.filter((s) => s.month >= lo && s.month <= hi);
  const months: SeriesResponse["months"] = window.map((s) => {
    const st = stats[s.moy];
    const x = s.harmonized;
    let z: number | null = null;
    let pct: number | null = null;
    if (st && x !== null) {
      if (st.mad > 0) z = (x - st.median) / (1.4826 * st.mad);
      let below = 0;
      let equal = 0;
      for (const v of st.b) {
        if (v < x) below++;
        else if (v === x) equal++;
      }
      pct = (100 * (below + 0.5 * equal)) / st.b.length;
    }
    if (s.valid_days === 0) warnings.push(`${s.month}: no satellite data (valid_days = 0).`);
    return {
      month: s.month,
      harmonized: round(x),
      lo: round(s.lo),
      hi: round(s.hi),
      modis_raw: round(s.modis_raw),
      viirs_raw: round(s.viirs_raw),
      source: s.source,
      provisional: s.provisional,
      valid_days: s.valid_days,
      baseline_median: st ? round(st.median) : null,
      baseline_mean: st ? round(st.mean) : null,
      z: round(z),
      percentile: round(pct, 1),
    };
  });
  const prov = months.filter((m) => m.provisional).map((m) => m.month);
  if (prov.length) warnings.push(`Provisional (NRT or incomplete) months: ${prov.join(", ")}.`);

  const cur = months[months.length - 1];
  const med = cur.baseline_median;
  const current = {
    month: cur.month,
    harmonized: cur.harmonized,
    baseline_median: med,
    ratio_to_median: cur.harmonized !== null && med ? round(cur.harmonized / med, 2) : null,
    z: cur.z,
    percentile: cur.percentile,
    provisional: cur.provisional,
    partial: cur.valid_days < daysInMonth(cur.month),
  };

  let peakMoy: number | null = null;
  for (let moy = 1; moy <= 12; moy++) {
    const st = stats[moy];
    if (st && (peakMoy === null || st.mean > (stats[peakMoy] as Stats).mean)) peakMoy = moy;
  }

  const annual: SeriesResponse["summary"]["annual"] = [];
  for (const y of [...new Set(window.map((s) => s.year))]) {
    const yr = window.filter((s) => s.year === y);
    const total = yr.reduce((sum, s) => sum + (s.harmonized ?? 0), 0);
    const complete = yr.length === 12 && yr.every((s) => s.valid_days > 0);
    annual.push({ year: y, total: round(total) ?? 0, rank: null, complete });
  }
  const ranked = annual.filter((a) => a.complete).sort((a, b) => b.total - a.total || a.year - b.year);
  for (const a of ranked) a.rank = 1 + ranked.filter((b) => b.total > a.total).length;

  return {
    months,
    summary: {
      current,
      peak_month_of_year: peakMoy,
      peak_year: ranked[0]?.year ?? null,
      annual,
    },
    meta: {
      method_version: METHOD_VERSION,
      area_km2: cellsAreaKm2(area.areaCells),
      cell_count: area.areaCells.length,
      warnings,
    },
  };
}
