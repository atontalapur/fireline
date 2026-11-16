// Writes contracts/mock/weather.parquet: mock monthly weather for pantanal, 2000-11..2026-10,
// in the pipeline/weather.py schema. Values follow a rough Pantanal climate (wet Dec-Mar, dry
// Jun-Sep) with deterministic noise and a hot, dry, windy spell in 2020-08..10.
// Run from app/: node scripts/make-weather-mock.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..", "..", "contracts", "mock", "weather.parquet");

const sql = `
CREATE TABLE months AS
SELECT CAST(m AS DATE) AS month, month(m) AS moy
FROM generate_series(DATE '2000-11-01', DATE '2026-10-01', INTERVAL 1 MONTH) AS g(m);

CREATE TABLE vars(variable VARCHAR, unit VARCHAR, ord INTEGER);
INSERT INTO vars VALUES
  ('t2m_mean', 'degC', 1), ('rh2m_mean', '%', 2), ('wind10m_mean', 'm/s', 3), ('precip_total', 'mm', 4);

CREATE TABLE raw AS
WITH base AS (
  SELECT
    m.month, m.moy, v.variable, v.unit,
    -- deterministic noise in [-1, 1)
    (hash(strftime(m.month, '%Y-%m') || v.variable) % 2000)::DOUBLE / 1000 - 1 AS noise,
    m.month BETWEEN DATE '2020-08-01' AND DATE '2020-10-01' AS spell,
    -- 1 in the wet season (Jan), -1 in the dry season (Jul)
    cos(2 * pi() * (m.moy - 1) / 12) AS wet
  FROM months m CROSS JOIN vars v
)
SELECT
  'pantanal' AS region, month, variable, unit, moy,
  round(CASE variable
    WHEN 't2m_mean' THEN 25.5 + 3.0 * cos(2 * pi() * (moy - 11) / 12) + 0.8 * noise
      + CASE WHEN spell THEN 2.6 ELSE 0 END
    WHEN 'rh2m_mean' THEN 70 + 12 * wet + 4 * noise
      + CASE WHEN spell THEN -14 ELSE 0 END
    WHEN 'wind10m_mean' THEN 2.4 - 0.4 * wet + 0.25 * noise
      + CASE WHEN spell THEN 0.6 ELSE 0 END
    ELSE greatest(0, (110 + 100 * wet) * (1 + 0.35 * noise))
      * CASE WHEN spell THEN 0.3 ELSE 1 END
  END, 2) AS value
FROM base;

CREATE TABLE clim AS
SELECT region, variable, moy, avg(value) AS clim_mean, stddev_samp(value) AS clim_std
FROM raw WHERE year(month) BETWEEN 2003 AND 2022
GROUP BY ALL;

COPY (
  SELECT
    r.region, r.month, r.variable, r.value,
    r.value - c.clim_mean AS anomaly,
    CASE WHEN c.clim_std > 0 THEN (r.value - c.clim_mean) / c.clim_std END AS anomaly_z,
    r.unit,
    'Open-Meteo (ERA5)' AS source,
    'CC BY 4.0' AS license
  FROM raw r JOIN clim c USING (region, variable, moy)
  ORDER BY r.region, r.variable, r.month
) TO '${out.replaceAll("'", "''")}' (FORMAT parquet, COMPRESSION zstd);
`;

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
await conn.run(sql);
const check = await conn.runAndReadAll(
  `SELECT count(*)::INTEGER AS n, min(month)::VARCHAR AS first, max(month)::VARCHAR AS last
   FROM read_parquet('${out.replaceAll("'", "''")}')`,
);
console.log(`weather mock: ${JSON.stringify(check.getRowObjectsJson()[0])} -> ${out}`);
conn.closeSync();
instance.closeSync();
