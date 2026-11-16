import { LIST, VARCHAR, listValue, type DuckDBType, type DuckDBValue } from "@duckdb/node-api";
import type { RegionKey } from "@/lib/contracts";
import { dataFile } from "@/lib/data-dir";
import { queryRows } from "@/lib/series/db";

// Server only. DuckDB queries for the hex map, through the shared series DB helper.

export type CellValue = { h3: string; harmonized: number };

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

const MONTH_DATE = "CAST($month || '-01' AS DATE)";

/**
 * Harmonized fire cell-days per H3 res-6 cell for one region-month.
 * `cells` null means every stored cell in the region. Cells without a row had no fire,
 * unless the month has no data (see queryMonthValidDays).
 */
export async function queryMonthCells(
  region: RegionKey,
  month: string, // YYYY-MM
  cells: string[] | null,
): Promise<CellValue[]> {
  const sql =
    `SELECT h3_r6 AS h3, harmonized FROM read_parquet(${sqlString(dataFile("monthly.parquet"))}) ` +
    `WHERE region = $region AND month = ${MONTH_DATE}` +
    (cells ? " AND list_contains($cells, h3_r6)" : "") +
    " ORDER BY h3_r6";
  const values: Record<string, DuckDBValue> = { region, month };
  const types: Record<string, DuckDBType> = { region: VARCHAR, month: VARCHAR };
  if (cells) {
    values.cells = listValue(cells);
    types.cells = LIST(VARCHAR);
  }
  const rows = await queryRows(sql, values, types);
  return rows.map((r) => ({ h3: String(r.h3), harmonized: Number(r.harmonized) }));
}

/**
 * Days with satellite data in the region-month, from coverage_month.parquet.
 * 0 means no data (show as missing, not zero fire); null means the month is not covered at all.
 */
export async function queryMonthValidDays(region: RegionKey, month: string): Promise<number | null> {
  const rows = await queryRows(
    `SELECT valid_days FROM read_parquet(${sqlString(dataFile("coverage_month.parquet"))}) ` +
      `WHERE region = $region AND month = ${MONTH_DATE}`,
    { region, month },
    { region: VARCHAR, month: VARCHAR },
  );
  const v = rows[0]?.valid_days;
  return v === undefined || v === null ? null : Number(v);
}
