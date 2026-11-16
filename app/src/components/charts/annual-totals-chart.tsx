"use client";
import { useCallback, useMemo, useState } from "react";
import type { SeriesResponse } from "@/lib/contracts";
import { annualCaption } from "./chart-data";
import { BAR_COLOR, annualSpec } from "./chart-specs";
import { Legend } from "./legend";
import { PlotFigure } from "./plot-figure";
import { INCOMPLETE_COLOR } from "./theme";

type Order = "year" | "rank";

export function AnnualTotalsChart({ series }: { series: SeriesResponse }) {
  const [order, setOrder] = useState<Order>("year");
  const caption = useMemo(() => annualCaption(series), [series]);
  const build = useCallback((width: number) => annualSpec(series, order, width), [series, order]);

  return (
    <PlotFigure
      title="Annual totals"
      caption={caption}
      build={build}
      controls={
        <div role="group" aria-label="Order bars by" className="inline-flex rounded-lg border p-0.5">
          {(["year", "rank"] as const).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={order === o}
              onClick={() => setOrder(o)}
              className="rounded-md px-2.5 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground"
            >
              {o === "year" ? "By year" : "By rank"}
            </button>
          ))}
        </div>
      }
      legend={
        <Legend
          items={[
            { label: "Complete year (rank shown for top 3)", color: BAR_COLOR, kind: "block" },
            { label: "Incomplete year, not ranked", color: INCOMPLETE_COLOR, kind: "block" },
          ]}
        />
      }
    />
  );
}
