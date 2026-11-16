// Free-form questions: Gemini with the fire tools in a multi-step tool loop (at most 5 steps).
import { generateText, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import { fireTools } from "@/lib/fire-tools";
import type { FireToolSet } from "./example-answers";
import { buildModelTools } from "./model-tools";
import { extractMonths } from "./months";
import type { ChatAnswer, ChatSelection, ChatTurn, TraceEntry } from "./types";

export const MAX_STEPS = 5;

export function buildInstructions(selection: ChatSelection | null): string {
  const area = !selection
    ? "No area is selected. If the question names a place, call resolve_area; otherwise ask the user to pick an area."
    : [
        `Current selection: "${selection.label}"`,
        selection.region ? `preset key ${selection.region}` : null,
        selection.cell_count > 0 ? `${selection.cell_count} H3 res-6 cells` : null,
        selection.approximate
          ? selection.region
            ? "the drawn area is large, so tools query the whole preset that contains it; say so"
            : "the drawn area is too large to query from the chat; say so and suggest a preset or a named place"
          : null,
        selection.warnings.length ? `area warnings: ${selection.warnings.join(" / ")}` : null,
      ]
        .filter(Boolean)
        .join("; ") + ". Omit `area` in tool calls to query it.";

  return `You are Fireline's fire-history analyst for emergency managers. You answer questions about monthly fire activity from a harmonized MODIS + VIIRS record that starts in November 2000.

Rules:
- Always call a tool before answering with data. Only quote numbers that appear in tool outputs in this conversation; you may round them, but never estimate, compute or recall other numbers. If a number isn't available, say so.
- Units are MODIS-equivalent fire cell-days (unique ~1 km² cells with a detected fire, per day). Call them "fire cell-days".
- If a tool output marks data as provisional or partial, say so. If the area is very small (a handful of cells), has no data, or is outside coverage, or a warning says so, say that plainly.
- "Normal" means the area's baseline median for that calendar month (or year); use ratio, z, percentile and rank from the tools.
- Answer in 2-3 short, plain sentences. Write months as "August 2024". No markdown tables or lists.

${area}`;
}

/** Last turns, starting with a user turn and alternating roles (Gemini rejects other orders). */
export function normalizeTurns(turns: ChatTurn[], max = 12): ModelMessage[] {
  const merged: ChatTurn[] = [];
  for (const t of turns) {
    const prev = merged.at(-1);
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${t.content}`;
    else merged.push({ ...t });
  }
  let recent = merged.slice(-max);
  while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
  return recent.map((m) => ({ role: m.role, content: m.content }));
}

export async function runAnalyst(opts: {
  model: LanguageModel;
  messages: ChatTurn[];
  selection: ChatSelection | null;
  tools?: FireToolSet;
}): Promise<ChatAnswer> {
  const trace: TraceEntry[] = [];
  const messages = normalizeTurns(opts.messages);
  const result = await generateText({
    model: opts.model,
    instructions: buildInstructions(opts.selection),
    messages,
    tools: buildModelTools({ selection: opts.selection, tools: opts.tools ?? fireTools, trace }),
    stopWhen: isStepCount(MAX_STEPS),
    // Force a text answer on the last allowed step instead of ending on a tool call.
    prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" } : {}),
    temperature: 0.2,
  });
  const text = result.text.trim() || "I couldn't put together an answer from the tool outputs. Try rephrasing the question.";
  return { text, trace, months: extractMonths(text), source: "model" };
}
