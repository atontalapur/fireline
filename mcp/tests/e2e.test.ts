// End to end: spawn the built server (dist/index.js) over stdio with the SDK client, against a
// tiny local HTTP stub of the Fireline tools API. `npm test` builds first (pretest).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const COMPARE = {
  period: "2020-09",
  value: 81234,
  median: 21000,
  ratio: 3.87,
  z: 3.4,
  percentile: 100,
  rank: 1,
  of: 26,
  provisional: false,
  warnings: [],
};

const received: { path: string; body: unknown }[] = [];
let stub: Server;
let client: Client;

beforeAll(async () => {
  if (!existsSync(ENTRY)) throw new Error(`missing ${ENTRY}; run npm run build first`);
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      received.push({ path, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && path === "/api/tools/compare_to_baseline") {
        res.end(JSON.stringify(COMPARE));
      } else if (req.method === "POST" && path === "/api/tools/get_series") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "end must be >= start" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unknown tool" }));
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...getDefaultEnvironment(), FIRELINE_API_URL: `http://127.0.0.1:${port}` },
    stderr: "pipe",
  });
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
});

describe("stdio server end to end", () => {
  it("identifies itself and lists the four tools", async () => {
    expect(client.getServerVersion()?.name).toBe("fireline");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_to_baseline",
      "export_csv",
      "get_series",
      "resolve_area",
    ]);
  });

  it("calls compare_to_baseline through the HTTP API", async () => {
    const res = (await client.callTool({
      name: "compare_to_baseline",
      arguments: { region: "pantanal", month: "2020-09" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(COMPARE);
    const last = received[received.length - 1];
    expect(last).toEqual({
      path: "/api/tools/compare_to_baseline",
      body: { region: "pantanal", month: "2020-09" },
    });
  });

  it("returns API errors as tool errors", async () => {
    const res = (await client.callTool({
      name: "get_series",
      arguments: { region: "pantanal", start: "2021-01", end: "2020-01" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]).toEqual({
      type: "text",
      text: "Fireline API error 400 for get_series: end must be >= start",
    });
  });
});
