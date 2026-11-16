// Mocked fire tools for chat tests. Series outputs come from the shared contract mock.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { fireTools } from "@/lib/fire-tools";
import type { CompareToBaselineOutput, GetSeriesOutput, ResolveAreaOutput } from "@/lib/fire-tools";
import type { FireToolSet } from "../example-answers";

export const SERIES: GetSeriesOutput = JSON.parse(
  readFileSync(resolve(process.cwd(), "../contracts/mock/series-pantanal.json"), "utf8"),
);

export function compareFor(input: { month?: string; year?: number }): CompareToBaselineOutput {
  if (input.month)
    return {
      period: input.month,
      value: 2210.667,
      median: 512.25,
      ratio: 4.32,
      z: 3.912,
      percentile: 97.5,
      rank: 2,
      of: 26,
      provisional: false,
      warnings: [],
    };
  return {
    period: String(input.year),
    value: 5432.123,
    median: 2101.5,
    ratio: 2.58,
    z: 2.4,
    percentile: 95,
    rank: 2,
    of: 24,
    provisional: true,
    warnings: ["Provisional (NRT or incomplete) months: 2024-12."],
  };
}

export const RESOLVED: ResolveAreaOutput = {
  label: "Cuiaba",
  region: null,
  cells: ["86a8e1a27ffffff", "86a8e1a2fffffff"],
  area_km2: 72.4,
  warnings: [],
};

/** Fire tools with mocked executes; `outputs` collects every value they return. */
export function mockTools() {
  const outputs: unknown[] = [];
  const record = <T>(v: T) => {
    outputs.push(v);
    return v;
  };
  const tools: FireToolSet = {
    resolve_area: { ...fireTools.resolve_area, execute: vi.fn(async () => record(RESOLVED)) },
    get_series: { ...fireTools.get_series, execute: vi.fn(async () => record(structuredClone(SERIES))) },
    compare_to_baseline: {
      ...fireTools.compare_to_baseline,
      execute: vi.fn(async (input: { month?: string; year?: number }) => record(compareFor(input))),
    },
    export_csv: {
      ...fireTools.export_csv,
      execute: vi.fn(async () => record({ url: "/api/export", method: "POST" as const, body: { region: "pantanal" } })),
    },
  };
  return { tools, outputs };
}

/** Numbers in free text ("2,211", "4.3x", "97th" -> 2211, 4.3, 97) with their decimal places. */
export function numbersInText(text: string): { value: number; decimals: number }[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => {
    const s = m[0].replace(/,/g, "");
    return { value: Number(s), decimals: s.includes(".") ? s.split(".")[1].length : 0 };
  });
}

/** Every number in tool outputs: numeric fields and digit runs inside strings (e.g. "2024-08"). */
export function numbersInOutputs(outputs: unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string") for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  outputs.forEach(walk);
  return out;
}

/** Numbers in `text` that don't match any tool-output number (after rounding to the text's precision). */
export function unsupportedNumbers(text: string, outputs: unknown[]): number[] {
  const pool = numbersInOutputs(outputs);
  return numbersInText(text)
    .filter(({ value, decimals }) => {
      const f = 10 ** decimals;
      return !pool.some((v) => Math.abs(Math.round(v * f) / f - value) < 1e-9);
    })
    .map((n) => n.value);
}
