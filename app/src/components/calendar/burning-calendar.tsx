"use client";
// Accessible burning calendar (#19): years x months grid, counts or anomaly coloring,
// roving-tabindex keyboard navigation, tooltip on hover/focus and a table view.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SeriesResponse } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import {
  MONTH_LABELS,
  MONTH_NAMES,
  buildGrid,
  isNavKey,
  monthLabel,
  moveFocus,
  type CalendarCell,
} from "./calendar-grid";
import { contrastText, makeScale, type CalendarMode } from "./calendar-scales";
import { cellAriaLabel, cellFlags, tableRow, tooltipRows } from "./calendar-format";
import { CalendarLegend } from "./calendar-legend";
import { CalendarTable } from "./calendar-table";
import { HATCH_LINE, HatchPattern } from "./calendar-hatch";

export type BurningCalendarProps = {
  series: SeriesResponse;
  highlightMonths?: string[]; // YYYY-MM, e.g. months the AI analyst referenced
  selectedMonth?: string | null;
  onSelectMonth?: (month: string) => void;
};

// Layout, in SVG user units.
const CELL_W = 30;
const CELL_H = 20;
const GAP = 5;
const LEFT = 44;
const TOP = 22;
const PAD = 6;
const PITCH_X = CELL_W + GAP;
const PITCH_Y = CELL_H + GAP;

