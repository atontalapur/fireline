// Shapes shared by POST /api/chat and the chat panel. Client-safe: zod only.
import { z } from "zod";
import { H3CellR6, REGION_KEYS } from "@/lib/contracts";

/** Largest cell list the panel sends with a question; bigger drawn areas fall back to a region. */
export const MAX_CHAT_CELLS = 10_000;

export const ChatSelection = z.object({
  label: z.string().max(200),
  region: z.enum(REGION_KEYS).nullable(),
  cells: z.array(H3CellR6).max(MAX_CHAT_CELLS).nullable(),
  cell_count: z.number().int().nonnegative(),
  /** True when a large drawn area is stood in for by the preset region that contains it. */
  approximate: z.boolean().default(false),
  warnings: z.array(z.string().max(500)).max(20).default([]),
});
export type ChatSelection = z.infer<typeof ChatSelection>;

export const ChatTurn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const ChatRequest = z.object({
  messages: z.array(ChatTurn).max(30).default([]),
  selection: ChatSelection.nullable().default(null),
  /** Id of an example question; answered from the tools without the model. */
  example: z.string().max(64).optional(),
});
export type ChatRequest = z.input<typeof ChatRequest>;

/** One tool call behind an answer, as shown under "How I got this". */
export type TraceEntry = {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  error?: string;
};

export type ChatAnswer = {
  text: string;
  trace: TraceEntry[];
  /** YYYY-MM months referenced in the text, for the calendar highlight. */
  months: string[];
  /** "model": Gemini wrote the text. "example": a template filled from tool outputs. */
  source: "model" | "example";
};

export type ChatResponse = { answer: ChatAnswer } | { error: string };
