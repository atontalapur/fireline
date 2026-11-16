import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient, type ClientOptions } from "./client.js";
import { registerFireTools } from "./tools.js";

export const SERVER_NAME = "fireline";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "Fireline gives harmonized satellite fire history (MODIS-equivalent fire cell-days per month, 2000-11 to today) for the Brazilian Pantanal, Western Canada (British Columbia + Alberta) and Indian Punjab. " +
  "For a preset region pass region ('pantanal', 'w_canada', 'punjab') directly; for a town or drawn area call resolve_area first and pass its cells. " +
  "Use compare_to_baseline for 'was X unusual' questions and get_series for trends and annual totals.";

export function createServer(options: ClientOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerFireTools(server, createClient(options));
  return server;
}
