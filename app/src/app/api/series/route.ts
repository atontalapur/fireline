// POST /api/series (contracts/api-series.md).
import { computeSeries } from "@/lib/series/compute";
import { errorResponse, parseSeriesRequest, readJson } from "@/lib/series/request";

export async function POST(request: Request): Promise<Response> {
  try {
    const req = parseSeriesRequest(await readJson(request));
    return Response.json(await computeSeries(req));
  } catch (err) {
    return errorResponse(err);
  }
}
