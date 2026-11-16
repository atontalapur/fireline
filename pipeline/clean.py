"""A2: clean FIRMS detections, assign local solar date, clip to the demo regions.

Reads raw FIRMS CSVs from RAW_DIR/firms/{product}/{sensor}/{country}/*.csv and writes
PROCESSED_DIR/hotspots_clean.parquet, hive-partitioned by region, with the hotspots contract
columns.

Rules (issue #7):
- Keep type == 0 (vegetation fire) where the field exists (SP). NRT rows have no type.
- MODIS: keep confidence >= common.MODIS_MIN_CONFIDENCE. VIIRS: keep common.VIIRS_KEEP_CONFIDENCE.
- local_date = (acq_datetime_utc + longitude / 15 h).date()
- SP wins over NRT: an NRT row is dropped when its UTC acq_date falls inside the SP coverage
  window for the same sensor and region. SP and NRT files are cut by UTC date, so the window is
  compared on UTC date, not local date. The window comes from the SP rows themselves, widened by
  RAW_DIR/manifest.json when present.
- NRT static mask: H3 res-8 cells where SP detections (any type) occur in >= 50% of the months of
  the SP record and in >= 5 distinct years are treated as persistent static sources, and NRT
  detections in them are dropped.

Confidence normalization:
- MODIS (0-100): 0-29 low, 30-79 nominal, 80-100 high.
- VIIRS (l/n/h): l low, n nominal, h high.
confidence_raw keeps the original value as VARCHAR.

    uv run python clean.py
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import duckdb
import h3
import pandas as pd

import common

log = logging.getLogger("clean")

OUTPUT_NAME = "hotspots_clean.parquet"
STATIC_MIN_MONTH_SHARE = 0.5
STATIC_MIN_YEARS = 5
MODIS_HIGH_CONFIDENCE = 80

# Raw FIRMS satellite codes -> contract sensor codes. Codes vary between FIRMS files.
SATELLITE_CODES: dict[str, str] = {
    "TERRA": "MODIS_TERRA",
    "T": "MODIS_TERRA",
    "AQUA": "MODIS_AQUA",
    "A": "MODIS_AQUA",
    "N": "VIIRS_SNPP",
    "NPP": "VIIRS_SNPP",
    "SNPP": "VIIRS_SNPP",
    "SUOMI NPP": "VIIRS_SNPP",
    "SUOMI-NPP": "VIIRS_SNPP",
    "N20": "VIIRS_NOAA20",
    "NOAA-20": "VIIRS_NOAA20",
    "NOAA20": "VIIRS_NOAA20",
    "J1": "VIIRS_NOAA20",
    "1": "VIIRS_NOAA20",
    "N21": "VIIRS_NOAA21",
    "NOAA-21": "VIIRS_NOAA21",
    "NOAA21": "VIIRS_NOAA21",
    "J2": "VIIRS_NOAA21",
    "2": "VIIRS_NOAA21",
}

# Raw columns used downstream. Missing ones (e.g. type in NRT) are filled with NULL.
RAW_COLUMNS = (
    "product",
    "sensor_dir",
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "satellite",
    "confidence",
    "frp",
    "daynight",
    "type",
)

OUTPUT_COLUMNS = (
    "region",
    "sensor",
    "product",
    "acq_datetime_utc",
    "local_date",
    "latitude",
    "longitude",
    "confidence",
    "confidence_raw",
    "frp",
    "daynight",
    "h3_r8",
    "h3_r6",
)


def connect() -> duckdb.DuckDBPyConnection:
    """DuckDB connection with spatial loaded and H3 functions available.

    Uses the h3 community extension when it loads; otherwise registers h3-py UDFs under the
    same names so the SQL is unchanged.
    """
    con = duckdb.connect()
    _load_extension(con, "spatial", "INSTALL spatial")
    try:
        _load_extension(con, "h3", "INSTALL h3 FROM community")
    except duckdb.Error as exc:
        log.warning("h3 extension unavailable (%s); using h3-py UDFs", exc)
        register_h3_udfs(con)
    return con


def _load_extension(con: duckdb.DuckDBPyConnection, name: str, install_sql: str) -> None:
    try:
        con.execute(f"LOAD {name}")
    except duckdb.Error:
        con.execute(install_sql)
        con.execute(f"LOAD {name}")


def register_h3_udfs(con: duckdb.DuckDBPyConnection) -> None:
    con.create_function(
        "h3_latlng_to_cell_string",
        lambda lat, lng, res: h3.latlng_to_cell(lat, lng, res),
        ["DOUBLE", "DOUBLE", "INTEGER"],
        "VARCHAR",
    )
    con.create_function(
        "h3_cell_to_parent",
        lambda cell, res: h3.cell_to_parent(cell, res),
        ["VARCHAR", "INTEGER"],
        "VARCHAR",
    )


def load_regions(con: duckdb.DuckDBPyConnection, path: Path = common.REGIONS_GEOJSON) -> None:
    """Create table `regions(region, geom)` from the regions GeoJSON."""
    fc = json.loads(Path(path).read_text())
    con.execute("CREATE OR REPLACE TEMP TABLE regions (region VARCHAR, geom GEOMETRY)")
    for feat in fc["features"]:
        region = feat["properties"]["region"]
        if region not in common.REGIONS:
            raise ValueError(f"unknown region {region!r} in {path}")
        con.execute(
            "INSERT INTO regions SELECT ?, ST_GeomFromGeoJSON(?)",
            [region, json.dumps(feat["geometry"])],
        )


def read_raw(con: duckdb.DuckDBPyConnection, raw_dir: Path = common.RAW_DIR) -> int:
    """Create view `raw_in` over all FIRMS CSVs, with product/sensor_dir/country from the path.

    Returns the number of files found.
    """
    files = sorted(str(p) for p in (Path(raw_dir) / "firms").glob("*/*/*/*.csv"))
    if not files:
        raise FileNotFoundError(f"no FIRMS CSVs under {raw_dir}/firms")
    pattern = r"firms/([^/]+)/([^/]+)/([^/]+)/[^/]+$"
    file_list = ", ".join("'" + f.replace("'", "''") + "'" for f in files)
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW raw_in AS
        SELECT *,
            regexp_extract(filename, '{pattern}', 1) AS product,
            regexp_extract(filename, '{pattern}', 2) AS sensor_dir,
            regexp_extract(filename, '{pattern}', 3) AS country
        FROM read_csv([{file_list}], union_by_name = true, all_varchar = true,
                      filename = true, header = true)
        """
    )
    return len(files)


