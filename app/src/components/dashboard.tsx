"use client";
import { useState } from "react";
import type { AreaSelection } from "@/lib/contracts";
import { useSeries } from "@/lib/use-series";
import { AreaPicker } from "@/components/area-picker/area-picker";
import { BurningCalendar } from "@/components/calendar/burning-calendar";
import { SummaryCards } from "@/components/summary/summary-cards";
import { TrendCharts } from "@/components/charts/trend-charts";
import { ExportButtons } from "@/components/export/export-buttons";
import { AnalystChat } from "@/components/chat/analyst-chat";
import { HexLayer } from "@/components/map/hex-layer";
import { WeatherPanel } from "@/components/weather/weather-panel";

export function Dashboard() {
  const [selection, setSelection] = useState<AreaSelection | null>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [highlightMonths, setHighlightMonths] = useState<string[]>([]);
  const series = useSeries(selection);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-6">
        <section aria-label="Area">
          <AreaPicker onChange={setSelection} onMapReady={setMap} />
          <HexLayer map={map} selection={selection} month={selectedMonth} />
          {selection?.warnings.map((w) => (
            <p key={w} role="status" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              {w}
            </p>
          ))}
        </section>

        {!selection && <p className="text-muted-foreground">Pick an area to see its fire history.</p>}
        {series.status === "loading" && <p role="status">Loading fire history...</p>}
        {series.status === "error" && (
          <p role="alert" className="text-destructive">
            Could not load the series: {series.error}
          </p>
        )}

        {series.status === "ready" && selection && (
          <>
            <SummaryCards series={series.data} />
            <BurningCalendar
              series={series.data}
              highlightMonths={highlightMonths}
              selectedMonth={selectedMonth}
              onSelectMonth={setSelectedMonth}
            />
            <WeatherPanel selection={selection} month={selectedMonth} />
            <TrendCharts series={series.data} />
            <ExportButtons selection={selection} />
            {series.data.meta.warnings.length > 0 && (
              <details className="text-sm">
                <summary>Data notes ({series.data.meta.warnings.length})</summary>
                <ul className="mt-2 list-disc pl-5">
                  {series.data.meta.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
      <aside aria-label="AI analyst">
        <AnalystChat selection={selection} onHighlightMonths={setHighlightMonths} />
      </aside>
    </div>
  );
}
