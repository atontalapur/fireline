import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CACHE_ENTRIES, answerExample, clearExampleCaches } from "./example-answers";
import { EXAMPLE_QUESTIONS } from "./examples";
import { fmt, ordinal } from "./format";
import type { ChatSelection } from "./types";
import { SERIES, mockTools, unsupportedNumbers } from "./__fixtures__/tools";

const drawn: ChatSelection = {
  label: "Cuiaba circle",
  region: null,
  cells: ["86a8e1a27ffffff", "86a8e1a2fffffff"],
  cell_count: 2,
  approximate: false,
  warnings: [],
};

beforeEach(() => clearExampleCaches());

describe("example answers", () => {
  it.each(EXAMPLE_QUESTIONS.map((q) => [q.id, q.question] as const))(
    "%s: every number in the text appears in a tool output",
    async (id) => {
      for (const selection of [null, drawn]) {
        clearExampleCaches();
        const { tools, outputs } = mockTools();
        const { answer } = await answerExample(id, selection, tools);
        expect(answer.source).toBe("example");
        expect(answer.text.length).toBeGreaterThan(20);
        expect(answer.trace.length).toBeGreaterThan(0);
        for (const t of answer.trace) expect(t.summary).not.toBe("");
        expect(unsupportedNumbers(answer.text, outputs)).toEqual([]);
      }
    },
  );

  it("caps the answer cache, evicting the oldest selection first", async () => {
    const { tools } = mockTools();
    const area = (i: number): ChatSelection => ({ ...drawn, cells: [drawn.cells![0], `cell-${i}`] });
    for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) await answerExample("this-month", area(i), tools);
    expect((await answerExample("this-month", area(MAX_CACHE_ENTRIES), tools)).cached).toBe(true);
    expect((await answerExample("this-month", area(0), tools)).cached).toBe(false);
  });

  it("fills the August 2024 template from compare_to_baseline", async () => {
    const { tools } = mockTools();
    const { answer } = await answerExample("pantanal-aug-2024", null, tools);
    expect(answer.text).toBe(
      "August 2024 in the Brazilian Pantanal had 2,211 fire cell-days against the August baseline median of 512 " +
        "(4.3x the median), which is unusually high. It ranks 2nd of 26 Augusts on record, at the 98th percentile of the baseline.",
    );
    expect(answer.months).toEqual(["2024-08"]);
    expect(answer.trace).toEqual([
      expect.objectContaining({ tool: "compare_to_baseline", input: { region: "pantanal", month: "2024-08" } }),
    ]);
  });

  it("names the top complete year and its biggest month", async () => {
    const { tools } = mockTools();
    const { answer } = await answerExample("w-canada-top-year", null, tools);
    const top = SERIES.summary.annual.find((a) => a.rank === 1)!;
    expect(answer.text).toContain(`${top.year} burned most in Western Canada (BC + Alberta), with ${fmt(top.total)} fire cell-days`);
    expect(answer.months).toHaveLength(1);
    expect(answer.months[0].startsWith(`${top.year}-`)).toBe(true);
  });

  it("says the current month is provisional and highlights it", async () => {
    const { tools } = mockTools();
    const { answer } = await answerExample("this-month", drawn, tools);
    const c = SERIES.summary.current;
    expect(answer.text).toContain('"Cuiaba circle"');
    expect(answer.text).toContain("provisional");
    expect(answer.months).toEqual([c.month]);
    expect(tools.get_series.execute).toHaveBeenCalledWith({ cells: drawn.cells });
    expect(answer.trace[0].input).toEqual({ cells: drawn.cells });
  });

  it("falls back to the Pantanal when nothing is selected", async () => {
    const { tools } = mockTools();
    const { answer } = await answerExample("this-month", null, tools);
    expect(answer.text).toMatch(/^No area is selected, so this uses the Brazilian Pantanal\./);
    expect(tools.get_series.execute).toHaveBeenCalledWith({ region: "pantanal" });
  });

  it("caches answers and shared tool calls in memory", async () => {
    const { tools } = mockTools();
    const first = await answerExample("pantanal-worst-month", null, tools);
    const again = await answerExample("pantanal-worst-month", null, tools);
    expect(first.cached).toBe(false);
    expect(again.cached).toBe(true);
    expect(again.answer).toBe(first.answer);
    // "this-month" without a selection asks for the same Pantanal series: served from the tool cache.
    await answerExample("this-month", null, tools);
    expect(tools.get_series.execute).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const { tools } = mockTools();
    tools.compare_to_baseline.execute = async () => {
      throw new Error("data not ready");
    };
    await expect(answerExample("pantanal-2024-year", null, tools)).rejects.toThrow("data not ready");
    const ok = mockTools();
    const { answer, cached } = await answerExample("pantanal-2024-year", null, ok.tools);
    expect(cached).toBe(false);
    expect(answer.text).toContain("provisional");
  });
});

describe("format", () => {
  it("rounds without inventing precision", () => {
    expect(fmt(2645.455)).toBe("2,645");
    expect(fmt(55.059)).toBe("55");
    expect(fmt(4.32)).toBe("4.3");
    expect(fmt(2)).toBe("2");
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(97.5)).toBe("98th");
  });
});
