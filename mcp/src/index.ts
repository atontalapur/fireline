#!/usr/bin/env node
// Fireline MCP server over stdio. Logs go to stderr; stdout carries the MCP protocol.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeBaseUrl } from "./client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(process.env.FIRELINE_API_URL);
  const timeoutRaw = Number(process.env.FIRELINE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;
  const server = createServer({ baseUrl, timeoutMs });
  await server.connect(new StdioServerTransport());
  console.error(`fireline-mcp: stdio server ready, API ${baseUrl}`);
}

main().catch((err: unknown) => {
  console.error("fireline-mcp: fatal", err);
  process.exit(1);
});
