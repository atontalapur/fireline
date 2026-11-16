"use client";
import { useEffect, useState, type RefObject } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

export type MapState =
  | { status: "no-key" }
  | { status: "loading" }
  | { status: "ready"; map: google.maps.Map }
  | { status: "error"; error: string };

let optionsSet = false;

/** Load the Maps JS API and create a hybrid map in `container`. Without a key nothing is loaded. */
export function useGoogleMap(container: RefObject<HTMLDivElement | null>): MapState {
  const [state, setState] = useState<MapState>(() =>
    GOOGLE_MAPS_API_KEY ? { status: "loading" } : { status: "no-key" },
  );

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) return;
    let cancelled = false;
    const fail = (error: string) => {
      if (!cancelled) setState({ status: "error", error });
    };
    // The Maps JS API calls this global when the key is rejected (invalid key, referrer or billing).
    const w = window as unknown as { gm_authFailure?: () => void };
    w.gm_authFailure = () => fail("Google Maps rejected the API key.");

    if (!optionsSet) {
      setOptions({ key: GOOGLE_MAPS_API_KEY, v: "weekly" });
      optionsSet = true;
    }
    importLibrary("maps")
      .then(({ Map: GoogleMap }) => {
        const el = container.current;
        if (cancelled || !el) return;
        const map = new GoogleMap(el, {
          center: { lat: 10, lng: 0 },
          zoom: 2,
          mapTypeId: "hybrid",
          mapTypeControl: true,
          mapTypeControlOptions: { mapTypeIds: ["roadmap", "terrain", "satellite", "hybrid"] },
          streetViewControl: false,
          fullscreenControl: true,
        });
        setState({ status: "ready", map });
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : "Google Maps failed to load."));

    return () => {
      cancelled = true;
      if (w.gm_authFailure) delete w.gm_authFailure;
    };
  }, [container]);

  return state;
}
