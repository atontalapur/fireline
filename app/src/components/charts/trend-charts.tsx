"use client";
import type { SeriesResponse } from "@/lib/contracts";
import { AnnualTotalsChart } from "./annual-totals-chart";
import { SeasonProfileChart } from "./season-profile-chart";
import { SensorSeamChart } from "./sensor-seam-chart";

export function TrendCharts({ series }: { series: SeriesResponse }) {
  if (series.months.length === 0) {
    return <p className="text-sm text-muted-foreground">No months in this range to chart.</p>;
  }
  return (
    <section aria-label="Trend charts" className="flex flex-col gap-6">
      <SensorSeamChart series={series} />
      <div className="grid gap-6 xl:grid-cols-2">
        <SeasonProfileChart series={series} />
        <AnnualTotalsChart series={series} />
      </div>
    </section>
  );
}
