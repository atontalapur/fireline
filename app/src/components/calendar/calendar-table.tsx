// Table view of the calendar: the same numbers, one row per month.
import { cn } from "@/lib/utils";
import type { TableRow } from "./calendar-format";

export function CalendarTable({
  rows,
  highlighted,
  selectedMonth,
  onSelectMonth,
}: {
  rows: TableRow[];
  highlighted: Set<string>;
  selectedMonth: string | null;
  onSelectMonth?: (month: string) => void;
}) {
  return (
    <div
      className="max-h-[480px] overflow-auto rounded-md border"
      role="region"
      aria-label="Monthly fire counts table"
      tabIndex={0}
    >
      <table className="w-full border-collapse text-xs tabular-nums">
        <caption className="text-muted-foreground p-2 text-left">
          Monthly fire counts (MODIS-equivalent fire cell-days) with 90% band, baseline median,
          robust z, percentile, raw sensor counts and source. Select a month to show it on the
          map.
        </caption>
        <thead className="bg-muted sticky top-0">
          <tr>
            <th scope="col" className="p-1.5 text-left">Month</th>
            <th scope="col" className="p-1.5 text-right">Harmonized</th>
            <th scope="col" className="p-1.5 text-right">90% band</th>
            <th scope="col" className="p-1.5 text-right">Baseline median</th>
            <th scope="col" className="p-1.5 text-right">z</th>
            <th scope="col" className="p-1.5 text-right">Percentile</th>
            <th scope="col" className="p-1.5 text-right">Raw MODIS</th>
            <th scope="col" className="p-1.5 text-right">Raw VIIRS</th>
            <th scope="col" className="p-1.5 text-left">Source</th>
            <th scope="col" className="p-1.5 text-left">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSelected = r.month === selectedMonth;
            const isHighlighted = highlighted.has(r.month);
            const notes = [r.flags, isHighlighted ? "referenced by analyst" : ""]
              .filter(Boolean)
              .join("; ");
            return (
              <tr
                key={r.month}
                className={cn("border-t", isSelected && "bg-accent font-semibold", isHighlighted && "outline-1 outline-dashed -outline-offset-1")}
              >
                <th scope="row" className="p-1.5 text-left font-normal">
                  {onSelectMonth ? (
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline focus-visible:ring-ring rounded focus-visible:ring-2 focus-visible:outline-none"
                      aria-pressed={isSelected}
                      onClick={() => onSelectMonth(r.month)}
                    >
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </th>
                <td className="p-1.5 text-right">{r.harmonized}</td>
                <td className="p-1.5 text-right">{r.band}</td>
                <td className="p-1.5 text-right">{r.median}</td>
                <td className="p-1.5 text-right">{r.z}</td>
                <td className="p-1.5 text-right">{r.percentile}</td>
                <td className="p-1.5 text-right">{r.modis}</td>
                <td className="p-1.5 text-right">{r.viirs}</td>
                <td className="p-1.5">{r.source}</td>
                <td className="p-1.5">{notes || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
