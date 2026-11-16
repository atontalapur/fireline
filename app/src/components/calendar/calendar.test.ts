import { describe, expect, it } from "vitest";
import { SeriesResponse } from "@/lib/contracts";
import mock from "../../../../contracts/mock/series-pantanal.json";
import { buildGrid, daysInMonth, moveFocus, toCell } from "./calendar-grid";
import {
  Z_UNAVAILABLE_FILL,
  contrastText,
  countPosition,
  countTicks,
  makeScale,
  maxHarmonized,
  zColor,
  zPosition,
  zTicks,
} from "./calendar-scales";
import {
  cellAriaLabel,
  cellFlags,
  formatBand,
  formatCount,
  formatZ,
  tableRow,
  tooltipRows,
} from "./calendar-format";

const series = SeriesResponse.parse(mock);
const grid = buildGrid(series);

describe("buildGrid", () => {
  it("has one row per year and 12 columns, blank outside the range", () => {
    expect(grid.rows[0].year).toBe(2000);
    expect(grid.rows[grid.rows.length - 1].year).toBe(2026);
    expect(grid.rows).toHaveLength(27);
    for (const row of grid.rows) expect(row.cells).toHaveLength(12);
    // 2000 starts in November.
    expect(grid.rows[0].cells.slice(0, 10).every((c) => c === null)).toBe(true);
    expect(grid.rows[0].cells[10]?.month).toBe("2000-11");
    // 2026 ends in October.
    expect(grid.rows[26].cells[9]?.month).toBe("2026-10");
    expect(grid.rows[26].cells.slice(10).every((c) => c === null)).toBe(true);
    expect(grid.months).toHaveLength(series.months.length);
  });

  it("marks no-data, provisional and partial months", () => {
    const nodata = grid.byMonth.get("2001-07")!;
    expect(nodata.status).toBe("nodata");
    expect(nodata.partial).toBe(false);

    const current = grid.byMonth.get("2026-10")!;
    expect(current.status).toBe("data");
    expect(current.provisional).toBe(true);
    expect(current.partial).toBe(true);
    expect(current.daysInMonth).toBe(31);

    expect(grid.byMonth.get("2026-09")!.partial).toBe(false);
  });

  it("treats a zero count as data, not missing", () => {
    const zero = toCell({ ...series.months[0], harmonized: 0, lo: 0, hi: 0 });
    expect(zero.status).toBe("data");
  });

  it("knows leap years", () => {
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2023, 1)).toBe(28);
  });

  it("handles an empty series", () => {
    const g = buildGrid({ months: [] });
    expect(g.rows).toEqual([]);
    expect(moveFocus(g, "2020-01", "ArrowLeft")).toBe("2020-01");
  });
});

describe("moveFocus", () => {
  it("moves by month, wrapping across years, and clamps at the ends", () => {
    expect(moveFocus(grid, "2005-12", "ArrowRight")).toBe("2006-01");
    expect(moveFocus(grid, "2006-01", "ArrowLeft")).toBe("2005-12");
    expect(moveFocus(grid, "2000-11", "ArrowLeft")).toBe("2000-11");
    expect(moveFocus(grid, "2026-10", "ArrowRight")).toBe("2026-10");
  });

  it("moves by year and stays put when the target is outside the range", () => {
    expect(moveFocus(grid, "2010-06", "ArrowUp")).toBe("2009-06");
    expect(moveFocus(grid, "2010-06", "ArrowDown")).toBe("2011-06");
    expect(moveFocus(grid, "2001-03", "ArrowUp")).toBe("2001-03");
    expect(moveFocus(grid, "2025-12", "ArrowDown")).toBe("2025-12");
  });

  it("jumps with Home/End inside the row and Ctrl+Home/End or PageUp/PageDown overall", () => {
    expect(moveFocus(grid, "2010-06", "Home")).toBe("2010-01");
    expect(moveFocus(grid, "2010-06", "End")).toBe("2010-12");
    expect(moveFocus(grid, "2000-12", "Home")).toBe("2000-11");
    expect(moveFocus(grid, "2026-03", "End")).toBe("2026-10");
    expect(moveFocus(grid, "2010-06", "Home", true)).toBe("2000-11");
    expect(moveFocus(grid, "2010-06", "End", true)).toBe("2026-10");
    expect(moveFocus(grid, "2010-06", "PageUp")).toBe("2000-11");
    expect(moveFocus(grid, "2010-06", "PageDown")).toBe("2026-10");
  });

  it("recovers from a month that is not in the grid", () => {
    expect(moveFocus(grid, "1999-01", "ArrowRight")).toBe("2026-10");
  });
});

