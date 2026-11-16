// POST /api/chat: the AI analyst (#25).
// Body: { messages: [{ role, content }], selection, example? } -> { answer } or { error }.
// Example questions are answered from the tools without the model (cached in memory); everything
// else goes to Gemini on Vertex AI with the fire tools.
import { runAnalyst } from "@/lib/chat/analyst";
import { answerExample } from "@/lib/chat/example-answers";
import { isExampleId } from "@/lib/chat/examples";
import { getChatModel } from "@/lib/chat/model";
import { ChatRequest, type ChatResponse } from "@/lib/chat/types";

const UNAVAILABLE =
  "The AI analyst is unavailable right now, so I can't answer free-form questions. " +
  "The example questions and the dashboard still work.";

const json = (body: ChatResponse, status = 200) => Response.json(body, { status });

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) return json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? "bad body"}` }, 400);
  const { messages, selection, example } = parsed.data;

  if (example !== undefined) {
    if (!isExampleId(example)) return json({ error: `Unknown example question "${example}".` }, 400);
    try {
      const { answer } = await answerExample(example, selection);
      return json({ answer });
    } catch (e) {
      console.error("chat: example answer failed", example, e);
      return json({ error: "Couldn't load the fire data for this example right now. Please try again." }, 502);
    }
  }

  const last = messages.at(-1);
  if (!last || last.role !== "user") return json({ error: "Send a question as the last user message." }, 400);

  const model = getChatModel();
  if (!model) {
    console.warn("chat: GOOGLE_CLOUD_PROJECT is not set; the model is disabled");
    return json({ error: UNAVAILABLE }, 503);
  }
  try {
    const answer = await runAnalyst({ model, messages, selection });
    return json({ answer });
  } catch (e) {
    console.error("chat: model call failed", e);
    return json({ error: UNAVAILABLE }, 503);
  }
}
