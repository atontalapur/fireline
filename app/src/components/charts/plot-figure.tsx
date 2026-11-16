"use client";
// Mounts an Observable Plot chart into a <figure>. Re-renders when `build` or the width changes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Plot from "@observablehq/plot";

export function PlotFigure({
  build,
  caption,
  controls,
  legend,
  title,
}: {
  /** Returns Plot options for the given container width. Memoize it in the caller. */
  build: (width: number) => Plot.PlotOptions;
  /** Text alternative: the takeaway in a sentence or two. */
  caption: string;
  controls?: ReactNode;
  legend?: ReactNode;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (Math.abs(prev - w) >= 8 ? w : prev));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node || width === 0) return;
    const chart = Plot.plot({
      ariaLabel: title,
      ariaDescription: caption,
      style: "--plot-background: var(--card); font-size: 11px;",
      ...build(width),
      width,
    });
    node.append(chart);
    return () => chart.remove();
  }, [build, width, title, caption]);

  return (
    <figure className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        {controls}
      </div>
      {legend}
      <div ref={ref} className="w-full min-w-0 overflow-hidden text-xs" />
      <figcaption className="text-sm text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
