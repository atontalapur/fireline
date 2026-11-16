"use client";
// AI analyst chat (#25): example questions answered from the tools, free-form questions answered by
// Gemini with the same tools, and a "How I got this" trace under every answer.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AreaSelection } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { EXAMPLE_QUESTIONS } from "@/lib/chat/examples";
import { toChatSelection } from "@/lib/chat/selection";
import type { ChatAnswer, ChatResponse, ChatTurn, TraceEntry } from "@/lib/chat/types";

export type AnalystChatProps = {
  selection: AreaSelection | null;
  onHighlightMonths?: (months: string[]) => void;
};

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string; answer: ChatAnswer }
  | { id: number; role: "error"; text: string };
type NewMessage = Message extends infer M ? (M extends Message ? Omit<M, "id"> : never) : never;

export function AnalystChat({ selection, onHighlightMonths }: AnalystChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const chatSelection = useMemo(() => toChatSelection(selection), [selection]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, pending]);

  async function ask(question: string, example?: string) {
    const q = question.trim();
    if (!q || pending) return;
    const history: ChatTurn[] = messages
      .filter((m) => m.role !== "error")
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    history.push({ role: "user", content: q });
    const add = (m: NewMessage) => setMessages((prev) => [...prev, { ...m, id: nextId.current++ } as Message]);

    add({ role: "user", text: q });
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-12), selection: chatSelection, example }),
      });
      const data = (await res.json().catch(() => ({ error: `The analyst returned HTTP ${res.status}.` }))) as ChatResponse;
      if ("answer" in data) {
        add({ role: "assistant", text: data.answer.text, answer: data.answer });
        if (data.answer.months.length > 0) onHighlightMonths?.(data.answer.months);
      } else {
        add({ role: "error", text: data.error });
      }
    } catch {
      add({ role: "error", text: "Couldn't reach the analyst. The dashboard still works." });
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = input;
    setInput("");
    void ask(q);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-labelledby="analyst-heading">
      <div>
        <h2 id="analyst-heading" className="font-semibold">
          Ask the analyst
        </h2>
        <p className="text-sm text-muted-foreground">
          {selection ? `About: ${selection.label}` : "Pick an area, or ask about the Pantanal, Western Canada or Punjab."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Example questions">
        {EXAMPLE_QUESTIONS.map((q) => (
          <Button
            key={q.id}
            variant="outline"
            size="sm"
            className="h-auto py-1 text-left whitespace-normal"
            disabled={pending}
            onClick={() => void ask(q.question, q.id)}
          >
            {q.question}
          </Button>
        ))}
      </div>

      <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto" aria-live="polite">
        {messages.map((m) =>
          m.role === "user" ? (
            <p key={m.id} className="self-end rounded-lg bg-muted px-3 py-2 text-sm">
              {m.text}
            </p>
          ) : m.role === "error" ? (
            <p key={m.id} role="alert" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
              {m.text}
            </p>
          ) : (
            <AnswerView key={m.id} answer={m.answer} onHighlightMonths={onHighlightMonths} />
          ),
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking the fire record...
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <label htmlFor="analyst-input" className="sr-only">
          Your question
        </label>
        <input
          id="analyst-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={1000}
          placeholder="Ask about fire activity..."
          className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" disabled={pending || !input.trim()}>
          Ask
        </Button>
      </form>
    </section>
  );
}

function AnswerView({ answer, onHighlightMonths }: { answer: ChatAnswer; onHighlightMonths?: (months: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
      <p>{answer.text}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">
          {answer.source === "model" ? "AI-generated text" : "Template filled from tool outputs (no AI)"}
        </span>
        {answer.months.length > 0 && onHighlightMonths && (
          <button type="button" className="underline underline-offset-2" onClick={() => onHighlightMonths(answer.months)}>
            Show {answer.months.length === 1 ? "month" : "months"} on calendar
          </button>
        )}
      </div>
      {answer.trace.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none">
            How I got this ({answer.trace.length} tool {answer.trace.length === 1 ? "call" : "calls"})
          </summary>
          <ol className="mt-1.5 flex list-decimal flex-col gap-1.5 pl-5">
            {answer.trace.map((t, i) => (
              <TraceItem key={i} entry={t} />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function TraceItem({ entry }: { entry: TraceEntry }) {
  return (
    <li>
      <code className="font-mono font-medium">{entry.tool}</code>
      <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-1.5 py-1 font-mono whitespace-pre-wrap break-all">
        {JSON.stringify(entry.input)}
      </pre>
      <p className={entry.error ? "text-destructive" : "text-muted-foreground"}>
        {entry.error ? `Failed: ${entry.error}` : entry.summary}
      </p>
    </li>
  );
}
