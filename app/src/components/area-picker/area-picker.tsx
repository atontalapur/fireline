"use client";
// Map area picker (#17): presets, drawn shapes, lat/lon + radius, place search, date range and baseline.
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { TerraDraw } from "terra-draw";
import { importLibrary } from "@googlemaps/js-api-loader";
import type { AreaSelection, RegionKey } from "@/lib/contracts";
import { REGION_PRESETS, circlePolygon, presetFor, type PolygonGeometry } from "@/lib/geo";
import { Button } from "@/components/ui/button";
import {
  bboxPolygon,
  cellsSource,
  currentMonth,
  defaultPeriodInputs,
  geometryBounds,
  parseCircle,
  parsePeriod,
  shapeLabel,
  toSelection,
  type AreaSource,
  type PeriodInputs,
} from "./selection";
import { useGoogleMap } from "./use-google-map";

export type AreaPickerProps = {
  onChange: (selection: AreaSelection) => void;
  onMapReady?: (map: google.maps.Map) => void;
};

type DrawMode = "polygon" | "rectangle";
const MAP_ELEMENT_ID = "area-picker-map";
const PLACE_FALLBACK_RADIUS_KM = 15;

const noopSubscribe = () => () => {};
/** Current month on the client, "" during server render (keeps `new Date()` out of the prerender). */
function useCurrentMonth(): string {
  return useSyncExternalStore(noopSubscribe, () => currentMonth(), () => "");
}

const inputClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";
const labelClass = "flex flex-col gap-1 text-sm";

