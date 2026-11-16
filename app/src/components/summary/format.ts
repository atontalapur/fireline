// Text formatting shared by the summary cards and chart captions.

export const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
export const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "2026-10" -> { year: 2026, month: 10 } */
export function parseYearMonth(ym: string): { year: number; month: number } {
  const [y, m] = ym.split("-");
  return { year: Number(y), month: Number(m) };
}

/** "2026-10" -> "Oct 2026" */
export function formatYearMonth(ym: string): string {
  const { year, month } = parseYearMonth(ym);
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

/** Days in a calendar month (month is 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Fire cell-day counts: whole numbers, one decimal below 10. */
export function formatCount(v: number): string {
  return Math.abs(v) < 10 ? oneDecimal.format(v) : whole.format(v);
}

/** 2.345 -> "2.3x", 0.78 -> "0.78x", 12.4 -> "12x" */
export function formatRatio(r: number): string {
  if (r >= 10) return `${r.toFixed(0)}x`;
  if (r >= 1) return `${r.toFixed(1)}x`;
  return `${r.toFixed(2)}x`;
}

/** 1 -> "1st", 22 -> "22nd", 13 -> "13th" */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** p-value for display. */
export function formatP(p: number): string {
  if (p < 0.001) return "p < 0.001";
  return `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

/** ["a"] -> "a", ["a","b"] -> "a and b", ["a","b","c"] -> "a, b and c" */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
