import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { fireTools } from "@/lib/fire-tools";
import { getChatModel } from "@/lib/chat/model";
import { clearExampleCaches } from "@/lib/chat/example-answers";
import { MAX_STEPS } from "@/lib/chat/analyst";
import type { ChatResponse } from "@/lib/chat/types";
import { SERIES, compareFor } from "@/lib/chat/__fixtures__/tools";
import { POST } from "./route";

vi.mock("@/lib/chat/model", () => ({ getChatModel: vi.fn() }));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const pantanal = { label: "Brazilian Pantanal", region: "pantanal", cells: null, cell_count: 0 };

beforeEach(() => {
  clearExampleCaches();
  vi.spyOn(fireTools.get_series, "execute").mockImplementation(async () => structuredClone(SERIES));
  vi.spyOn(fireTools.compare_to_baseline, "execute").mockImplementation(async (i) =>
    compareFor(i as { month?: string; year?: number }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/chat", () => {
  it("answers example questions from the tools without the model", async () => {
    const res = await post({ example: "pantanal-aug-2024", messages: [], selection: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse;
    if (!("answer" in body)) throw new Error(body.error);
    expect(body.answer.source).toBe("example");
    expect(body.answer.text).toContain("August 2024 in the Brazilian Pantanal had 2,211 fire cell-days");
    expect(body.answer.months).toEqual(["2024-08"]);
    expect(body.answer.trace[0]).toMatchObject({ tool: "compare_to_baseline", input: { region: "pantanal", month: "2024-08" } });
    expect(getChatModel).not.toHaveBeenCalled();
  });

  it("runs the tool loop with the model and returns the trace", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "compare_to_baseline",
              input: JSON.stringify({ month: "2024-08" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Yes. August 2024 had 2,211 fire cell-days, 4.3x the August median of 512." }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    vi.mocked(getChatModel).mockReturnValue(model);

    const res = await post({
      messages: [{ role: "user", content: "Was August 2024 unusual here?" }],
      selection: pantanal,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse;
    if (!("answer" in body)) throw new Error(body.error);
    expect(body.answer).toMatchObject({ source: "model", months: ["2024-08"] });
    expect(body.answer.trace).toEqual([
      {
        tool: "compare_to_baseline",
        input: { region: "pantanal", month: "2024-08" },
        summary: expect.stringContaining("2024-08: 2210.667 vs median 512.25"),
      },
    ]);
    // The selection reached the tool, and the tool output reached the model's second step.
    expect(fireTools.compare_to_baseline.execute).toHaveBeenCalledWith({ region: "pantanal", month: "2024-08" });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("2210.667");
    expect(model.doGenerateCalls[0].tools?.map((t) => t.name).sort()).toEqual([
      "compare_to_baseline",
      "export_csv",
      "get_series",
      "resolve_area",
    ]);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("Brazilian Pantanal");
  });

  it("stops the tool loop after the step cap", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        n++;
        if (options.toolChoice?.type === "none")
          return {
            content: [{ type: "text", text: "Here is what I found." }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          };
        return {
          content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "get_series", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    vi.mocked(getChatModel).mockReturnValue(model);
    const res = await post({ messages: [{ role: "user", content: "Keep digging" }], selection: pantanal });
    const body = (await res.json()) as ChatResponse;
    if (!("answer" in body)) throw new Error(body.error);
    expect(model.doGenerateCalls).toHaveLength(MAX_STEPS);
    expect(body.answer.trace).toHaveLength(MAX_STEPS - 1);
    expect(body.answer.text).toBe("Here is what I found.");
  });

  it("returns a clear message when the model call fails", async () => {
    vi.mocked(getChatModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("Could not load the default credentials");
        },
      }),
    );
    const res = await post({ messages: [{ role: "user", content: "Hi" }], selection: null });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ChatResponse;
    expect(body).toEqual({ error: expect.stringContaining("example questions and the dashboard still work") });
  });

  it("returns the same message when no project is configured", async () => {
    vi.mocked(getChatModel).mockReturnValue(null);
    const res = await post({ messages: [{ role: "user", content: "Hi" }], selection: null });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.stringContaining("unavailable") });
  });

  it("rejects bad requests", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ example: "nope" })).status).toBe(400);
    expect((await post({ messages: [] })).status).toBe(400);
    expect((await post({ messages: [{ role: "system", content: "x" }] })).status).toBe(400);
  });

  it("reports tool failures in example answers without crashing", async () => {
    vi.mocked(fireTools.get_series.execute).mockRejectedValue(new Error("fire-tools: not implemented yet (#24)"));
    const res = await post({ example: "punjab-peak-month" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.stringContaining("Couldn't load the fire data") });
  });
});
