// Number formatting for templated answers. Only rounds; never derives new numbers.

/** 1234.5 -> "1,235"; 55.06 -> "55"; 2.345 -> "2.3". */
export function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 10) return Math.round(v).toLocaleString("en-US");
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 1 -> "1st", 22 -> "22nd", 95 -> "95th" (rounds first). */
export function ordinal(v: number): string {
  const n = Math.round(v);
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** Tool input as shown in the trace: long cell lists collapse to a count. */
export function displayInput(input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[k] = k === "cells" && Array.isArray(v) && v.length > 3 ? `${v.length} H3 cells` : v;
  }
  return out;
}
