import path from "node:path";

// Directory holding the public/v1 dataset files (monthly.parquet, coverage_month.parquet, ...).
// APP_DATA_DIR wins. Otherwise use the repo mock, so `npm run dev` works with no setup.
export function dataDir(): string {
  return process.env.APP_DATA_DIR ?? path.resolve(process.cwd(), "..", "contracts", "mock");
}

export function dataFile(name: string): string {
  // Runtime path (APP_DATA_DIR): keep it out of build-time file tracing.
  return path.join(/* turbopackIgnore: true */ dataDir(), name);
}

// Public base URL for figures and other files served from the bucket.
export function publicDataBaseUrl(): string | null {
  const bucket = process.env.DATA_BUCKET;
  return bucket ? `https://storage.googleapis.com/${bucket}/public/v1/` : null;
}
