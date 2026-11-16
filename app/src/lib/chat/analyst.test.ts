import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { normalizeTurns, runAnalyst } from "./analyst";
import { RESOLVED, mockTools } from "./__fixtures__/tools";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const call = (id: string, toolName: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

describe("runAnalyst", () => {
  it("passes resolve_area cells to later tools through an area_id", async () => {
    const { tools } = mockTools();
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("a", "resolve_area", { name: "Cuiaba" }),
        call("b", "get_series", { area: "area_1", start: "2024-01", end: "2024-12" }),
        say("Cuiaba peaked in September 2024."),
      ],
    });
    const answer = await runAnalyst({ model, tools, selection: null, messages: [{ role: "user", content: "Cuiaba 2024?" }] });
    expect(tools.get_series.execute).toHaveBeenCalledWith({ cells: RESOLVED.cells, start: "2024-01", end: "2024-12" });
    expect(answer.trace.map((t) => t.tool)).toEqual(["resolve_area", "get_series"]);
    expect(answer.months).toEqual(["2024-09"]);
  });

  it("records tool errors in the trace and lets the model recover", async () => {
    const { tools } = mockTools();
    const model = new MockLanguageModelV4({
      doGenerate: [call("a", "get_series", {}), say("Please pick an area first.")],
    });
    const answer = await runAnalyst({ model, tools, selection: null, messages: [{ role: "user", content: "How is it?" }] });
    expect(answer.trace).toEqual([
      expect.objectContaining({ tool: "get_series", summary: "failed", error: expect.stringContaining("No area is selected") }),
    ]);
    expect(answer.text).toBe("Please pick an area first.");
    expect(tools.get_series.execute).not.toHaveBeenCalled();
  });
});

describe("normalizeTurns", () => {
  it("starts with a user turn and merges repeated roles", () => {
    expect(
      normalizeTurns([
        { role: "assistant", content: "hello" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ]);
  });
});
