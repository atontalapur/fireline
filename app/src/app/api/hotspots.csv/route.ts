// /api/hotspots.csv: every cleaned detection in the area and date range, streamed (#21).
// POST JSON, POST form (field `request`), or GET ?region=|cells=&start=&end=.
import { csvFilename, csvHeaders } from "@/lib/csv/format";
import { hotspotsCsvStream } from "@/lib/csv/hotspots";
import { parseCsvRequest } from "@/lib/csv/request";
import { errorResponse } from "@/lib/series/request";

async function handle(request: Request): Promise<Response> {
  try {
    const req = await parseCsvRequest(request);
    const body = await hotspotsCsvStream(req);
    return new Response(body, { headers: csvHeaders(csvFilename(req, "hotspots")) });
  } catch (err) {
    return errorResponse(err);
  }
}

export const GET = handle;
export const POST = handle;
