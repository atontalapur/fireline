# hotspots_{region}.parquet

Cleaned FIRMS detections, one row per detection. Written by `pipeline/clean.py` (#7) to
`processed/hotspots_clean.parquet` (hive-partitioned by `region`). `pipeline/export.py` (#12)
publishes one file per region as `public/v1/hotspots_{region}.parquet`. Used by the hotspot CSV
export and the map.

| column | type | null | notes |
|---|---|---|---|
| region | VARCHAR | no | key of `common.REGIONS` |
| sensor | VARCHAR | no | `MODIS_TERRA`, `MODIS_AQUA`, `VIIRS_SNPP`, `VIIRS_NOAA20`, `VIIRS_NOAA21` |
| product | VARCHAR | no | `SP` (standard, archive) or `NRT` (near real time) |
| acq_datetime_utc | TIMESTAMP | no | acquisition time in UTC (naive timestamp, no zone) |
| local_date | DATE | no | local solar date: UTC + longitude / 15 hours |
| latitude | DOUBLE | no | degrees, WGS84 |
| longitude | DOUBLE | no | degrees, WGS84 |
| confidence | VARCHAR | no | normalized: `low`, `nominal`, `high` |
| confidence_raw | VARCHAR | no | value as published: MODIS `0`-`100` as text, VIIRS `l` / `n` / `h` |
| frp | DOUBLE | yes | fire radiative power, MW |
| daynight | VARCHAR | no | `D` or `N` |
| h3_r8 | VARCHAR | no | H3 res-8 cell of the detection, hex string |
| h3_r6 | VARCHAR | no | H3 res-6 parent of `h3_r8`, hex string |

## Confidence mapping

| sensor | raw | confidence |
|---|---|---|
| MODIS | 0-29 | `low` |
| MODIS | 30-79 | `nominal` |
| MODIS | 80-100 | `high` |
| VIIRS | `l` / `n` / `h` | `low` / `nominal` / `high` |

## Filters applied before writing

- `type = 0` (presumed vegetation fire) where the file has `type` (SP files). NRT rows have no
  `type`, so persistent static cells found in the SP data are masked instead.
- MODIS confidence >= `common.MODIS_MIN_CONFIDENCE` (30); VIIRS confidence in
  `common.VIIRS_KEEP_CONFIDENCE` (`n`, `h`). So `low` does not appear in the cleaned output; it is
  kept in the enum for completeness.
- Inside the region polygon in `pipeline/regions.geojson`.
- Where SP and NRT overlap for a date, SP wins. Both are never kept.
