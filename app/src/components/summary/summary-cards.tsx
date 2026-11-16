"use client";
// Stub. Replaced by #20 (summary cards).
import type { SeriesResponse } from "@/lib/contracts";

export function SummaryCards({ series }: { series: SeriesResponse }) {
  return <p>Current month: {series.summary.current.month}</p>;
}
