// Inline legend with line or block swatches.
export type LegendItem = { label: string; color: string; kind?: "line" | "dashed" | "block" };

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={
              item.kind === "block"
                ? "inline-block h-3 w-3 rounded-sm opacity-60"
                : item.kind === "dashed"
                  ? "inline-block w-4 border-t-2 border-dashed"
                  : "inline-block h-0.5 w-4"
            }
            style={item.kind === "dashed" ? { borderColor: item.color } : { backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
