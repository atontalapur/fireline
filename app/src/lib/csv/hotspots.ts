// Hotspot CSV export: streams cleaned detections from hotspots_<region>.parquet chunk by chunk.
import { existsSync } from "node:fs";
import { LIST, VARCHAR, listValue } from "@duckdb/node-api";
import type { SeriesRequest } from "@/lib/contracts";
import { dataFile } from "@/lib/data-dir";
import { BOM, HOTSPOT_COLUMNS, csvRow, headerComment } from "@/lib/csv/format";
import { SeriesError, resolveArea } from "@/lib/series/area";
import { SWITCH_MONTH } from "@/lib/series/compute";
import { queryRows, streamRows } from "@/lib/series/db";

/** First day of the month after `month` (YYYY-MM), as YYYY-MM-DD. */
export function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** k per calendar month for the region (index 1-12). */
async function loadK(region: string): Promise<(number | null)[]> {
  const k: (number | null)[] = Array(13).fill(null);
  const file = dataFile("calibration.parquet");
  if (!existsSync(file)) return k;
  const rows = await queryRows<{ moy: number; k: number }>(
    "SELECT month_of_year::INTEGER AS moy, k::DOUBLE AS k FROM read_parquet($p) WHERE region = $r",
    { p: file, r: region },
  );
  for (const r of rows) k[r.moy] = r.k;
  return k;
}

type Primitive = string | number | boolean | null;

/**
 * Hotspot CSV as a byte stream. Bad input and a missing file throw SeriesError before the
 * stream starts, so the route can still answer with a JSON error.
 *
 * k is the calibration factor applied to the detection's region-month: set for VIIRS
 * detections from SWITCH_MONTH on (the months where harmonized = k x VIIRS), empty otherwise.
 */
export async function hotspotsCsvStream(req: SeriesRequest, now: Date = new Date()): Promise<ReadableStream<Uint8Array>> {
  const area = resolveArea(req);
  const file = dataFile(`hotspots_${area.region}.parquet`);
  if (!existsSync(file)) throw new SeriesError(`no hotspot data for region ${area.region}`, 404);
  const kByMonth = await loadK(area.region);

  const from = `${req.start}-01`;
  const to = nextMonthStart(req.end);
  // acq_datetime_utc bounds (one day wider than the local dates) let DuckDB skip row groups;
  // the local_date bounds are the actual filter. No ORDER BY: the file is already sorted by
  // time and DuckDB keeps file order, so rows stream without a full sort.
  const sql = `
    SELECT strftime(acq_datetime_utc, '%Y-%m-%d') AS date,
           strftime(acq_datetime_utc, '%H:%M') AS time_utc,
           strftime(local_date, '%Y-%m-%d') AS local_date,
           latitude::DOUBLE AS lat, longitude::DOUBLE AS lon,
           sensor, product, confidence, frp::DOUBLE AS frp, daynight, h3_r6
    FROM read_parquet($file)
    WHERE region = $region
      AND acq_datetime_utc >= $from::TIMESTAMP - INTERVAL 1 DAY
      AND acq_datetime_utc < $to::TIMESTAMP + INTERVAL 1 DAY
      AND local_date >= $from::DATE AND local_date < $to::DATE
      ${area.cells ? "AND h3_r6 IN (SELECT unnest($cells))" : ""}`;
  const params: Record<string, string | ReturnType<typeof listValue>> = { file, region: area.region, from, to };
  if (area.cells) params.cells = listValue(area.cells);
  const rows = streamRows(sql, params, area.cells ? { cells: LIST(VARCHAR) } : undefined);

  const enc = new TextEncoder();
  const format = (chunk: Primitive[][]): Uint8Array => {
    let out = "";
    for (const r of chunk) {
      const localDate = r[2] as string;
      const viirs = (r[5] as string).startsWith("VIIRS");
      const k = viirs && localDate.slice(0, 7) >= SWITCH_MONTH ? kByMonth[Number(localDate.slice(5, 7))] : null;
      out += csvRow([...r, k === null ? null : Math.round(k * 1e4) / 1e4]);
    }
    return enc.encode(out);
  };

  // Read the first chunk now so query errors surface before the response starts.
  const first = await rows.next();
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(enc.encode(BOM + headerComment(now) + "\r\n" + csvRow(HOTSPOT_COLUMNS)));
          if (first.done) controller.close();
          else controller.enqueue(format(first.value));
          return;
        }
        const next = await rows.next();
        if (next.done) controller.close();
        else controller.enqueue(format(next.value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await rows.return(undefined);
    },
  });
}
