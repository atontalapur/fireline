// Plot option builders for the trend charts. Pure: data in, Plot.PlotOptions out.
import * as Plot from "@observablehq/plot";
import type { SeriesResponse } from "@/lib/contracts";
import { MONTH_SHORT, formatCount, formatYearMonth } from "@/components/summary/format";
import {
  SEAM_SERIES,
  annualBars,
  annualOrder,
  seamBand,
  seamMarkers,
  seamRows,
  seasonProfile,
  yearLine,
  type AnnualBar,
  type SeamRow,
  type SeamSeries,
  type YearPoint,
} from "./chart-data";
import { BAND_COLOR, INCOMPLETE_COLOR, NORMAL_COLOR, SERIES_COLORS } from "./theme";

export const YEAR_COLOR = SERIES_COLORS.Harmonized;
export const BAR_COLOR = SERIES_COLORS.Harmonized;

export function seasonSpec(series: SeriesResponse, year: number | null, width: number): Plot.PlotOptions {
  const profile = seasonProfile(series);
  const points = year === null ? [] : yearLine(series, year);
  return {
    height: Math.max(220, Math.min(320, width * 0.45)),
    marginLeft: 48,
    x: { domain: [1, 12], ticks: 12, tickFormat: (m: number) => MONTH_SHORT[m - 1], label: null },
    y: { label: "Fire cell-days", grid: true, nice: true, zero: true },
    marks: [
      Plot.areaY(profile, { x: "month", y1: "q1", y2: "q3", fill: BAND_COLOR, fillOpacity: 0.3 }),
      Plot.lineY(profile, {
        x: "month",
        y: "median",
        stroke: NORMAL_COLOR,
        strokeDasharray: "4,3",
        strokeWidth: 1.5,
      }),
      Plot.lineY(points, { x: "month", y: "value", stroke: YEAR_COLOR, strokeWidth: 2.5 }),
      Plot.dot(points, {
        x: "month",
        y: "value",
        fill: (d: YearPoint) => (d.partial ? "var(--plot-background)" : YEAR_COLOR),
        stroke: YEAR_COLOR,
        r: 3,
      }),
      Plot.tip(
        points.filter((p) => p.value !== null),
        Plot.pointerX({
          x: "month",
          y: "value",
          title: (d: YearPoint) => {
            const normal = profile[d.month - 1].median;
            const head = `${d.label} ${year}: ${formatCount(d.value as number)}${d.partial ? " (partial)" : ""}`;
            return normal !== null ? `${head}\nNormal: ${formatCount(normal)}` : head;
          },
        }),
      ),
    ],
  };
}

export function seamSpec(series: SeriesResponse, visible: readonly SeamSeries[], width: number): Plot.PlotOptions {
  const shown = seamRows(series).filter((r) => visible.includes(r.series));
  const markers = seamMarkers(series);
  return {
    height: Math.max(260, Math.min(380, width * 0.5)),
    marginLeft: 52,
    marginTop: 36,
    x: { type: "utc", label: null },
    y: { label: "Fire cell-days per month", grid: true, nice: true, zero: true },
    color: { domain: [...SEAM_SERIES], range: SEAM_SERIES.map((s) => SERIES_COLORS[s]) },
    marks: [
      Plot.ruleY([0]),
      visible.includes("Harmonized")
        ? Plot.areaY(seamBand(series), {
            x: "date",
            y1: "lo",
            y2: "hi",
            fill: SERIES_COLORS.Harmonized,
            fillOpacity: 0.2,
          })
        : null,
      // Harmonized is drawn first and thicker: it equals MODIS until 2019, so the thin MODIS
      // line stays visible on top of it.
      Plot.lineY(
        shown.filter((r) => r.series === "Harmonized"),
        { x: "date", y: "value", stroke: "series", strokeWidth: 3, strokeOpacity: 0.85 },
      ),
      Plot.lineY(
        shown.filter((r) => r.series !== "Harmonized"),
        { x: "date", y: "value", z: "series", stroke: "series", strokeWidth: 1.25 },
      ),
      Plot.ruleX(markers, { x: "date", stroke: "currentColor", strokeDasharray: "4,3", strokeOpacity: 0.7 }),
      ...markers.map((m, i) =>
        Plot.text([m], {
          x: "date",
          text: "label",
          frameAnchor: "top",
          textAnchor: i % 2 === 0 ? "end" : "start",
          dx: i % 2 === 0 ? -4 : 4,
          dy: -26 + 14 * (i % 2),
          fill: "currentColor",
        }),
      ),
      Plot.tip(
        shown.filter((r) => r.value !== null),
        Plot.pointer({
          x: "date",
          y: "value",
          stroke: "series",
          title: (d: SeamRow) => `${d.series}\n${formatYearMonth(d.month)}: ${formatCount(d.value as number)}`,
        }),
      ),
    ],
  };
}

export function annualSpec(series: SeriesResponse, order: "year" | "rank", width: number): Plot.PlotOptions {
  const bars = annualBars(series);
  const complete = bars.filter((b) => b.complete);
  const incomplete = bars.filter((b) => !b.complete);
  const labelled = bars.filter((b) => !b.complete || (b.rank !== null && b.rank <= 3));
  return {
    height: Math.max(240, Math.min(340, width * 0.45)),
    marginLeft: 52,
    marginTop: 44,
    marginBottom: 40,
    x: { domain: annualOrder(bars, order), label: null, tickRotate: -90, padding: 0.15 },
    y: { label: "Fire cell-days per year", grid: true, nice: true, zero: true },
    marks: [
      Plot.barY(complete, { x: "year", y: "total", fill: BAR_COLOR, fillOpacity: 0.85 }),
      Plot.barY(incomplete, {
        x: "year",
        y: "total",
        fill: INCOMPLETE_COLOR,
        fillOpacity: 0.35,
        stroke: INCOMPLETE_COLOR,
        strokeDasharray: "3,2",
      }),
      Plot.ruleY([0]),
      Plot.text(labelled, {
        x: "year",
        y: "total",
        text: "label",
        rotate: -90,
        textAnchor: "start",
        dy: -4,
        fill: "currentColor",
      }),
      Plot.tip(
        bars,
        Plot.pointerX({
          x: "year",
          y: "total",
          title: (d: AnnualBar) =>
            `${d.year}: ${formatCount(d.total)}\n${
              d.complete && d.rank !== null ? `Rank ${d.rank} of ${complete.length}` : "Incomplete year, not ranked"
            }`,
        }),
      ),
    ],
  };
}
