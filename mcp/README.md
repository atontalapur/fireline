# fireline-mcp

An MCP server that lets an assistant such as Claude Desktop query Fireline's harmonized fire history. It runs over stdio and exposes four tools. Each one forwards its input to the Fireline web app (`POST $FIRELINE_API_URL/api/tools/<name>`), so the server holds no data itself.

Coverage: the Brazilian Pantanal (`pantanal`), Western Canada, meaning British Columbia + Alberta (`w_canada`), and Indian Punjab (`punjab`). Values are MODIS-equivalent fire cell-days per month, 2000-11 to today. Months are `YYYY-MM`.

| Tool | What it does |
| --- | --- |
| `resolve_area` | Turns a place name, preset name or GeoJSON polygon into H3 res-6 cells, an area in km² and the preset key, if there is one |
| `get_series` | Gives the monthly series with bands, baselines, z-scores and percentiles, plus a summary with annual totals and ranks. The text output covers the last 24 months and the annual totals; pass `full: true` for every month. The full JSON is always in `structuredContent` |
| `compare_to_baseline` | Compares one month or one year with the area's baseline: ratio to median, z, percentile, rank |
| `export_csv` | Returns a download link for the monthly CSV |

API errors (400, 404, 5xx, network failures, timeouts) come back as MCP tool errors (`isError: true`) carrying the API's message. The server keeps running.

## Build and run

Requires Node 20 or later.

```bash
cd mcp
npm ci
npm run build          # tsc -> dist/
FIRELINE_API_URL=http://localhost:3000 npm start
```

`npm start` waits for MCP messages on stdin. Start it from an MCP client, not from a terminal.

Checks:

```bash
npm run typecheck      # src + tests, no emit
npm test               # builds, then runs vitest (unit tests with a mocked fetch, plus a stdio end-to-end test)
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIRELINE_API_URL` | `http://localhost:3000` | Base URL of the Fireline app. Use the deployed URL to query live data |
| `FIRELINE_TIMEOUT_MS` | `30000` | Timeout for each HTTP request to the app |

## Claude Desktop

Build first. Then add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "fireline": {
      "command": "node",
      "args": ["/absolute/path/to/fireline/mcp/dist/index.js"],
      "env": {
        "FIRELINE_API_URL": "https://your-fireline-deployment.example.com"
      }
    }
  }
}
```

On Windows, write the path as `C:\\path\\to\\fireline\\mcp\\dist\\index.js`. If Claude Desktop can't find `node`, give the full path to the Node binary as `command`.

## Example questions

- "Was September 2020 an unusual fire month in the Pantanal compared to its baseline?"
- "Which year had the most fire activity in Western Canada, and how did 2023 rank?"
- "Show the last two years of monthly fire activity in Punjab. Are the recent months above the median?"
- "How did fires around Cuiaba in 2024 compare with the 2003-2022 baseline?"
- "Give me a CSV of monthly fire cell-days for Western Canada since 2015."
