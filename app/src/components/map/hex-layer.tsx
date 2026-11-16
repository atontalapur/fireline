"use client";
// Stub. Replaced by #27 (monthly hexagon map layer).
import type { AreaSelection } from "@/lib/contracts";

export type HexLayerProps = {
  map: google.maps.Map | null;
  selection: AreaSelection | null;
  month: string | null; // YYYY-MM
};

export function HexLayer(props: HexLayerProps) {
  void props;
  return null;
}
