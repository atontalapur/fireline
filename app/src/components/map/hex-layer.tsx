"use client";
// Monthly hexagon map layer (#27): harmonized fire cell-days per H3 res-6 cell for the
// calendar's selected month, drawn as a deck.gl overlay on the area picker's map.
import { useEffect, useRef, useState } from "react";
import type { AreaSelection } from "@/lib/contracts";
import type { CellsResponse } from "@/lib/map/cells-request";
import { cividisColor, cividisGradient } from "@/lib/map/color";

export type HexLayerProps = {
  map: google.maps.Map | null;
  selection: AreaSelection | null;
  month: string | null; // YYYY-MM
};

type Cell = CellsResponse["cells"][number];
type FetchState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: CellsResponse };
type Overlay = import("@deck.gl/google-maps").GoogleMapsOverlay;

// deck.gl touches WebGL/DOM, so load it in the browser only, once.
let deckModules: Promise<[typeof import("@deck.gl/google-maps"), typeof import("@deck.gl/geo-layers")]> | null = null;
function loadDeck() {
  deckModules ??= Promise.all([import("@deck.gl/google-maps"), import("@deck.gl/geo-layers")]);
  return deckModules;
}

/** Request body for /api/cells, or null when there is nothing to ask for. */
export function cellsBody(selection: AreaSelection | null, month: string | null) {
  if (!selection || !month) return null;
  if (selection.region) return { region: selection.region, cells: null, month };
  if (selection.cells.length === 0) return null;
  return { region: null, cells: selection.cells, month };
}

/** 0 or null valid days: the month has no satellite data, which is not the same as zero fire. */
function noData(data: CellsResponse): boolean {
  return !data.valid_days;
}

const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function HexLayer({ map, selection, month }: HexLayerProps) {
  const [result, setResult] = useState<{ selection: AreaSelection; month: string; state: FetchState } | null>(
    null,
  );
  const overlayRef = useRef<{ map: google.maps.Map; overlay: Overlay } | null>(null);

  // Fetch per-cell values whenever the area or month changes.
  useEffect(() => {
    const body = map ? cellsBody(selection, month) : null;
    if (!body || !selection || !month) return;
    const ctrl = new AbortController();
    fetch("/api/cells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        setResult({ selection, month, state: { status: "ready", data: json as CellsResponse } });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        setResult({ selection, month, state: { status: "error", error } });
      });
    return () => ctrl.abort();
  }, [map, selection, month]);

  const active = map !== null && cellsBody(selection, month) !== null;
  const state: FetchState | null = !active
    ? null
    : result && result.selection === selection && result.month === month
      ? result.state
      : { status: "loading" };
  const data = state?.status === "ready" ? state.data : null;

  // Drop the overlay when the map changes or the component unmounts.
  useEffect(() => {
    return () => {
      const o = overlayRef.current;
      if (o) {
        o.overlay.setMap(null);
        o.overlay.finalize();
        overlayRef.current = null;
      }
    };
  }, [map]);

  // Replace the layer whenever the data changes; clear it while loading or inactive.
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    loadDeck()
      .then(([{ GoogleMapsOverlay }, { H3HexagonLayer }]) => {
        if (cancelled) return;
        let o = overlayRef.current;
        if (!o || o.map !== map) {
          o?.overlay.finalize();
          o = {
            map,
            overlay: new GoogleMapsOverlay({
              getTooltip: ({ object }) => {
                const c = object as Cell | undefined;
                return c ? { text: `${numberFmt.format(c.harmonized)} fire cell-days\n${c.h3}` } : null;
              },
            }),
          };
          o.overlay.setMap(map);
          overlayRef.current = o;
        }
        if (!data || noData(data) || data.cells.length === 0) {
          o.overlay.setProps({ layers: [] });
          return;
        }
        const max = data.max;
        o.overlay.setProps({
          layers: [
            new H3HexagonLayer<Cell>({
              id: `fire-cells-${data.month}`,
              data: data.cells,
              getHexagon: (c) => c.h3,
              getFillColor: (c) => cividisColor(c.harmonized, max),
              filled: true,
              stroked: true,
              extruded: false,
              getLineColor: [255, 255, 255, 90],
              lineWidthMinPixels: 0.5,
              pickable: true,
              autoHighlight: true,
              highlightColor: [255, 255, 255, 110],
            }),
          ],
        });
      })
      .catch((err: unknown) => console.error("deck.gl failed to load", err));
    return () => {
      cancelled = true;
    };
  }, [map, data]);

  if (!active || !month || !state) return null;

  if (state.status === "ready" && noData(state.data))
    return (
      <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        No data for {formatMonth(month)}
      </div>
    );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
      <span>Fire cell-days, {formatMonth(month)}</span>
      {state.status === "loading" && <span>loading map layer...</span>}
      {state.status === "error" && <span className="text-destructive">map layer failed: {state.error}</span>}
      {state.status === "ready" && state.data.cells.length === 0 && <span>no fire cells this month</span>}
      {state.status === "ready" && state.data.cells.length > 0 && (
        <span className="flex items-center gap-1">
          <span>0</span>
          <span aria-hidden className="inline-block h-2 w-24 rounded-sm" style={{ background: cividisGradient() }} />
          <span>{numberFmt.format(state.data.max)}</span>
          <span>(log scale)</span>
        </span>
      )}
    </div>
  );
}
