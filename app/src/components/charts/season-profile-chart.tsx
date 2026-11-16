"use client";
import { useCallback, useId, useMemo, useState } from "react";
import type { SeriesResponse } from "@/lib/contracts";
import { defaultProfileYear, profileYears, seasonCaption } from "./chart-data";
import { YEAR_COLOR, seasonSpec } from "./chart-specs";
import { Legend } from "./legend";
import { PlotFigure } from "./plot-figure";
import { BAND_COLOR } from "./theme";

export function SeasonProfileChart({ series }: { series: SeriesResponse }) {
  const selectId = useId();
  const years = useMemo(() => profileYears(series), [series]);
  const fallbackYear = useMemo(() => defaultProfileYear(series), [series]);
  const [picked, setPicked] = useState<number | null>(null);
  // A pick from an earlier series may not exist in this one.
  const year = picked !== null && years.includes(picked) ? picked : fallbackYear;

  const caption = useMemo(() => seasonCaption(series, year), [series, year]);
  const build = useCallback((width: number) => seasonSpec(series, year, width), [series, year]);

  return (
    <PlotFigure
      title="Season profile"
      caption={caption}
      build={build}
      controls={
        years.length > 0 && year !== null ? (
          <label htmlFor={selectId} className="flex items-center gap-2 text-sm">
            Year
            <select
              id={selectId}
              value={year}
              onChange={(e) => setPicked(Number(e.target.value))}
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
      legend={
        <Legend
          items={[
            { label: year !== null ? String(year) : "Selected year", color: YEAR_COLOR },
            { label: "Normal (baseline median)", color: "var(--foreground)", kind: "dashed" },
            { label: "Middle 50% of years", color: BAND_COLOR, kind: "block" },
          ]}
        />
      }
    />
  );
}
