"use client";
// Stub. Replaced by #19 (accessible burning calendar).
import type { SeriesResponse } from "@/lib/contracts";

export type BurningCalendarProps = {
  series: SeriesResponse;
  highlightMonths?: string[]; // YYYY-MM, e.g. months the AI analyst referenced
  selectedMonth?: string | null;
  onSelectMonth?: (month: string) => void;
};

export function BurningCalendar({ series }: BurningCalendarProps) {
  return <p>Calendar: {series.months.length} months</p>;
}
