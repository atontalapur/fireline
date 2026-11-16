"use client";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { AreaSelection } from "@/lib/contracts";
import { WeatherResponse, type WeatherValue } from "@/lib/weather/types";
import {
  WEATHER_LABELS,
  describeAnomaly,
  describeUnusual,
  formatMonth,
  formatValue,
} from "@/lib/weather/wording";

type State =
  | { status: "ready"; data: WeatherResponse }
  | { status: "absent" } // 404: no weather file or no data for this region-month
  | { status: "error" };

// Weather context for a preset region and month. Hidden for custom areas and when the API 404s.
export function WeatherPanel(props: { selection: AreaSelection; month: string | null }) {
  const region = props.selection.region;
  const month = props.month;
  const key = region ? `${region}|${month ?? ""}` : null;
  const [result, setResult] = useState<{ key: string; state: State } | null>(null);
  const [lastReady, setLastReady] = useState<{ region: string; data: WeatherResponse } | null>(null);

  useEffect(() => {
    if (!region || !key) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams({ region });
    if (month) qs.set("month", month);
    fetch(`/api/weather?${qs}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 404) return setResult({ key, state: { status: "absent" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = WeatherResponse.parse(await res.json());
        setResult({ key, state: { status: "ready", data } });
        setLastReady({ region, data });
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setResult({ key, state: { status: "error" } });
      });
    return () => ctrl.abort();
  }, [region, month, key]);

  if (!region || !key) return null;

  const current = result?.key === key ? result.state : null;
  if (current?.status === "absent") return null;
  if (current?.status === "error") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Weather context is unavailable right now.
      </p>
    );
  }

  // While loading, keep showing the previous month for the same region instead of flashing.
  const data =
    current?.status === "ready"
      ? current.data
      : lastReady?.region === region
        ? lastReady.data
        : null;
  if (!data) return null;
  const loading = current === null;

  return (
    <section
      aria-label="Weather context"
      aria-busy={loading}
      className={`rounded-lg border bg-card p-4 text-card-foreground ${loading ? "opacity-60" : ""}`}
    >
      <h2 className="text-base font-semibold">Weather in {formatMonth(data.month)}</h2>
      <p className="text-sm text-muted-foreground">
        Compared with the same calendar month in 2003-2022.
        {!month && " Showing the latest month with weather data."}
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {data.variables.map((v) => (
          <WeatherItem key={v.variable} v={v} />
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Source: {data.source}. License: {data.license}.
      </p>
    </section>
  );
}

function WeatherItem({ v }: { v: WeatherValue }) {
  const Icon = v.anomaly === null || v.anomaly === 0 ? Minus : v.anomaly > 0 ? ArrowUp : ArrowDown;
  const unusual = describeUnusual(v.anomaly_z);
  return (
    <div className="rounded-md border p-3">
      <dt className="text-sm text-muted-foreground">{WEATHER_LABELS[v.variable]}</dt>
      <dd className="text-lg font-medium tabular-nums">{formatValue(v)}</dd>
      <dd className="flex items-center gap-1 text-sm">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span>
          {describeAnomaly(v)}
          {unusual && <span className="text-muted-foreground"> ({unusual})</span>}
        </span>
      </dd>
    </div>
  );
}