def manifest_coverage(path: Path = common.RAW_DIR / "manifest.json") -> pd.DataFrame | None:
    """SP coverage windows from the A1 manifest as (region, sensor, first_date, last_date)."""
    if not Path(path).exists():
        return None
    entries = json.loads(Path(path).read_text()).get("entries", [])
    country_region = {meta["country"].lower(): key for key, meta in common.REGIONS.items()}
    rows = []
    for e in entries:
        if str(e.get("product", "")).upper() != "SP":
            continue
        region = country_region.get(str(e.get("country", "")).lower())
        sensor_dir = str(e.get("sensor", "")).upper()
        sensors = common.MODIS_SENSORS if sensor_dir == "MODIS" else (sensor_dir,)
        if region is None or not e.get("first_date") or not e.get("last_date"):
            continue
        for s in sensors:
            if s in common.SENSORS:
                rows.append((region, s, e["first_date"], e["last_date"]))
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["region", "sensor", "first_date", "last_date"])
    df["first_date"] = pd.to_datetime(df["first_date"]).dt.date
    df["last_date"] = pd.to_datetime(df["last_date"]).dt.date
    return df


def _sensor_sql() -> str:
    viirs_dirs = ", ".join(f"'{s}'" for s in common.VIIRS_SENSORS)
    whens = "\n".join(f"            WHEN '{k}' THEN '{v}'" for k, v in SATELLITE_CODES.items())
    return f"""
        CASE
            WHEN upper(sensor_dir) IN ({viirs_dirs}) THEN upper(sensor_dir)
            ELSE CASE upper(trim(satellite))
{whens}
            END
        END"""