describe("scales", () => {
  it("counts: log1p from 0 to the max, null for no data", () => {
    const max = maxHarmonized(series.months);
    expect(max).toBeGreaterThan(0);
    expect(countPosition(0, max)).toBe(0);
    expect(countPosition(max, max)).toBe(1);
    expect(countPosition(10, max)).toBeCloseTo(Math.log1p(10) / Math.log1p(max));
    const scale = makeScale("counts", series.months);
    expect(scale.color(grid.byMonth.get("2001-07")!.data)).toBeNull();
    const zeroColor = scale.color({ ...series.months[0], harmonized: 0 });
    expect(zeroColor).toBe(scale.ramp(0));
  });

  it("counts ticks are labeled, increasing and end at the max", () => {
    const max = maxHarmonized(series.months);
    const ticks = countTicks(max);
    expect(ticks[0]).toMatchObject({ value: 0, position: 0, label: "0" });
    expect(ticks[ticks.length - 1].value).toBe(max);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].position).toBeGreaterThan(ticks[i - 1].position);
    }
    expect(countTicks(0)).toHaveLength(1);
  });

  it("anomaly: centered on z = 0 and clamped at +/-3", () => {
    expect(zPosition(0)).toBe(0.5);
    expect(zPosition(3)).toBe(1);
    expect(zPosition(10)).toBe(1);
    expect(zPosition(-10)).toBe(0);
    expect(zColor(10)).toBe(zColor(3));
    expect(zColor(2)).not.toBe(zColor(-2));
    const ticks = zTicks();
    expect(ticks.map((t) => t.value)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(ticks[0].label.startsWith("≤")).toBe(true);
    expect(ticks[6].label).toBe("≥+3");
  });

  it("anomaly: no data is null, missing z gets the neutral fill", () => {
    const scale = makeScale("anomaly", series.months);
    expect(scale.color(grid.byMonth.get("2001-07")!.data)).toBeNull();
    expect(scale.color({ ...series.months[0], z: null })).toBe(Z_UNAVAILABLE_FILL);
    expect(scale.color({ ...series.months[0], z: 1 })).toBe(zColor(1));
  });

  it("picks readable text on dark and light fills", () => {
    expect(contrastText("rgb(0, 32, 81)")).toBe("#ffffff");
    expect(contrastText("rgb(253, 234, 69)")).toBe("#000000");
    expect(contrastText("#a3a3a3")).toBe("#000000");
  });
});

describe("format", () => {
  it("formats numbers", () => {
    expect(formatCount(461.367)).toBe("461.4");
    expect(formatCount(2645.455)).toBe("2,645.5");
    expect(formatCount(null)).toBe("—");
    expect(formatBand(437.134, 480.148)).toBe("437.1–480.1");
    expect(formatZ(3.738)).toBe("+3.74");
    expect(formatZ(-0.814)).toBe("−0.81");
    expect(formatZ(0)).toBe("0.00");
  });

  it("tooltip covers every field", () => {
    const rows = tooltipRows(grid.byMonth.get("2026-10")!.data);
    expect(rows.map((r) => r.label)).toEqual([
      "Harmonized",
      "90% band",
      "Baseline median",
      "z",
      "Percentile",
      "Raw MODIS",
      "Raw VIIRS",
      "Source",
    ]);
    expect(rows[0].value).toBe("99.3");
    expect(rows[1].value).toBe("95.7–103.6");
    expect(rows[3].value).toBe("−0.81");
    expect(rows[4].value).toBe("20");
    expect(rows[7].value).toBe("VIIRS, scaled to MODIS");
  });

  it("says no data, provisional and partial in words", () => {
    const nodata = grid.byMonth.get("2001-07")!;
    expect(tooltipRows(nodata.data)[0].value).toBe("no data");
    expect(cellFlags(nodata)).toEqual(["no satellite data"]);
    expect(cellAriaLabel(nodata)).toContain("no satellite data");

    const current = grid.byMonth.get("2026-10")!;
    expect(cellFlags(current)).toEqual(["provisional", "partial: 28 of 31 days"]);
    const label = cellAriaLabel(current, { highlighted: true, selected: true });
    expect(label).toContain("October 2026");
    expect(label).toContain("provisional");
    expect(label).toContain("partial month, 28 of 31 days");
    expect(label).toContain("referenced by the analyst");
    expect(label).toContain("selected");
  });

  it("table rows carry the same numbers", () => {
    const row = tableRow(grid.byMonth.get("2026-10")!);
    expect(row).toMatchObject({
      month: "2026-10",
      label: "October 2026",
      harmonized: "99.3",
      band: "95.7–103.6",
      median: "127.0",
      z: "−0.81",
      percentile: "20",
      modis: "83.0",
      viirs: "325.7",
      flags: "provisional; partial: 28 of 31 days",
    });
    expect(tableRow(grid.byMonth.get("2026-09")!).flags).toBe("");
  });
});
