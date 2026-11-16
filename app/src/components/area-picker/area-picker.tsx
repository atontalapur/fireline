"use client";
// Stub. Replaced by #17 (map area picker).
import type { AreaSelection } from "@/lib/contracts";
import { DEFAULT_BASELINE, DEFAULT_START } from "@/lib/contracts";

export type AreaPickerProps = {
  onChange: (selection: AreaSelection) => void;
  onMapReady?: (map: google.maps.Map) => void;
};

export function AreaPicker({ onChange }: AreaPickerProps) {
  return (
    <button
      type="button"
      className="rounded border px-3 py-1"
      onClick={() =>
        onChange({
          label: "Brazilian Pantanal",
          region: "pantanal",
          cells: [],
          start: DEFAULT_START,
          end: new Date().toISOString().slice(0, 7),
          baseline: DEFAULT_BASELINE,
          warnings: [],
        })
      }
    >
      Pantanal
    </button>
  );
}
