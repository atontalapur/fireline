// Pure grid logic for the burning calendar: rows = years, columns = Jan-Dec.
import type { SeriesMonth, SeriesResponse } from "@/lib/contracts";

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export type CellStatus = "data" | "nodata";

export type CalendarCell = {
  month: string; // YYYY-MM
  year: number;
  monthIndex: number; // 0-11
  data: SeriesMonth;
  status: CellStatus; // "nodata" when valid_days = 0 or harmonized is null
  provisional: boolean;
  partial: boolean; // 0 < valid_days < days in month
  daysInMonth: number;
};

export type CalendarRow = {
  year: number;
  cells: (CalendarCell | null)[]; // length 12; null = outside the series range
};

export type CalendarGrid = {
  rows: CalendarRow[];
  months: string[]; // in-range months, in order
  byMonth: Map<string, CalendarCell>;
};

export function parseMonth(month: string): { year: number; monthIndex: number } {
  const [y, m] = month.split("-");
  return { year: Number(y), monthIndex: Number(m) - 1 };
}

export function formatYearMonth(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function monthLabel(month: string): string {
  const { year, monthIndex } = parseMonth(month);
  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

export function toCell(data: SeriesMonth): CalendarCell {
  const { year, monthIndex } = parseMonth(data.month);
  const dim = daysInMonth(year, monthIndex);
  const nodata = data.valid_days === 0 || data.harmonized === null;
  return {
    month: data.month,
    year,
    monthIndex,
    data,
    status: nodata ? "nodata" : "data",
    provisional: data.provisional,
    partial: data.valid_days > 0 && data.valid_days < dim,
    daysInMonth: dim,
  };
}

export function buildGrid(series: Pick<SeriesResponse, "months">): CalendarGrid {
  const byMonth = new Map<string, CalendarCell>();
  for (const m of series.months) byMonth.set(m.month, toCell(m));
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return { rows: [], months, byMonth };

  const first = parseMonth(months[0]).year;
  const last = parseMonth(months[months.length - 1]).year;
  const rows: CalendarRow[] = [];
  for (let year = first; year <= last; year++) {
    const cells = MONTH_LABELS.map((_, i) => byMonth.get(formatYearMonth(year, i)) ?? null);
    rows.push({ year, cells });
  }
  return { rows, months, byMonth };
}

export type NavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

const NAV_KEYS = new Set<string>([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
]);

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.has(key);
}

/**
 * Next focused month for a key press. Left/Right move one month (wrapping across years),
 * Up/Down one year (staying put if that month is outside the range), Home/End the first or
 * last in-range month of the row, Ctrl+Home/End (or PageUp/PageDown) the first or last month
 * of the whole series.
 */
export function moveFocus(
  grid: CalendarGrid,
  current: string,
  key: NavKey,
  ctrl = false,
): string {
  const { months, byMonth } = grid;
  if (months.length === 0) return current;
  const idx = months.indexOf(current);
  if (idx === -1) return months[months.length - 1];
  const { year, monthIndex } = parseMonth(current);

  switch (key) {
    case "ArrowLeft":
      return months[Math.max(0, idx - 1)];
    case "ArrowRight":
      return months[Math.min(months.length - 1, idx + 1)];
    case "ArrowUp": {
      const m = formatYearMonth(year - 1, monthIndex);
      return byMonth.has(m) ? m : current;
    }
    case "ArrowDown": {
      const m = formatYearMonth(year + 1, monthIndex);
      return byMonth.has(m) ? m : current;
    }
    case "PageUp":
      return months[0];
    case "PageDown":
      return months[months.length - 1];
    case "Home": {
      if (ctrl) return months[0];
      const row = months.filter((m) => m.startsWith(`${year}-`));
      return row[0] ?? current;
    }
    case "End": {
      if (ctrl) return months[months.length - 1];
      const row = months.filter((m) => m.startsWith(`${year}-`));
      return row[row.length - 1] ?? current;
    }
  }
}
