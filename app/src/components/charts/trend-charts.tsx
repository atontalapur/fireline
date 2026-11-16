"use client";
// Stub. Replaced by #20 (trend charts).
import type { SeriesResponse } from "@/lib/contracts";

export function TrendCharts({ series }: { series: SeriesResponse }) {
  return <p>Charts: {series.summary.annual.length} years</p>;
}
