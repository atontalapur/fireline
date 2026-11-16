# Contracts

Shared data formats between the pipeline (`pipeline/`) and the app (`app/`, `mcp/`).
Any change to a shape goes through a PR that touches this folder.

| file | describes |
|---|---|
| [monthly.md](monthly.md) | `monthly.parquet`: harmonized fire cell-days per H3 res-6 cell and month |
| [coverage.md](coverage.md) | `coverage_month.parquet`: valid days per region and month, fire or not |
| [calibration.md](calibration.md) | `calibration.parquet`: k per region and calendar month, with 90% band |
| [hotspots.md](hotspots.md) | `hotspots_{region}.parquet`: cleaned FIRMS points |
| [validation.md](validation.md) | `validation.json`: per-region validation metrics and figure paths |
| [api-series.md](api-series.md) | `POST /api/series` request and response |
| [mock/](mock/) | mock data for building the app before real data lands |

## Public files

`pipeline/export.py --upload` publishes these under `gs://fireline-space-apps-data/public/v1/`.
The bucket is public-read with a GET/HEAD CORS rule, so the files load from a browser or DuckDB
without credentials.

| file | URL |
|---|---|
| index (sizes, sha256, row counts, `generated_at`) | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/index.json` |
| monthly series | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/monthly.parquet` |
| coverage (valid days per region-month) | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/coverage_month.parquet` |
| calibration | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/calibration.parquet` |
| hotspots, Pantanal | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/hotspots_pantanal.parquet` |
| hotspots, Western Canada | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/hotspots_w_canada.parquet` |
| hotspots, Punjab | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/hotspots_punjab.parquet` |
| validation | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/validation.json` |
| weather (tier 3, may be absent) | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/weather.parquet` |
| figures | `https://storage.googleapis.com/fireline-space-apps-data/public/v1/figures/{seam,scatter}_{region}.png` |

`index.json` lists exactly what the current export contains. Check it before assuming an optional
file exists. It has a 60 s cache; other files have 5 min (JSON) or 1 h (Parquet, PNG).

Parquet files use zstd. Hotspot files are sorted by `acq_datetime_utc` in 100k-row groups, so a
time-range filter only fetches the row groups it needs. `monthly.parquet` is sorted by
`region, h3_r6, month`; `coverage_month.parquet` by `region, month`.

`monthly.parquet` stores only cells with fire. A missing row means zero fire, unless
`coverage_month.valid_days = 0` for that region-month, in which case there is no data.

## Query in DuckDB

```sql
INSTALL httpfs;
LOAD httpfs;

SELECT month, sum(harmonized) AS harmonized
FROM read_parquet('https://storage.googleapis.com/fireline-space-apps-data/public/v1/monthly.parquet')
WHERE region = 'pantanal'
GROUP BY month
ORDER BY month;

SELECT count(*)
FROM read_parquet('https://storage.googleapis.com/fireline-space-apps-data/public/v1/hotspots_punjab.parquet')
WHERE acq_datetime_utc >= TIMESTAMP '2024-10-01' AND acq_datetime_utc < TIMESTAMP '2024-11-01';

DESCRIBE SELECT * FROM read_parquet('https://storage.googleapis.com/fireline-space-apps-data/public/v1/calibration.parquet');
```

DuckDB reads over HTTPS with range requests, so it downloads only the footer and the row groups a
query touches. Browser reads (DuckDB-WASM) use the bucket's CORS rule: any origin, `GET` and
`HEAD`, exposing `Content-Type`, `Content-Length`, `Content-Range`, `Range` and `ETag`.
