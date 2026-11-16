import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SeriesResponse } from "@/lib/contracts";
import mock from "../../../../contracts/mock/series-pantanal.json";
import { BurningCalendar } from "./burning-calendar";

const series = SeriesResponse.parse(mock);

describe("BurningCalendar render", () => {
  it("renders the grid with one focusable cell, rings and marks", () => {
    const html = renderToStaticMarkup(
      <BurningCalendar
        series={series}
        highlightMonths={["2020-09"]}
        selectedMonth="2024-08"
        onSelectMonth={() => {}}
      />,
    );
    expect(html).toContain('role="grid"');
    expect((html.match(/role="gridcell"/g) ?? []).length).toBe(27 * 12);
    expect((html.match(/role="gridcell"[^>]*tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("referenced by the analyst");
    expect(html).toContain("no satellite data");
    expect(html).toContain("partial month, 28 of 31 days");
    expect(html).toContain("View as table");
  });

  it("renders an empty state", () => {
    const html = renderToStaticMarkup(
      <BurningCalendar series={{ ...series, months: [] }} />,
    );
    expect(html).toContain("No months in this range.");
  });
});
