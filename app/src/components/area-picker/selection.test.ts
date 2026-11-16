import { describe, expect, it } from "vitest";
import { SeriesRequest } from "@/lib/contracts";
import { circlePolygon, polygonToCellsR6, presetFor } from "@/lib/geo";
import {
  areaWarnings,
  bboxPolygon,
  cellsSource,
  currentMonth,
  defaultPeriodInputs,
  geometryBounds,
  parseCircle,
  parsePeriod,
  shapeLabel,
  toSelection,
} from "./selection";

const LATEST = "2026-11";
const period = { start: "2000-11", end: "2026-11", baseline: [2003, 2022] as [number, number] };

describe("currentMonth", () => {
  it("formats YYYY-MM in UTC", () => {
    expect(currentMonth(new Date("2026-11-15T12:00:00Z"))).toBe("2026-11");
    expect(currentMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
  });
});

describe("parsePeriod", () => {
  it("accepts the defaults", () => {
    const r = parsePeriod(defaultPeriodInputs(LATEST), LATEST);
    expect(r).toEqual({ ok: true, value: period });
  });

  it.each([
    [{ start: "2000-13" }, "Start month"],
    [{ end: "2026" }, "End month must be YYYY-MM"],
    [{ start: "2000-10" }, "2000-11 or later"],
    [{ end: "2026-12" }, "2026-11 or earlier"],
    [{ start: "2020-05", end: "2020-04" }, "after the start"],
    [{ baselineFirst: "20x3" }, "whole years"],
    [{ baselineFirst: "1999" }, "between 2000 and 2026"],
    [{ baselineLast: "2027" }, "between 2000 and 2026"],
    [{ baselineFirst: "2022", baselineLast: "2003" }, "not be after"],
  ])("rejects %o", (patch, message) => {
    const r = parsePeriod({ ...defaultPeriodInputs(LATEST), ...patch }, LATEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it("accepts a single month and trims baseline years", () => {
    const r = parsePeriod(
      { start: "2020-08", end: "2020-08", baselineFirst: " 2005 ", baselineLast: "2005" },
      LATEST,
    );
    expect(r).toEqual({ ok: true, value: { start: "2020-08", end: "2020-08", baseline: [2005, 2005] } });
  });
});

describe("parseCircle", () => {
  it("builds a circle and label", () => {
    const r = parseCircle("-18", "-57", "50");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.geometry.type).toBe("Polygon");
    expect(r.value.label).toBe("50 km around -18.000, -57.000");
  });

  it.each([
    ["", "0", "10", "Latitude"],
    ["91", "0", "10", "Latitude"],
    ["0", "-181", "10", "Longitude"],
    ["0", "abc", "10", "Longitude"],
    ["0", "0", "0", "Radius"],
    ["0", "0", "5000", "Radius"],
  ])("rejects lat=%s lng=%s r=%s", (lat, lng, r, field) => {
    const res = parseCircle(lat, lng, r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(field);
  });
});

describe("bboxPolygon", () => {
  it("is a closed lng/lat ring", () => {
    const g = bboxPolygon(-58, -19, -56, -17);
    expect(g).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [-58, -19],
          [-56, -19],
          [-56, -17],
          [-58, -17],
          [-58, -19],
        ],
      ],
    });
    expect(polygonToCellsR6(g).length).toBeGreaterThan(100);
  });

  it("unwraps a box crossing the antimeridian", () => {
    const g = bboxPolygon(179, 0, -179, 1);
    expect(g.coordinates[0]).toContainEqual([181, 0]);
  });
});

describe("areaWarnings", () => {
  it("is empty for a mid-sized area inside one region", () => {
    expect(areaWarnings(polygonToCellsR6(circlePolygon(-18, -57, 30)))).toEqual([]);
  });

  it("warns about small areas", () => {
    const w = areaWarnings(polygonToCellsR6(circlePolygon(-18, -57, 8)));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/under 500 km\^2/);
  });

  it("says plainly that outside areas are rejected", () => {
    const w = areaWarnings(polygonToCellsR6(circlePolygon(0, 0, 50)));
    expect(w.some((x) => /outside the three covered regions.*rejects/.test(x))).toBe(true);
  });

  it("flags areas that extend past a region edge", () => {
    const p = presetFor("pantanal");
    const [w, , , n] = p.bbox;
    // A circle on the bbox corner straddles the region boundary.
    const warnings = areaWarnings(polygonToCellsR6(circlePolygon(n, w, 150)));
    expect(warnings.some((x) => /cells fall outside .*left out/.test(x))).toBe(true);
  });

  it("flags areas spanning two regions", () => {
    const cells = [
      ...polygonToCellsR6(circlePolygon(-18, -57, 30)),
      ...polygonToCellsR6(presetFor("punjab").geometry).slice(0, 50),
    ];
    const w = areaWarnings(cells);
    expect(w.some((x) => /more than one covered region.*rejects mixed/.test(x))).toBe(true);
  });
});

describe("cellsSource and toSelection", () => {
  it("produces a valid series request for a typed circle", () => {
    const circle = parseCircle("-18", "-57", "40");
    if (!circle.ok) throw new Error(circle.error);
    const src = cellsSource(circle.value.label, circle.value.geometry);
    if (!src.ok) throw new Error(src.error);
    const sel = toSelection(src.value, period);
    expect(sel.region).toBeNull();
    expect(sel.cells.length).toBeGreaterThan(50);
    expect(sel.warnings).toEqual([]);
    expect(sel.label).toBe(circle.value.label);
    expect(
      SeriesRequest.safeParse({ cells: sel.cells, start: sel.start, end: sel.end, baseline: sel.baseline }).success,
    ).toBe(true);
  });

  it("uses a label function with the computed cells", () => {
    const src = cellsSource((cells) => shapeLabel("rectangle", cells), bboxPolygon(-58, -19, -57, -18));
    if (!src.ok) throw new Error(src.error);
    expect(src.value.kind === "cells" && src.value.label).toMatch(/^Drawn rectangle, about [\d,]+ km\^2$/);
  });

  it("rejects an area with no cells", () => {
    const r = cellsSource("tiny", circlePolygon(-18, -57, 0.5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too small/);
  });

  it("rejects an area over the cell limit", () => {
    const r = cellsSource("huge", circlePolygon(50, -110, 1000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/over the 50000 limit/);
  });

  it("builds a preset selection with no cells", () => {
    const sel = toSelection({ kind: "preset", key: "pantanal" }, period);
    expect(sel).toMatchObject({ region: "pantanal", cells: [], warnings: [], label: presetFor("pantanal").name });
    expect(SeriesRequest.safeParse({ region: sel.region, end: sel.end }).success).toBe(true);
  });

  it("copies the baseline so callers cannot mutate shared state", () => {
    const sel = toSelection({ kind: "preset", key: "punjab" }, period);
    expect(sel.baseline).toEqual(period.baseline);
    expect(sel.baseline).not.toBe(period.baseline);
  });
});

describe("geometryBounds", () => {
  it("returns the box of the outer rings", () => {
    expect(geometryBounds(bboxPolygon(-58, -19, -56, -17))).toEqual({ west: -58, south: -19, east: -56, north: -17 });
  });
});