export function AreaPicker({ onChange, onMapReady }: AreaPickerProps) {
  const uid = useId();
  const latest = useCurrentMonth();
  const hydrated = latest !== "";

  const [source, setSource] = useState<AreaSource | null>(null);
  const [period, setPeriod] = useState<Omit<PeriodInputs, "end"> & { end: string | null }>(() => ({
    ...defaultPeriodInputs(""),
    end: null, // null = follow the current month
  }));
  const [areaError, setAreaError] = useState<string | null>(null);
  const [circle, setCircle] = useState({ lat: "", lng: "", radius: "50" });

  const periodInputs: PeriodInputs = { ...period, end: period.end ?? latest };
  const parsedPeriod = hydrated ? parsePeriod(periodInputs, latest) : null;
  const periodError = parsedPeriod && !parsedPeriod.ok ? parsedPeriod.error : null;

  // Map, draw and search.
  const mapEl = useRef<HTMLDivElement | null>(null);
  const searchEl = useRef<HTMLDivElement | null>(null);
  const mapState = useGoogleMap(mapEl);
  const map = mapState.status === "ready" ? mapState.map : null;
  const drawRef = useRef<TerraDraw | null>(null);
  const outlineRef = useRef<google.maps.Polygon | null>(null);
  const [drawReady, setDrawReady] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  function emit(next: AreaSource | null, inputs: PeriodInputs) {
    if (!next || !hydrated) return;
    const p = parsePeriod(inputs, latest);
    if (p.ok) onChange(toSelection(next, p.value));
  }

  function choose(next: AreaSource) {
    setAreaError(null);
    setSource(next);
    emit(next, periodInputs);
  }

  function clearOutline() {
    outlineRef.current?.setMap(null);
    outlineRef.current = null;
  }

  function showOutline(geometry: PolygonGeometry) {
    clearOutline();
    if (drawRef.current) drawRef.current.clear();
    setDrawMode(null);
    if (!map) return;
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    outlineRef.current = new google.maps.Polygon({
      map,
      paths: polys.flatMap((rings) => rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))),
      strokeColor: "#f97316",
      strokeWeight: 2,
      fillColor: "#f97316",
      fillOpacity: 0.08,
      clickable: false,
    });
    map.fitBounds(geometryBounds(geometry));
  }

  function pickPreset(key: RegionKey) {
    showOutline(presetFor(key).geometry);
    choose({ kind: "preset", key });
  }

  /** Convert a polygon to cells and select it. `outline` draws it on the map (not needed for Terra Draw shapes). */
  function applyGeometry(
    label: string | ((cells: string[]) => string),
    geometry: PolygonGeometry,
    outline: boolean,
  ) {
    const res = cellsSource(label, geometry);
    if (!res.ok) {
      setAreaError(res.error);
      return;
    }
    if (outline) showOutline(geometry);
    choose(res.value);
  }

  function submitCircle(e: FormEvent) {
    e.preventDefault();
    const res = parseCircle(circle.lat, circle.lng, circle.radius);
    if (!res.ok) {
      setAreaError(res.error);
      return;
    }
    applyGeometry(res.value.label, res.value.geometry, true);
  }

  function updatePeriod(patch: Partial<typeof period>) {
    const next = { ...period, ...patch };
    setPeriod(next);
    emit(source, { ...next, end: next.end ?? latest });
  }

  function startDrawing(mode: DrawMode) {
    const draw = drawRef.current;
    if (!draw || !drawReady) return;
    clearOutline();
    draw.clear();
    draw.setMode(mode);
    setDrawMode(mode);
  }

  function stopDrawing() {
    drawRef.current?.setMode("static");
    setDrawMode(null);
  }

  const reportMap = useEffectEvent((m: google.maps.Map) => onMapReady?.(m));
  useEffect(() => {
    if (map) reportMap(map);
  }, [map]);

  const onDrawFinish = useEffectEvent((id: string | number) => {
    const draw = drawRef.current;
    if (!draw) return;
    const feature = draw.getSnapshotFeature(id);
    const others = draw
      .getSnapshot()
      .map((f) => f.id)
      .filter((fid): fid is string | number => fid !== undefined && fid !== id);
    if (others.length) draw.removeFeatures(others);
    draw.setMode("static");
    setDrawMode(null);
    if (!feature || feature.geometry.type !== "Polygon") return;
    const kind = String(feature.properties.mode ?? "polygon");
    applyGeometry((cells) => shapeLabel(kind, cells), feature.geometry as PolygonGeometry, false);
  });

  // Terra Draw on the Google map. Modes can only be set after the instance's `ready` event.
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let draw: TerraDraw | null = null;
    Promise.all([import("terra-draw"), import("terra-draw-google-maps-adapter")])
      .then(([td, { TerraDrawGoogleMapsAdapter }]) => {
        if (cancelled) return;
        draw = new td.TerraDraw({
          adapter: new TerraDrawGoogleMapsAdapter({ lib: google.maps, map, coordinatePrecision: 9 }),
          modes: [new td.TerraDrawPolygonMode(), new td.TerraDrawRectangleMode()],
        });
        draw.on("ready", () => {
          if (!cancelled) setDrawReady(true);
        });
        draw.on("finish", (id) => onDrawFinish(id));
        draw.start();
        drawRef.current = draw;
      })
      .catch(() => {
        if (!cancelled) setDrawError("Drawing tools failed to load.");
      });
    return () => {
      cancelled = true;
      draw?.stop();
      drawRef.current = null;
    };
  }, [map]);

  const onPlace = useEffectEvent((place: google.maps.places.Place) => {
    setSearchError(null);
    const label = place.displayName || place.formattedAddress || "Searched place";
    let geometry: PolygonGeometry;
    if (place.viewport) {
      const sw = place.viewport.getSouthWest();
      const ne = place.viewport.getNorthEast();
      geometry = bboxPolygon(sw.lng(), sw.lat(), ne.lng(), ne.lat());
    } else if (place.location) {
      geometry = circlePolygon(place.location.lat(), place.location.lng(), PLACE_FALLBACK_RADIUS_KM);
    } else {
      setSearchError("That place has no location to use as an area.");
      return;
    }
    applyGeometry(label, geometry, true);
    if (place.viewport) map?.fitBounds(place.viewport);
  });

  // Places Autocomplete (Places API New) widget.
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let el: google.maps.places.PlaceAutocompleteElement | null = null;
    importLibrary("places")
      .then(({ PlaceAutocompleteElement }) => {
        const host = searchEl.current;
        if (cancelled || !host) return;
        el = new PlaceAutocompleteElement({ placeholder: "Search a place or region" });
        el.setAttribute("aria-label", "Search a place");
        el.addEventListener("gmp-select", (ev) => {
          const place = ev.placePrediction.toPlace();
          place
            .fetchFields({ fields: ["displayName", "formattedAddress", "viewport", "location"] })
            .then(() => {
              if (!cancelled) onPlace(place);
            })
            .catch(() => {
              if (!cancelled) setSearchError("Could not load that place. Try another search.");
            });
        });
        el.addEventListener("gmp-error", () => {
          if (!cancelled) setSearchError("Place search failed. Check that the Places API (New) is enabled for this key.");
        });
        host.replaceChildren(el);
      })
      .catch(() => {
        if (!cancelled) setSearchError("Place search failed to load.");
      });
    return () => {
      cancelled = true;
      el?.remove();
    };
  }, [map]);

  const mapNotice =
    mapState.status === "no-key"
      ? "Map unavailable: no Google Maps API key is configured. Presets, coordinates and dates still work."
      : mapState.status === "error"
        ? `Map unavailable (${mapState.error}). Presets, coordinates and dates still work.`
        : null;

  const selectedPreset = source?.kind === "preset" ? source.key : null;

  return (
    <div className="flex flex-col gap-4">
      {mapNotice ? (
        <p role="status" className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          {mapNotice}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div ref={searchEl} className="min-w-64 flex-1" />
            <Button
              type="button"
              variant={drawMode === "polygon" ? "default" : "outline"}
              aria-pressed={drawMode === "polygon"}
              disabled={!drawReady}
              onClick={() => startDrawing("polygon")}
            >
              Draw polygon
            </Button>
            <Button
              type="button"
              variant={drawMode === "rectangle" ? "default" : "outline"}
              aria-pressed={drawMode === "rectangle"}
              disabled={!drawReady}
              onClick={() => startDrawing("rectangle")}
            >
              Draw rectangle
            </Button>
            {drawMode && (
              <Button type="button" variant="ghost" onClick={stopDrawing}>
                Cancel drawing
              </Button>
            )}
          </div>
          {drawMode && (
            <p role="status" className="text-sm text-muted-foreground">
              {drawMode === "polygon"
                ? "Click to add points; click the first point to close the shape. Esc cancels."
                : "Click one corner, then the opposite corner."}
            </p>
          )}
          <div
            id={MAP_ELEMENT_ID}
            ref={mapEl}
            aria-label="Map"
            className="h-[420px] w-full overflow-hidden rounded-lg border bg-muted"
          />
          {mapState.status === "loading" && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading map...
            </p>
          )}
          {(drawError || searchError) && (
            <p role="alert" className="text-sm text-destructive">
              {drawError ?? searchError}
            </p>
          )}
        </div>
      )}

      <div role="group" aria-labelledby={`${uid}-presets`} className="flex flex-wrap items-center gap-2">
        <span id={`${uid}-presets`} className="text-sm font-medium">
          Regions
        </span>
        {REGION_PRESETS.map((p) => (
          <Button
            key={p.key}
            type="button"
            variant={selectedPreset === p.key ? "default" : "outline"}
            aria-pressed={selectedPreset === p.key}
            onClick={() => pickPreset(p.key)}
          >
            {p.name}
          </Button>
        ))}
      </div>

      <form onSubmit={submitCircle} className="flex flex-wrap items-end gap-3" aria-label="Circle by coordinates">
        <label className={labelClass}>
          Latitude
          <input
            className={`${inputClass} w-28`}
            inputMode="decimal"
            placeholder="-17.5"
            value={circle.lat}
            onChange={(e) => setCircle({ ...circle, lat: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Longitude
          <input
            className={`${inputClass} w-28`}
            inputMode="decimal"
            placeholder="-57.4"
            value={circle.lng}
            onChange={(e) => setCircle({ ...circle, lng: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Radius (km)
          <input
            className={`${inputClass} w-24`}
            inputMode="decimal"
            value={circle.radius}
            onChange={(e) => setCircle({ ...circle, radius: e.target.value })}
          />
        </label>
        <Button type="submit" variant="outline">
          Use circle
        </Button>
      </form>

      {areaError && (
        <p role="alert" className="text-sm text-destructive">
          {areaError}
        </p>
      )}

      <fieldset className="flex flex-wrap items-end gap-3">
        <legend className="mb-1 text-sm font-medium">Period</legend>
        <label className={labelClass}>
          From
          <input
            type="month"
            className={inputClass}
            min="2000-11"
            max={latest || undefined}
            value={period.start}
            aria-invalid={periodError?.startsWith("Start") || undefined}
            onChange={(e) => updatePeriod({ start: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          To
          <input
            type="month"
            className={inputClass}
            min="2000-11"
            max={latest || undefined}
            value={periodInputs.end}
            aria-invalid={periodError?.startsWith("End") || undefined}
            onChange={(e) => updatePeriod({ end: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Baseline from
          <input
            type="number"
            className={`${inputClass} w-24`}
            min={2000}
            max={latest ? Number(latest.slice(0, 4)) : undefined}
            step={1}
            value={period.baselineFirst}
            onChange={(e) => updatePeriod({ baselineFirst: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Baseline to
          <input
            type="number"
            className={`${inputClass} w-24`}
            min={2000}
            max={latest ? Number(latest.slice(0, 4)) : undefined}
            step={1}
            value={period.baselineLast}
            onChange={(e) => updatePeriod({ baselineLast: e.target.value })}
          />
        </label>
      </fieldset>
      {periodError && (
        <p role="alert" className="text-sm text-destructive">
          {periodError}
        </p>
      )}

      <p role="status" className="text-sm text-muted-foreground">
        {source
          ? `Selected: ${source.kind === "preset" ? presetFor(source.key).name : source.label}${
              source.kind === "cells" ? ` (${source.cells.length.toLocaleString("en-US")} cells)` : ""
            }`
          : "No area selected yet."}
      </p>
    </div>
  );
}
