// Request parsing for the CSV routes: POST JSON, POST form (field `request` holding the JSON, so a
// native form submit downloads the file) and GET query params (so a plain URL works).
import type { SeriesRequest } from "@/lib/contracts";
import { SeriesError } from "@/lib/series/area";
import { parseSeriesRequest, readJson } from "@/lib/series/request";

/** GET params: region or cells (comma-separated), start, end, baseline ("2003,2022"). */
export function requestFromSearchParams(params: URLSearchParams): unknown {
  const out: Record<string, unknown> = {};
  const region = params.get("region");
  const cells = params.get("cells");
  if (region) out.region = region;
  if (cells) out.cells = cells.split(",").map((c) => c.trim()).filter(Boolean);
  for (const key of ["start", "end"] as const) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  const baseline = params.get("baseline");
  if (baseline) out.baseline = baseline.split(/[,\-]/).map((v) => Number(v.trim()));
  return out;
}

/** Inverse of requestFromSearchParams: query string for a GET export URL. */
export function searchParamsFor(req: SeriesRequest): string {
  const p = new URLSearchParams();
  if (req.region) p.set("region", req.region);
  if (req.cells) p.set("cells", req.cells.join(","));
  p.set("start", req.start);
  p.set("end", req.end);
  p.set("baseline", req.baseline.join(","));
  return p.toString().replaceAll("%2C", ",");
}

export async function parseCsvRequest(request: Request): Promise<SeriesRequest> {
  if (request.method === "GET") return parseSeriesRequest(requestFromSearchParams(new URL(request.url).searchParams));

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    let raw: FormDataEntryValue | null;
    try {
      raw = (await request.formData()).get("request");
    } catch {
      throw new SeriesError("could not read the form body");
    }
    if (typeof raw !== "string") throw new SeriesError("form field `request` is missing");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new SeriesError("form field `request` must be JSON");
    }
    return parseSeriesRequest(body);
  }
  return parseSeriesRequest(await readJson(request));
}
