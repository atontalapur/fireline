// Test-only: loads the contract mock (contracts/mock/series-pantanal.json) as a SeriesResponse.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SeriesResponse } from "@/lib/contracts";

const MOCK_PATH = fileURLToPath(new URL("../../../../contracts/mock/series-pantanal.json", import.meta.url));

export function loadMockSeries(): SeriesResponse {
  return SeriesResponse.parse(JSON.parse(readFileSync(MOCK_PATH, "utf8")));
}
