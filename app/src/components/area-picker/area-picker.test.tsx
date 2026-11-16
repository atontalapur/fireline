import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { REGION_PRESETS } from "@/lib/geo";
import { AreaPicker } from "./area-picker";

describe.skipIf(Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY))("AreaPicker server render without a Maps key", () => {
  const html = renderToString(<AreaPicker onChange={() => {}} />);

  it("shows the no-map notice instead of the map", () => {
    expect(html).toContain("Map unavailable: no Google Maps API key is configured");
    expect(html).not.toContain('id="area-picker-map"');
  });

  it("keeps presets, coordinates and dates", () => {
    for (const p of REGION_PRESETS) expect(html).toContain(p.name);
    expect(html).toContain("Latitude");
    expect(html).toContain("Radius (km)");
    expect(html).toContain('value="2000-11"');
    expect(html).toContain('value="2003"');
    expect(html).toContain('value="2022"');
  });
});
