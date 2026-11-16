// Writes contracts/mock/hotspots_pantanal.parquet: synthetic cleaned FIRMS detections that follow
// contracts/hotspots.md, drawn from the fire cell-days in contracts/mock/monthly.parquet.
// The numbers are not real fire data.
//
// Run from app/: node scripts/make-mock-hotspots.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { cellToChildren, cellToLatLng, cellToParent, latLngToCell, polygonToCells } from "h3-js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, "..", "..", "contracts", "mock");
const REGION = "pantanal";
const TARGET_ROWS = 5000;
const SEED = 20261115;

// mulberry32: small seeded PRNG so the file is reproducible.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
// Stochastic rounding keeps the expected count equal to x.
const count = (x) => Math.floor(x) + (rand() < x - Math.floor(x) ? 1 : 0);

// Cells inside the region polygon (hotspots are clipped to the polygon, contracts/hotspots.md).
const regions = JSON.parse(readFileSync(path.resolve(HERE, "..", "src", "lib", "regions.geojson.json"), "utf8"));
const feature = regions.features.find((f) => f.properties.region === REGION);
const polys = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
const inside = new Set(polys.flatMap((p) => polygonToCells(p, 6, true)));

const db = await DuckDBInstance.create(":memory:");
const con = await db.connect();
const monthly = (
  await con.runAndReadAll(
    `SELECT h3_r6, strftime(month, '%Y-%m') AS month, coalesce(modis_raw, 0)::DOUBLE AS modis,
            coalesce(viirs_raw, 0)::DOUBLE AS viirs, provisional, valid_days::INTEGER AS valid_days
     FROM read_parquet($p) WHERE region = $r ORDER BY month, h3_r6`,
    { p: path.join(MOCK, "monthly.parquet"), r: REGION },
  )
).getRowObjectsJson().filter((r) => inside.has(r.h3_r6));

const total = monthly.reduce((s, r) => s + r.modis + r.viirs, 0);
const scale = TARGET_ROWS / total;

function satellites(month) {
  const modis = month >= "2002-07" ? ["MODIS_TERRA", "MODIS_AQUA"] : ["MODIS_TERRA"];
  const viirs = [];
  if (month >= "2012-01") viirs.push("VIIRS_SNPP");
  if (month >= "2018-04") viirs.push("VIIRS_NOAA20");
  if (month >= "2023-03") viirs.push("VIIRS_NOAA21");
  return { modis, viirs };
}

// Local solar overpass times (hours): day / night.
const OVERPASS = { MODIS_TERRA: [10.5, 22.5], MODIS_AQUA: [13.5, 1.5] };
const VIIRS_OVERPASS = [13.5, 1.5];
const pad = (n) => String(n).padStart(2, "0");

function detection(row, sensor) {
  const [y, m] = row.month.split("-").map(Number);
  const day = 1 + Math.floor(rand() * row.valid_days);
  const isDay = rand() < 0.75;
  const [d, n] = OVERPASS[sensor] ?? VIIRS_OVERPASS;
  const localHours = (isDay ? d : n) + normal() * 0.4;

  const child = pick(cellToChildren(row.h3_r6, 8));
  const [clat, clng] = cellToLatLng(child);
  const lat = Math.round((clat + (rand() - 0.5) * 0.004) * 1e5) / 1e5;
  const lng = Math.round((clng + (rand() - 0.5) * 0.004) * 1e5) / 1e5;
  const h3_r8 = latLngToCell(lat, lng, 8);

  // local solar time = UTC + lon / 15 h, so UTC = local - lon / 15 h.
  const localMs = Date.UTC(y, m - 1, day) + localHours * 3600e3;
  const utc = new Date(localMs - (lng / 15) * 3600e3);
  const local = new Date(localMs);
  const isModis = sensor.startsWith("MODIS");
  let confidenceRaw, confidence;
  if (isModis) {
    const c = Math.min(100, 30 + Math.floor(Math.abs(normal()) * 35));
    confidenceRaw = String(c);
    confidence = c >= 80 ? "high" : "nominal";
  } else {
    confidenceRaw = rand() < 0.8 ? "n" : "h";
    confidence = confidenceRaw === "n" ? "nominal" : "high";
  }
  const frp = Math.round(Math.exp((isModis ? 3.0 : 1.8) + normal() * 0.9) * 100) / 100;
  return [
    REGION,
    sensor,
    row.provisional ? "NRT" : "SP",
    `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:00`,
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    lat,
    lng,
    confidence,
    confidenceRaw,
    frp,
    isDay ? "D" : "N",
    h3_r8,
    cellToParent(h3_r8, 6),
  ];
}

await con.run(`CREATE TABLE staging (
  region VARCHAR, sensor VARCHAR, product VARCHAR, acq VARCHAR, local_date VARCHAR,
  latitude DOUBLE, longitude DOUBLE, confidence VARCHAR, confidence_raw VARCHAR, frp DOUBLE,
  daynight VARCHAR, h3_r8 VARCHAR, h3_r6 VARCHAR)`);
const appender = await con.createAppender("staging");
let rows = 0;
for (const row of monthly) {
  const { modis, viirs } = satellites(row.month);
  const jobs = [[modis, row.modis], [viirs, row.viirs]];
  for (const [sensors, cellDays] of jobs) {
    if (!sensors.length) continue;
    for (let i = count(cellDays * scale); i > 0; i--) {
      const values = detection(row, pick(sensors));
      for (const v of values) {
        if (typeof v === "number") appender.appendDouble(v);
        else appender.appendVarchar(v);
      }
      appender.endRow();
      rows++;
    }
  }
}
appender.closeSync();

const out = path.join(MOCK, `hotspots_${REGION}.parquet`);
await con.run(
  `COPY (
     SELECT region, sensor, product, acq::TIMESTAMP AS acq_datetime_utc, local_date::DATE AS local_date,
            latitude, longitude, confidence, confidence_raw, frp, daynight, h3_r8, h3_r6
     FROM staging ORDER BY acq_datetime_utc, sensor, latitude
   ) TO '${out.replaceAll("'", "''")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`,
);
console.log(`${path.relative(process.cwd(), out)}: ${rows} rows from ${monthly.length} cell-months`);
con.closeSync();
