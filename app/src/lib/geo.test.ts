import { describe, expect, it } from "vitest";
import {
  REGION_PRESETS,
  cellsAreaKm2,
  circlePolygon,
  polygonToCellsR6,
  presetFor,
  regionOfCell,
  regionOfCells,
} from "@/lib/geo";

describe("geo", () => {
  it("loads the three presets", () => {
    expect(REGION_PRESETS.map((p) => p.key).sort()).toEqual(["pantanal", "punjab", "w_canada"]);
  });

  it("turns a circle into res-6 cells with a sane area", () => {
    const cells = polygonToCellsR6(circlePolygon(-18, -57, 50));
    const area = cellsAreaKm2(cells);
    expect(area).toBeGreaterThan(0.8 * Math.PI * 50 * 50);
    expect(area).toBeLessThan(1.2 * Math.PI * 50 * 50);
  });

  it("assigns cells to regions", () => {
    const cells = polygonToCellsR6(circlePolygon(-18, -57, 30));
    expect(regionOfCells(cells)).toMatchObject({ region: "pantanal", mixed: false });
    expect(regionOfCell(polygonToCellsR6(circlePolygon(0, 0, 20))[0])).toBeNull();
  });

  it("covers the Punjab preset", () => {
    const cells = polygonToCellsR6(presetFor("punjab").geometry);
    expect(cells.length).toBeGreaterThan(1000);
  });
});