def _standardize(con: duckdb.DuckDBPyConnection, raw_view: str) -> None:
    """View `std`: typed columns, contract sensor codes, parsed UTC timestamp."""
    cols = {c.lower() for c in con.execute(f"SELECT * FROM {raw_view} LIMIT 0").fetch_df()}
    missing = {"latitude", "longitude", "acq_date", "acq_time", "confidence", "product"} - cols
    if missing:
        raise ValueError(f"raw data missing columns: {sorted(missing)}")
    sel = ", ".join(
        f"CAST({c} AS VARCHAR) AS {c}" if c in cols else f"CAST(NULL AS VARCHAR) AS {c}"
        for c in RAW_COLUMNS
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW std AS
        WITH r AS (SELECT {sel} FROM {raw_view}),
        t AS (
            SELECT *,
                regexp_replace(split_part(trim(acq_time), '.', 1), '[^0-9]', '', 'g') AS t_digits
            FROM r
        ),
        p AS (
            SELECT *,
                CASE WHEN length(t_digits) BETWEEN 1 AND 4 THEN lpad(t_digits, 4, '0') END AS hhmm
            FROM t
        )
        SELECT
            upper(trim(product)) AS product,
            {_sensor_sql()} AS sensor,
            TRY_CAST(latitude AS DOUBLE) AS latitude,
            TRY_CAST(longitude AS DOUBLE) AS longitude,
            TRY_CAST(acq_date AS DATE) AS acq_date,
            CASE
                WHEN TRY_CAST(substr(hhmm, 1, 2) AS INTEGER) < 24
                 AND TRY_CAST(substr(hhmm, 3, 2) AS INTEGER) < 60
                THEN CAST(TRY_CAST(acq_date AS DATE) AS TIMESTAMP)
                    + to_minutes(CAST(substr(hhmm, 1, 2) AS INTEGER) * 60
                                 + CAST(substr(hhmm, 3, 2) AS INTEGER))
            END AS acq_datetime_utc,
            trim(confidence) AS confidence_raw,
            TRY_CAST(frp AS DOUBLE) AS frp,
            upper(trim(daynight)) AS daynight,
            TRY_CAST(TRY_CAST(type AS DOUBLE) AS INTEGER) AS fire_type
        FROM p
        """
    )


def _quality_sql() -> str:
    keep = ", ".join(f"'{c}'" for c in common.VIIRS_KEEP_CONFIDENCE)
    return f"""
        CASE
            WHEN sensor LIKE 'MODIS%'
                THEN TRY_CAST(confidence_raw AS DOUBLE) >= {common.MODIS_MIN_CONFIDENCE}
            ELSE lower(substr(confidence_raw, 1, 1)) IN ({keep})
        END"""


def _confidence_class_sql(prefix: str = "") -> str:
    sensor, raw = f"{prefix}sensor", f"{prefix}confidence_raw"
    return f"""
        CASE
            WHEN {sensor} LIKE 'MODIS%' THEN CASE
                WHEN TRY_CAST({raw} AS DOUBLE) >= {MODIS_HIGH_CONFIDENCE} THEN 'high'
                WHEN TRY_CAST({raw} AS DOUBLE) >= {common.MODIS_MIN_CONFIDENCE}
                    THEN 'nominal'
                WHEN TRY_CAST({raw} AS DOUBLE) >= 0 THEN 'low'
            END
            ELSE CASE lower(substr({raw}, 1, 1))
                WHEN 'h' THEN 'high' WHEN 'n' THEN 'nominal' WHEN 'l' THEN 'low'
            END
        END"""


def clean(
    con: duckdb.DuckDBPyConnection,
    raw_view: str = "raw_in",
    coverage: pd.DataFrame | None = None,
) -> duckdb.DuckDBPyRelation:
    """Apply all cleaning rules. Requires table `regions` (see load_regions).

    raw_view needs the FIRMS columns plus `product` (SP/NRT) and `sensor_dir` (the A1 sensor
    directory: MODIS, VIIRS_SNPP, ...). coverage optionally widens the SP windows
    (region, sensor, first_date, last_date), e.g. from manifest_coverage().
    """
    _standardize(con, raw_view)

    # Clip to region polygons and compute local solar date. Drop unparseable rows.
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE clipped AS
        SELECT r.region, s.*,
            CAST(s.acq_datetime_utc
                 + to_microseconds(CAST(round(s.longitude * 240e6) AS BIGINT)) AS DATE)
                AS local_date,
            {_quality_sql()} AS quality_ok
        FROM std s
        JOIN regions r ON ST_Contains(r.geom, ST_Point(s.longitude, s.latitude))
        WHERE s.product IN ('SP', 'NRT')
          AND s.sensor IS NOT NULL
          AND s.acq_datetime_utc IS NOT NULL
          AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        """
    )

    # SP coverage window per region and sensor (UTC dates).
    cov_sql = """
        SELECT region, sensor, min(acq_date) AS first_date, max(acq_date) AS last_date
        FROM clipped WHERE product = 'SP' GROUP BY ALL
    """
    if coverage is not None and len(coverage):
        con.register("_cov_extra", coverage[["region", "sensor", "first_date", "last_date"]])
        cov_sql = f"""
            SELECT region, sensor, min(first_date) AS first_date, max(last_date) AS last_date
            FROM ({cov_sql} UNION ALL
                  SELECT region, sensor, CAST(first_date AS DATE), CAST(last_date AS DATE)
                  FROM _cov_extra)
            GROUP BY ALL
        """
    con.execute(f"CREATE OR REPLACE TEMP TABLE sp_coverage AS {cov_sql}")

    # Quality-filtered rows with res-8 cell. Static mask uses SP rows of any type.
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE good AS
        SELECT *, h3_latlng_to_cell_string(latitude, longitude, {common.H3_FINE_RES}) AS h3_r8
        FROM clipped WHERE quality_ok
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE static_cells AS
        WITH sp AS (
            SELECT region, h3_r8, date_trunc('month', local_date) AS m
            FROM good WHERE product = 'SP'
        ),
        span AS (
            SELECT region, date_diff('month', min(m), max(m)) + 1 AS n_months
            FROM sp GROUP BY region
        ),
        cells AS (
            SELECT region, h3_r8, count(DISTINCT m) AS months, count(DISTINCT year(m)) AS years
            FROM sp GROUP BY region, h3_r8
        )
        SELECT c.region, c.h3_r8, c.months, c.years, s.n_months
        FROM cells c JOIN span s USING (region)
        WHERE c.years >= {STATIC_MIN_YEARS}
          AND c.months >= {STATIC_MIN_MONTH_SHARE} * s.n_months
        """
    )

    return con.sql(
        f"""
        SELECT DISTINCT
            g.region,
            g.sensor,
            g.product,
            g.acq_datetime_utc,
            g.local_date,
            g.latitude,
            g.longitude,
            {_confidence_class_sql("g.")} AS confidence,
            g.confidence_raw,
            g.frp,
            g.daynight,
            g.h3_r8,
            h3_cell_to_parent(g.h3_r8, {common.H3_STORE_RES}) AS h3_r6
        FROM good g
        LEFT JOIN sp_coverage c ON g.region = c.region AND g.sensor = c.sensor
        LEFT JOIN static_cells sc ON g.region = sc.region AND g.h3_r8 = sc.h3_r8
        WHERE (g.fire_type IS NULL OR g.fire_type = 0)
          AND NOT coalesce(g.product = 'NRT'
                           AND g.acq_date BETWEEN c.first_date AND c.last_date, false)
          AND NOT (g.product = 'NRT' AND sc.h3_r8 IS NOT NULL)
        """
    )


def clean_frame(
    raw: pd.DataFrame,
    regions_path: Path = common.REGIONS_GEOJSON,
    coverage: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """pandas wrapper around clean() for tests and small inputs."""
    con = connect()
    load_regions(con, regions_path)
    con.register("raw_df", raw)
    out = clean(con, "raw_df", coverage).df()
    return out.sort_values(["region", "sensor", "acq_datetime_utc"]).reset_index(drop=True)


def log_counts(rel: duckdb.DuckDBPyRelation) -> pd.DataFrame:
    counts = rel.aggregate("region, sensor, product, count(*) AS rows").order("region, sensor").df()
    for row in counts.itertuples(index=False):
        log.info("%-9s %-13s %-3s %10d", row.region, row.sensor, row.product, row.rows)
    return counts


def write_output(con: duckdb.DuckDBPyConnection, table: str, out: Path) -> None:
    """Write `table` to out as Parquet, hive-partitioned by region (out is a directory)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"""
        COPY (SELECT {", ".join(OUTPUT_COLUMNS)} FROM {table}
              ORDER BY region, sensor, acq_datetime_utc)
        TO '{out}' (FORMAT parquet, PARTITION_BY (region), OVERWRITE true)
        """
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean FIRMS detections and clip to regions")
    parser.add_argument("--raw-dir", type=Path, default=common.RAW_DIR)
    parser.add_argument("--regions", type=Path, default=common.REGIONS_GEOJSON)
    parser.add_argument("--out", type=Path, default=common.PROCESSED_DIR / OUTPUT_NAME)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

    con = connect()
    load_regions(con, args.regions)
    n_files = read_raw(con, args.raw_dir)
    log.info("reading %d raw files from %s", n_files, args.raw_dir)
    rel = clean(con, "raw_in", manifest_coverage(args.raw_dir / "manifest.json"))
    rel.to_table("final")
    final = con.table("final")
    n_static = con.execute("SELECT count(*) FROM static_cells").fetchall()[0][0]
    log.info("static res-%d cells masked for NRT: %d", common.H3_FINE_RES, n_static)
    log_counts(final)
    write_output(con, "final", args.out)
    n_rows = con.execute("SELECT count(*) FROM final").fetchall()[0][0]
    log.info("wrote %s (%d rows)", args.out, n_rows)


if __name__ == "__main__":
    main()
