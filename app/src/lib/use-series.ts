"use client";
import { useEffect, useState } from "react";
import type { AreaSelection, SeriesResponse } from "@/lib/contracts";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: SeriesResponse };

// POST the selection to /api/series and track the result.
export function useSeries(selection: AreaSelection | null): State {
  const [result, setResult] = useState<{ for: AreaSelection; state: State } | null>(null);

  useEffect(() => {
    if (!selection) return;
    const ctrl = new AbortController();
    fetch("/api/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seriesBody(selection)),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setResult({ for: selection, state: { status: "ready", data: body as SeriesResponse } });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        setResult({ for: selection, state: { status: "error", error } });
      });
    return () => ctrl.abort();
  }, [selection]);

  if (!selection) return { status: "idle" };
  if (result?.for !== selection) return { status: "loading" };
  return result.state;
}

// Request body for /api/series and the CSV endpoints.
export function seriesBody(selection: AreaSelection) {
  return selection.region
    ? { region: selection.region, cells: null, start: selection.start, end: selection.end, baseline: selection.baseline }
    : { region: null, cells: selection.cells, start: selection.start, end: selection.end, baseline: selection.baseline };
}
