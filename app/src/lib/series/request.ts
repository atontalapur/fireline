// Request parsing and error responses shared by /api/series and the CSV routes.
import { SeriesRequest } from "@/lib/contracts";
import { SeriesError } from "@/lib/series/area";

/** Validate a series request body; throws SeriesError(400) with a readable message. */
export function parseSeriesRequest(input: unknown): SeriesRequest {
  const parsed = SeriesRequest.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new SeriesError(`invalid request: ${msg}`);
  }
  return parsed.data;
}

/** Read a JSON body; throws SeriesError(400) if it is not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SeriesError("request body must be JSON");
  }
}

/** JSON error response: SeriesError keeps its status, anything else is a 500. */
export function errorResponse(err: unknown): Response {
  if (err instanceof SeriesError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "internal error" }, { status: 500 });
}