export function BurningCalendar({
  series,
  highlightMonths,
  selectedMonth,
  onSelectMonth,
}: BurningCalendarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hatchId = `${uid}-hatch`;
  const helpId = `${uid}-help`;
  const tipId = `${uid}-tip`;

  const [mode, setMode] = useState<CalendarMode>("counts");
  const [showTable, setShowTable] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [hoverMonth, setHoverMonth] = useState<string | null>(null);
  const [focusMonth, setFocusMonth] = useState<string | null>(null);
  const [tipHidden, setTipHidden] = useState(false);
  const cellRefs = useRef(new Map<string, SVGGElement>());

  const grid = useMemo(() => buildGrid(series), [series]);
  const scale = useMemo(() => makeScale(mode, series.months), [mode, series.months]);
  const highlighted = useMemo(() => new Set(highlightMonths ?? []), [highlightMonths]);

  const lastMonth = grid.months[grid.months.length - 1] ?? null;
  const activeMonth =
    active && grid.byMonth.has(active)
      ? active
      : selectedMonth && grid.byMonth.has(selectedMonth)
        ? selectedMonth
        : lastMonth;

  const width = LEFT + 12 * PITCH_X + PAD;
  const height = TOP + grid.rows.length * PITCH_Y + PAD;
  const cellX = (monthIndex: number) => LEFT + monthIndex * PITCH_X;
  const cellY = (rowIndex: number) => TOP + rowIndex * PITCH_Y;
  const firstYear = grid.rows[0]?.year ?? 0;

  const tipMonth = tipHidden ? null : (hoverMonth ?? focusMonth);
  const tipCell = tipMonth ? grid.byMonth.get(tipMonth) : undefined;

  function focusMonthCell(month: string) {
    setActive(month);
    cellRefs.current.get(month)?.focus();
  }

  function onCellKeyDown(e: KeyboardEvent<SVGGElement>, cell: CalendarCell) {
    if (isNavKey(e.key)) {
      e.preventDefault();
      focusMonthCell(moveFocus(grid, cell.month, e.key, e.ctrlKey || e.metaKey));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive(cell.month);
      onSelectMonth?.(cell.month);
    } else if (e.key === "Escape") {
      setTipHidden(true);
    }
  }

  if (grid.months.length === 0) {
    return (
      <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
        <h2 id={`${uid}-title`} className="text-lg font-semibold">
          Burning calendar
        </h2>
        <p className="text-muted-foreground text-sm">No months in this range.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${uid}-title`} className="text-lg font-semibold">
          Burning calendar
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Color by" className="flex gap-1">
            <Button
              size="sm"
              variant={mode === "counts" ? "default" : "outline"}
              aria-pressed={mode === "counts"}
              onClick={() => setMode("counts")}
            >
              Counts
            </Button>
            <Button
              size="sm"
              variant={mode === "anomaly" ? "default" : "outline"}
              aria-pressed={mode === "anomaly"}
              onClick={() => setMode("anomaly")}
            >
              Anomaly
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "View as calendar" : "View as table"}
          </Button>
        </div>
      </div>

      <CalendarLegend scale={scale} idPrefix={uid} />

      {showTable ? (
        <CalendarTable
          rows={grid.months.map((m) => tableRow(grid.byMonth.get(m)!))}
          highlighted={highlighted}
          selectedMonth={selectedMonth ?? null}
          onSelectMonth={onSelectMonth}
        />
      ) : (
        <div className="relative w-full max-w-[560px]">
          <p id={helpId} className="sr-only">
            Rows are years, columns are months. Arrow keys move by month and year, Home and End
            jump to the start or end of the year, Control plus Home or End to the first or last
            month. Enter or Space selects a month.
          </p>
          <svg
            role="grid"
            aria-label={`Burning calendar, ${scale.mode === "counts" ? "fire counts" : "anomaly"}, ${monthLabel(grid.months[0])} to ${monthLabel(lastMonth!)}`}
            aria-describedby={helpId}
            aria-rowcount={grid.rows.length + 1}
            aria-colcount={13}
            viewBox={`0 0 ${width} ${height}`}
            className="text-foreground h-auto w-full select-none"
            onMouseLeave={() => setHoverMonth(null)}
          >
            <defs>
              <HatchPattern id={hatchId} />
            </defs>

            <g role="row" aria-rowindex={1}>
              <text role="columnheader" aria-colindex={1} x={LEFT - 8} y={TOP - 8} textAnchor="end" fontSize={10} className="fill-muted-foreground">
                Year
              </text>
              {MONTH_LABELS.map((label, i) => (
                <text
                  key={label}
                  role="columnheader"
                  aria-colindex={i + 2}
                  aria-label={MONTH_NAMES[i]}
                  x={cellX(i) + CELL_W / 2}
                  y={TOP - 8}
                  textAnchor="middle"
                  fontSize={10}
                  className="fill-muted-foreground"
                >
                  {label}
                </text>
              ))}
            </g>

            {grid.rows.map((row, r) => (
              <g key={row.year} role="row" aria-rowindex={r + 2}>
                <text
                  role="rowheader"
                  aria-colindex={1}
                  x={LEFT - 8}
                  y={cellY(r) + CELL_H / 2}
                  dominantBaseline="central"
                  textAnchor="end"
                  fontSize={10}
                  className="fill-muted-foreground"
                >
                  {row.year}
                </text>
                {row.cells.map((cell, i) => {
                  if (!cell) {
                    return <g key={i} role="gridcell" aria-colindex={i + 2} aria-label="outside range" />;
                  }
                  const x = cellX(i);
                  const y = cellY(r);
                  const fill = scale.color(cell.data);
                  const ink = fill ? contrastText(fill) : "#000000";
                  const z = cell.data.z;
                  const marker =
                    mode === "anomaly" && fill && z !== null && Math.abs(z) >= 2
                      ? z > 0
                        ? "▲"
                        : "▼"
                      : null;
                  const isSelected = cell.month === selectedMonth;
                  return (
                    <g
                      key={cell.month}
                      ref={(el) => {
                        if (el) cellRefs.current.set(cell.month, el);
                        else cellRefs.current.delete(cell.month);
                      }}
                      role="gridcell"
                      aria-colindex={i + 2}
                      aria-selected={isSelected}
                      aria-label={cellAriaLabel(cell, {
                        highlighted: highlighted.has(cell.month),
                        selected: isSelected,
                      })}
                      tabIndex={cell.month === activeMonth ? 0 : -1}
                      className="cursor-pointer outline-none"
                      onKeyDown={(e) => onCellKeyDown(e, cell)}
                      onFocus={() => {
                        setActive(cell.month);
                        setFocusMonth(cell.month);
                        setTipHidden(false);
                      }}
                      onBlur={() => setFocusMonth((m) => (m === cell.month ? null : m))}
                      onMouseEnter={() => {
                        setHoverMonth(cell.month);
                        setTipHidden(false);
                      }}
                      onClick={() => {
                        setActive(cell.month);
                        onSelectMonth?.(cell.month);
                      }}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={CELL_W}
                        height={CELL_H}
                        rx={2}
                        fill={fill ?? `url(#${hatchId})`}
                        stroke={fill ? "none" : HATCH_LINE}
                        strokeWidth={fill ? 0 : 0.75}
                      />
                      {cell.provisional && (
                        <rect
                          x={x + 1.5}
                          y={y + 1.5}
                          width={CELL_W - 3}
                          height={CELL_H - 3}
                          rx={1.5}
                          fill="none"
                          stroke={ink}
                          strokeWidth={1.2}
                          strokeDasharray="1.5 1.5"
                        />
                      )}
                      {cell.partial && (
                        <path
                          d={`M${x + CELL_W - 8},${y} L${x + CELL_W},${y} L${x + CELL_W},${y + 8} Z`}
                          fill={ink}
                        />
                      )}
                      {marker && (
                        <text
                          x={x + CELL_W / 2}
                          y={y + CELL_H / 2}
                          dominantBaseline="central"
                          textAnchor="middle"
                          fontSize={9}
                          fill={ink}
                          aria-hidden="true"
                        >
                          {marker}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}

            {/* Rings, drawn last so neighbors do not cover them. */}
            <g aria-hidden="true" pointerEvents="none" fill="none">
              {grid.months.map((month) => {
                const cell = grid.byMonth.get(month)!;
                const x = cellX(cell.monthIndex);
                const y = cellY(cell.year - firstYear);
                const rings = [];
                if (highlighted.has(month)) {
                  rings.push(
                    <rect key="h" x={x - 1.5} y={y - 1.5} width={CELL_W + 3} height={CELL_H + 3} rx={3} stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 2" />,
                  );
                }
                if (month === selectedMonth) {
                  rings.push(
                    <rect key="s" x={x - 2} y={y - 2} width={CELL_W + 4} height={CELL_H + 4} rx={3} stroke="currentColor" strokeWidth={2.5} />,
                  );
                }
                if (month === focusMonth) {
                  rings.push(
                    <rect key="f" x={x - 4} y={y - 4} width={CELL_W + 8} height={CELL_H + 8} rx={4} stroke="#2563eb" strokeWidth={2} />,
                  );
                }
                return rings.length ? <g key={month}>{rings}</g> : null;
              })}
            </g>
          </svg>

          {tipCell && (
            <CalendarTooltip
              id={tipId}
              cell={tipCell}
              highlighted={highlighted.has(tipCell.month)}
              left={((cellX(tipCell.monthIndex) + CELL_W / 2) / width) * 100}
              top={((cellY(tipCell.year - firstYear) + (tipCell.year - firstYear < 4 ? CELL_H + 6 : -6)) / height) * 100}
              below={tipCell.year - firstYear < 4}
              align={tipCell.monthIndex < 3 ? "start" : tipCell.monthIndex > 8 ? "end" : "center"}
            />
          )}
        </div>
      )}
    </section>
  );
}

function CalendarTooltip({
  id,
  cell,
  highlighted,
  left,
  top,
  below,
  align,
}: {
  id: string;
  cell: CalendarCell;
  highlighted: boolean;
  left: number;
  top: number;
  below: boolean;
  align: "start" | "center" | "end";
}) {
  const tx = align === "start" ? "-10%" : align === "end" ? "-90%" : "-50%";
  const ty = below ? "0" : "-100%";
  const flags = cellFlags(cell);
  if (highlighted) flags.push("referenced by the analyst");
  return (
    <div
      id={id}
      role="tooltip"
      className="bg-popover text-popover-foreground pointer-events-none absolute z-10 w-60 rounded-md border p-2 text-xs shadow-md"
      style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${tx}, ${ty})` }}
    >
      <p className="mb-1 font-semibold">{monthLabel(cell.month)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {tooltipRows(cell.data).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      {flags.length > 0 && <p className="mt-1 font-medium">{flags.join("; ")}</p>}
    </div>
  );
}
