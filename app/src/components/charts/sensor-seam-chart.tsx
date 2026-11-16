"use client";
import { useCallback, useMemo, useState } from "react";
import type { SeriesResponse } from "@/lib/contracts";
import { SEAM_SERIES, seamCaption, type SeamSeries } from "./chart-data";
import { seamSpec } from "./chart-specs";
import { Legend } from "./legend";
import { PlotFigure } from "./plot-figure";
import { SERIES_COLORS } from "./theme";

type View = "all" | "raw" | "harmonized";

const VIEWS: { id: View; label: string; series: readonly SeamSeries[] }[] = [
  { id: "all", label: "All", series: SEAM_SERIES },
  { id: "raw", label: "Raw sensors", series: ["MODIS raw", "VIIRS raw"] },
  { id: "harmonized", label: "Harmonized vs MODIS", series: ["MODIS raw", "Harmonized"] },
];

export function SensorSeamChart({ series }: { series: SeriesResponse }) {
  const [view, setView] = useState<View>("all");
  const visible = VIEWS.find((v) => v.id === view)!.series;

  const caption = useMemo(() => seamCaption(series), [series]);
  const build = useCallback((width: number) => seamSpec(series, visible, width), [series, visible]);

  return (
    <PlotFigure
      title="Sensor seam: raw vs harmonized"
      caption={caption}
      build={build}
      controls={
        <div role="group" aria-label="Series shown" className="inline-flex rounded-lg border p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
              className="rounded-md px-2.5 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground"
            >
              {v.label}
            </button>
          ))}
        </div>
      }
      legend={
        <Legend
          items={[
            ...visible.map((s) => ({ label: s, color: SERIES_COLORS[s] })),
            { label: "Sensor change", color: "currentColor", kind: "dashed" as const },
          ]}
        />
      }
    />
  );
}
