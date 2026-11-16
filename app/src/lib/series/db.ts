// DuckDB access for the API routes. One in-memory instance per process; one short-lived
// connection per query, so a streaming result never blocks another request.
import { DuckDBInstance, type DuckDBConnection, type DuckDBType, type DuckDBValue } from "@duckdb/node-api";

type Params = Record<string, DuckDBValue>;
type Types = Record<string, DuckDBType | undefined>;
type Primitive = string | number | boolean | null;

const globalForDuck = globalThis as unknown as { __firelineDuck?: Promise<DuckDBInstance> };

function instance(): Promise<DuckDBInstance> {
  globalForDuck.__firelineDuck ??= DuckDBInstance.create(":memory:", { threads: "4" }).catch((err) => {
    globalForDuck.__firelineDuck = undefined;
    throw err;
  });
  return globalForDuck.__firelineDuck;
}

export async function withConnection<T>(fn: (con: DuckDBConnection) => Promise<T>): Promise<T> {
  const con = await (await instance()).connect();
  try {
    return await fn(con);
  } finally {
    con.closeSync();
  }
}

/**
 * Run a query and return row objects. Cast columns in SQL to VARCHAR / DOUBLE / INTEGER /
 * BOOLEAN so every value is a JS primitive.
 */
export async function queryRows<T extends Record<string, Primitive>>(
  sql: string,
  params?: Params,
  types?: Types,
): Promise<T[]> {
  return withConnection(async (con) => {
    const reader = await con.runAndReadAll(sql, params, types);
    return reader.getRowObjectsJson() as T[];
  });
}

/**
 * Stream a query chunk by chunk (about 2048 rows each). The connection stays open until the
 * iterator finishes or is returned early (for example when the client disconnects).
 */
export async function* streamRows(sql: string, params?: Params, types?: Types): AsyncGenerator<Primitive[][]> {
  const con = await (await instance()).connect();
  try {
    const result = await con.stream(sql, params, types);
    try {
      while (true) {
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        yield chunk.getRows() as Primitive[][];
      }
    } finally {
      result.closeSync();
    }
  } finally {
    con.closeSync();
  }
}
