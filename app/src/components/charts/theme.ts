// Chart colors. Raw sensors use distinct hues; the harmonized series is the strongest line.
import type { SeamSeries } from "./chart-data";

export const SERIES_COLORS: Record<SeamSeries, string> = {
  "MODIS raw": "#d97706",
  "VIIRS raw": "#2563eb",
  Harmonized: "#dc2626",
};

export const NORMAL_COLOR = "currentColor";
export const BAND_COLOR = "#9ca3af";
export const INCOMPLETE_COLOR = "#9ca3af";
