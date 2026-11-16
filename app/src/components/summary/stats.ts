// Small, dependency-free statistics used by the summary cards and charts.

/** Values sorted ascending, with nulls and non-finite numbers dropped. */
export function sortedFinite(values: readonly (number | null | undefined)[]): number[] {
  return values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
}

/** Quantile with linear interpolation (R type 7, same as d3.quantile). Null for no values. */
export function quantile(values: readonly (number | null | undefined)[], p: number): number | null {
  const s = sortedFinite(values);
  if (s.length === 0) return null;
  const h = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

export function median(values: readonly (number | null | undefined)[]): number | null {
  return quantile(values, 0.5);
}

/** Error function, Abramowitz and Stegun 7.1.26 (absolute error below 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export type MannKendall = { n: number; s: number; z: number; p: number };

/**
 * Two-sided Mann-Kendall trend test with the tie-corrected variance and the usual
 * continuity correction. Null when there are fewer than 3 values.
 */
export function mannKendall(values: readonly number[]): MannKendall | null {
  const n = values.length;
  if (n < 3) return null;
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j] - values[i]);
  }
  const ties = new Map<number, number>();
  for (const v of values) ties.set(v, (ties.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of ties.values()) if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (variance <= 0) return { n, s, z: 0, p: 1 };
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { n, s, z, p };
}

/** Theil-Sen slope: median of pairwise slopes. Null when fewer than 2 points. */
export function theilSen(xs: readonly number[], ys: readonly number[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  return median(slopes);
}
