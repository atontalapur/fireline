// Cividis on a log1p scale, the same idea as the calendar's counts mode.
import { interpolateCividis } from "d3-scale-chromatic";

export type RGBA = [number, number, number, number];

/** Position on [0, 1] of value v given the max, on a log1p scale. */
export function log1pPosition(v: number, max: number): number {
  if (!(max > 0) || !(v > 0)) return 0;
  return Math.min(1, Math.log1p(v) / Math.log1p(max));
}

function parseColor(css: string): [number, number, number] {
  if (css.startsWith("#")) {
    const n = parseInt(css.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
  return [Math.round(m[0]), Math.round(m[1]), Math.round(m[2])];
}

export function cividisColor(v: number, max: number, alpha = 180): RGBA {
  const [r, g, b] = parseColor(interpolateCividis(log1pPosition(v, max)));
  return [r, g, b, alpha];
}

/** CSS linear-gradient of the cividis ramp, for the legend. */
export function cividisGradient(stops = 8): string {
  const parts = Array.from({ length: stops + 1 }, (_, i) => interpolateCividis(i / stops));
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
