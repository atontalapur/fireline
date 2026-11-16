// /api/analytics.csv: one row per month of the harmonized series (#21).
// POST JSON, POST form (field `request`), or GET ?region=|cells=&start=&end=&baseline=.
import { analyticsCsv, csvFilename, csvHeaders } from "@/lib/csv/format";
import { parseCsvRequest } from "@/lib/csv/request";
import { computeSeries } from "@/lib/series/compute";
import { errorResponse } from "@/lib/series/request";

async function handle(request: Request): Promise<Response> {
  try {
    const req = await parseCsvRequest(request);
    const series = await computeSeries(req);
    return new Response(analyticsCsv(series), { headers: csvHeaders(csvFilename(req, "analytics")) });
  } catch (err) {
    return errorResponse(err);
  }
}

export const GET = handle;
export const POST = handle;
