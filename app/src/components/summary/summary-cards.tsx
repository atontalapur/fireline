"use client";
import { useMemo } from "react";
import type { SeriesResponse } from "@/lib/contracts";
import { buildCards } from "./cards";

export function SummaryCards({ series }: { series: SeriesResponse }) {
  const cards = useMemo(() => buildCards(series), [series]);
  if (cards.length === 0) return null;
  return (
    <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <article key={card.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{card.title}</h3>
          <p className="text-base leading-snug font-semibold">{card.headline}</p>
          {card.detail && <p className="text-sm text-muted-foreground">{card.detail}</p>}
          {card.flags.length > 0 && (
            <ul className="mt-auto flex flex-col gap-1">
              {card.flags.map((flag) => (
                <li
                  key={flag}
                  className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
                >
                  {flag}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
