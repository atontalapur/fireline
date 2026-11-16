// POST /api/tools/<name>: run one fire tool (#24). JSON in, JSON out. Used by the MCP server.
import { fireTools, type FireToolName } from "@/lib/fire-tools";
import { errorResponse, readJson } from "@/lib/series/request";

export async function POST(request: Request, ctx: RouteContext<"/api/tools/[name]">): Promise<Response> {
  const { name } = await ctx.params;
  if (!Object.hasOwn(fireTools, name))
    return Response.json({ error: `unknown tool ${name}; tools: ${Object.keys(fireTools).join(", ")}` }, { status: 404 });
  const tool = fireTools[name as FireToolName];
  try {
    const parsed = tool.inputSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      return Response.json({ error: `invalid input: ${msg}` }, { status: 400 });
    }
    // Each tool's execute takes its own schema's output; the union cast is safe after safeParse.
    const execute = tool.execute as (input: unknown) => Promise<unknown>;
    return Response.json(await execute(parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}
