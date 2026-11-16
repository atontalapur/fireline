// Color scales and legend ticks for the burning calendar.
import { interpolateCividis, interpolatePuOr } from "d3-scale-chromatic";
import type { SeriesMonth } from "@/lib/contracts";

export type CalendarMode = "counts" | "anomaly";

export const Z_CLAMP = 3;
/** Fill for a month that has counts but no z (MAD = 0 or no baseline). */
export const Z_UNAVAILABLE_FILL = "#a3a3a3";
export const NODATA_FILL = "#9ca3af";

export type LegendTick = { value: number; position: number; label: string };

export type ColorScale = {
  mode: CalendarMode;
  /** Color for a month, or null when the month has no data (draw the hatch instead). */
  color: (m: SeriesMonth) => string | null;
  /** Color at a position 0..1 along the legend ramp. */
  ramp: (t: number) => string;
  ticks: LegendTick[];
  title: string;
};

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function maxHarmonized(months: SeriesMonth[]): number {
  let max = 0;
  for (const m of months) {
    if (m.valid_days > 0 && m.harmonized !== null && m.harmonized > max) max = m.harmonized;
  }
  return max;
}

/** Position 0..1 of a count on the log1p scale with the given max. */
export function countPosition(value: number, max: number): number {
  if (max <= 0) return 0;
  return clamp01(Math.log1p(Math.max(0, value)) / Math.log1p(max));
}

export function countColor(value: number, max: number): string {
  return interpolateCividis(countPosition(value, max));
}

/** Position 0..1 of a z on the diverging ramp, centered on z = 0, clamped to +/- Z_CLAMP. */
export function zPosition(z: number): number {
  return clamp01(0.5 + Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z)) / (2 * Z_CLAMP));
}

/** PuOr runs purple (0) to orange (1): more fire than usual is orange, less is purple. */
export function zColor(z: number): string {
  return interpolatePuOr(zPosition(z));
}

export function formatTickCount(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (v >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

export function countTicks(max: number): LegendTick[] {
  const ticks: LegendTick[] = [{ value: 0, position: 0, label: "0" }];
  if (max <= 0) return ticks;
  const maxPos = 1;
  for (let p = 1; p < max; p *= 10) {
    const position = countPosition(p, max);
    // Keep labels from colliding with the max label.
    if (maxPos - position < 0.12) break;
    if (position - ticks[ticks.length - 1].position < 0.1) continue;
    ticks.push({ value: p, position, label: formatTickCount(p) });
  }
  ticks.push({ value: max, position: 1, label: formatTickCount(max) });
  return ticks;
}

export function zTicks(): LegendTick[] {
  const ticks: LegendTick[] = [];
  for (let z = -Z_CLAMP; z <= Z_CLAMP; z++) {
    let label = z > 0 ? `+${z}` : z < 0 ? `−${-z}` : "0";
    if (z === -Z_CLAMP) label = `≤${label}`;
    if (z === Z_CLAMP) label = `≥${label}`;
    ticks.push({ value: z, position: zPosition(z), label });
  }
  return ticks;
}

export function makeScale(mode: CalendarMode, months: SeriesMonth[]): ColorScale {
  if (mode === "counts") {
    const max = maxHarmonized(months);
    return {
      mode,
      title: "Fire cell-days (MODIS-equivalent, log scale)",
      color: (m) =>
        m.valid_days === 0 || m.harmonized === null ? null : countColor(m.harmonized, max),
      ramp: (t) => interpolateCividis(clamp01(t)),
      ticks: countTicks(max),
    };
  }
  return {
    mode,
    title: "Robust z vs. baseline (orange = more fire than usual)",
    color: (m) => {
      if (m.valid_days === 0 || m.harmonized === null) return null;
      return m.z === null ? Z_UNAVAILABLE_FILL : zColor(m.z);
    },
    ramp: (t) => interpolatePuOr(clamp01(t)),
    ticks: zTicks(),
  };
}

/** Black or white, whichever reads better on an "rgb(r, g, b)" or "#rrggbb" fill. */
export function contrastText(fill: string): "#000000" | "#ffffff" {
  let r = 0;
  let g = 0;
  let b = 0;
  const rgb = fill.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgb) {
    [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  } else if (/^#[0-9a-f]{6}$/i.test(fill)) {
    r = parseInt(fill.slice(1, 3), 16);
    g = parseInt(fill.slice(3, 5), 16);
    b = parseInt(fill.slice(5, 7), 16);
  }
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.179 ? "#000000" : "#ffffff";
}
