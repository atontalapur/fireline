"""A3: aggregate cleaned hotspots into fire cell-days on the H3 grid.

A fire cell-day is a unique (sensor, local_date, h3_r8). It does not depend on pixel size, so
seven 375 m VIIRS points in one res-8 cell on one day count once, the same as one 1 km MODIS pixel.

Series per (region, h3_r6, month), summed over days and res-8 cells:
  terra, aqua      cell-days per MODIS satellite
  modis            terra + aqua
  snpp, noaa20, noaa21
                   cell-days per VIIRS satellite (diagnostic)
  viirs            per day, mean over the VIIRS satellites operating that day in the region.
                   An operating satellite that saw no fire in a cell adds 0; a satellite that was
                   not operating is left out of the denominator. So NOAA-21 joining S-NPP and
                   NOAA-20 does not add fire when it sees the same cells.
  valid_days       days in the month with any sensor operating in the region (region-level)
  modis_valid_days days with Terra or Aqua operating
  viirs_valid_days days with at least one VIIRS satellite operating
  *_day, *_night   same counts restricted to daynight = D / N (only with day_night=True). A cell
                   seen by day and by night counts once in the total and once in each split.

Rows exist only for (region, h3_r6, month) with at least one detection; months without fire
in a cell are implicit zeros. Region-month data availability is in coverage_day.parquet and,
rolled up per month (coverage_by_month), in coverage_month.parquet: region, month, valid_days,
modis_valid_days, viirs_valid_days for every region-month from 2000-11, fire or not.

Operating rule (derive_coverage). A sensor's record in a region is first_date..last_date from
RAW_DIR/manifest.json (padded one day each side for the UTC to local-solar-date shift; the
MODIS manifest entry covers Terra and Aqua) or, without a manifest, the span between its first
and last detection in the region. Inside the record:
  rule="relative" (default): operating unless the sensor has no detection within +-gap_days
      while some other sensor detected fire in the region that day. Absence of detections is
      only taken as an outage when another satellite shows there was fire to see, so fire-free
      days and months stay valid.
  rule="strict": operating only if the sensor has a detection in the region within +-gap_days.
Days listed in an optional FIRMS missing-data file are never operating.
Coverage only changes the VIIRS mean (numerator and denominator). terra, aqua and the per-VIIRS
satellite counts are raw cell-days.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb
import h3
import pandas as pd

import common

DEFAULT_GAP_DAYS = 3
RULES = ("relative", "strict")

# Manifest sensor directory -> contract sensor codes it covers.
MANIFEST_SENSORS: dict[str, tuple[str, ...]] = {
    "MODIS": common.MODIS_SENSORS,
    "VIIRS_SNPP": ("VIIRS_SNPP",),
    "VIIRS_NOAA20": ("VIIRS_NOAA20",),
    "VIIRS_NOAA21": ("VIIRS_NOAA21",),
}

# Names FIRMS uses for satellites in missing-data lists and CSVs -> contract sensor codes.
SENSOR_ALIASES: dict[str, str] = {
    "terra": "MODIS_TERRA",
    "t": "MODIS_TERRA",
    "modis_terra": "MODIS_TERRA",
    "aqua": "MODIS_AQUA",
    "a": "MODIS_AQUA",
    "modis_aqua": "MODIS_AQUA",
    "n": "VIIRS_SNPP",
    "1": "VIIRS_SNPP",
    "snpp": "VIIRS_SNPP",
    "suomi-npp": "VIIRS_SNPP",
    "suomi_npp": "VIIRS_SNPP",
    "viirs_snpp": "VIIRS_SNPP",
    "n20": "VIIRS_NOAA20",
    "2": "VIIRS_NOAA20",
    "noaa20": "VIIRS_NOAA20",
    "noaa-20": "VIIRS_NOAA20",
    "viirs_noaa20": "VIIRS_NOAA20",
    "n21": "VIIRS_NOAA21",
    "3": "VIIRS_NOAA21",
    "noaa21": "VIIRS_NOAA21",
    "noaa-21": "VIIRS_NOAA21",
    "viirs_noaa21": "VIIRS_NOAA21",
}

_ISO3 = {"BRA": "Brazil", "CAN": "Canada", "IND": "India"}

COVERAGE_COLUMNS = ["region", "local_date", "sensor", "operating"]
_COUNT_COLS = {
    "terra": "MODIS_TERRA",
    "aqua": "MODIS_AQUA",
    "snpp": "VIIRS_SNPP",
    "noaa20": "VIIRS_NOAA20",
    "noaa21": "VIIRS_NOAA21",
}


# --- inputs -----------------------------------------------------------------------------------


def ensure_h3(hotspots: pd.DataFrame) -> pd.DataFrame:
    """Return hotspots with h3_r8 / h3_r6 filled, computing them from lat/lon where missing."""
    df = hotspots
    need_fine = "h3_r8" not in df.columns or df["h3_r8"].isna().any()
    need_store = "h3_r6" not in df.columns or df["h3_r6"].isna().any()
    if not (need_fine or need_store):
        return df
    df = df.copy()
    if need_fine:
        fine = [
            h3.latlng_to_cell(lat, lon, common.H3_FINE_RES)
            for lat, lon in zip(df["latitude"], df["longitude"], strict=True)
        ]
        if "h3_r8" in df.columns:
            df["h3_r8"] = df["h3_r8"].where(df["h3_r8"].notna(), pd.Series(fine, index=df.index))
        else:
            df["h3_r8"] = fine
    if need_store:
        store = [h3.cell_to_parent(c, common.H3_STORE_RES) for c in df["h3_r8"]]
        if "h3_r6" in df.columns:
            df["h3_r6"] = df["h3_r6"].where(df["h3_r6"].notna(), pd.Series(store, index=df.index))
        else:
            df["h3_r6"] = store
    return df


def _country_to_region() -> dict[str, str]:
    out: dict[str, str] = {}
    for region, meta in common.REGIONS.items():
        out[meta["country"].lower()] = region
    for iso, name in _ISO3.items():
        if name.lower() in out:
            out[iso.lower()] = out[name.lower()]
    return out


def records_from_manifest(manifest: dict) -> pd.DataFrame:
    """Per (region, sensor) data record from a download manifest.

    Merges products (SP + NRT) by taking the outer date range. Dates are padded one day each
    side because local solar dates can fall a day off the UTC acquisition date.
    """
    c2r = _country_to_region()
    rows = []
    for entry in manifest.get("entries", []):
        region = c2r.get(str(entry.get("country", "")).lower())
        sensors = MANIFEST_SENSORS.get(str(entry.get("sensor", "")).upper())
        if region is None or sensors is None:
            continue
        if not entry.get("first_date") or not entry.get("last_date"):
            continue
        if entry.get("rows") == 0:
            continue
        for sensor in sensors:
            rows.append(
                {
                    "region": region,
                    "sensor": sensor,
                    "first_date": pd.Timestamp(entry["first_date"]) - pd.Timedelta(days=1),
                    "last_date": pd.Timestamp(entry["last_date"]) + pd.Timedelta(days=1),
                }
            )
    if not rows:
        return pd.DataFrame(columns=["region", "sensor", "first_date", "last_date"])
    df = pd.DataFrame(rows)
    df = df.groupby(["region", "sensor"], as_index=False).agg(
        first_date=("first_date", "min"), last_date=("last_date", "max")
    )
    df["first_date"] = df["first_date"].dt.date
    df["last_date"] = df["last_date"].dt.date
    return df


def load_missing(path: Path) -> pd.DataFrame:
    """Read a FIRMS missing-data list (CSV or JSON) into (sensor, local_date).

    Accepts a satellite column named sensor/satellite/instrument and a date column named
    date/acq_date/local_date/missing_date. Unknown satellite names are dropped.
    """
    if path.suffix.lower() == ".json":
        df = pd.read_json(path)
    else:
        df = pd.read_csv(path, dtype=str)
    cols = {c.lower(): c for c in df.columns}
    sat_col = next((cols[c] for c in ("sensor", "satellite", "instrument") if c in cols), None)
    date_col = next(
        (cols[c] for c in ("local_date", "date", "acq_date", "missing_date") if c in cols), None
    )
    if sat_col is None or date_col is None:
        raise ValueError(f"{path}: need a satellite column and a date column, got {list(df)}")
    sensor = df[sat_col].astype(str).str.strip()
    mapped = sensor.str.lower().map(SENSOR_ALIASES)
    mapped = mapped.where(mapped.notna(), sensor.where(sensor.isin(common.SENSORS)))
    out = pd.DataFrame(
        {"sensor": mapped, "local_date": pd.to_datetime(df[date_col]).dt.date}
    ).dropna()
    return out.drop_duplicates().reset_index(drop=True)


# --- DuckDB helpers ---------------------------------------------------------------------------


def _detections_view(con: duckdb.DuckDBPyConnection, src: str) -> None:
    """Create view `det`: distinct detections with typed columns from relation/table `src`."""
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW det AS
        SELECT CAST(region AS VARCHAR) AS region,
               CAST(sensor AS VARCHAR) AS sensor,
               CAST(local_date AS DATE) AS local_date,
               CAST(h3_r8 AS VARCHAR) AS h3_r8,
               CAST(h3_r6 AS VARCHAR) AS h3_r6,
               upper(CAST(daynight AS VARCHAR)) AS daynight
        FROM {src}
        WHERE h3_r8 IS NOT NULL AND local_date IS NOT NULL
        """
    )


def _coverage_sql(
    con: duckdb.DuckDBPyConnection,
    records: pd.DataFrame | None,
    missing: pd.DataFrame | None,
    gap_days: int,
    rule: str,
) -> pd.DataFrame:
    if rule not in RULES:
        raise ValueError(f"rule must be one of {RULES}, got {rule!r}")
    if gap_days < 0:
        raise ValueError("gap_days must be >= 0")

    if records is None or records.empty:
        con.execute(
            """
            CREATE OR REPLACE TEMP TABLE rec AS
            SELECT region, sensor, min(local_date) AS first_date, max(local_date) AS last_date
            FROM det GROUP BY region, sensor
            """
        )
    else:
        rec_df = records[["region", "sensor", "first_date", "last_date"]]
        con.register("rec_df", rec_df)
        con.execute(
            """
            CREATE OR REPLACE TEMP TABLE rec AS
            SELECT CAST(region AS VARCHAR) AS region, CAST(sensor AS VARCHAR) AS sensor,
                   CAST(first_date AS DATE) AS first_date, CAST(last_date AS DATE) AS last_date
            FROM rec_df
            """
        )
        con.unregister("rec_df")

    miss = (
        missing[["sensor", "local_date"]]
        if missing is not None and not missing.empty
        else pd.DataFrame({"sensor": pd.Series([], dtype=str), "local_date": pd.Series([])})
    )
    con.register("miss_df", miss)
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE miss AS
        SELECT DISTINCT CAST(sensor AS VARCHAR) AS sensor, CAST(local_date AS DATE) AS local_date
        FROM miss_df
        """
    )
    con.unregister("miss_df")

    strict = "TRUE" if rule == "strict" else "FALSE"
    return con.execute(
        f"""
        WITH span AS (
            SELECT region, min(first_date) AS d0, max(last_date) AS d1 FROM rec GROUP BY region
        ),
        days AS (
            SELECT region, CAST(unnest(generate_series(d0, d1, INTERVAL 1 DAY)) AS DATE)
                   AS local_date
            FROM span
        ),
        grid AS (
            SELECT d.region, d.local_date, r.sensor,
                   d.local_date BETWEEN r.first_date AND r.last_date AS in_record
            FROM days d JOIN rec r USING (region)
        ),
        hit AS (SELECT DISTINCT region, sensor, local_date FROM det),
        flagged AS (
            SELECT g.*, (h.region IS NOT NULL)::INTEGER AS seen
            FROM grid g LEFT JOIN hit h USING (region, sensor, local_date)
        ),
        win AS (
            SELECT *,
                   sum(seen) OVER (
                       PARTITION BY region, sensor ORDER BY local_date
                       RANGE BETWEEN INTERVAL {gap_days} DAY PRECEDING
                             AND INTERVAL {gap_days} DAY FOLLOWING
                   ) AS near,
                   sum(seen) OVER (PARTITION BY region, local_date) - seen AS others_today
            FROM flagged
        )
        SELECT w.region, w.local_date, w.sensor,
               (w.in_record
                AND (w.near > 0 OR (NOT {strict} AND w.others_today = 0))
                AND m.sensor IS NULL) AS operating
        FROM win w LEFT JOIN miss m USING (sensor, local_date)
        ORDER BY w.region, w.local_date, w.sensor
        """
    ).df()


def _normalize_coverage(cov: pd.DataFrame) -> pd.DataFrame:
    cov = cov[COVERAGE_COLUMNS].copy()
    cov["local_date"] = pd.to_datetime(cov["local_date"]).dt.date
    cov["operating"] = cov["operating"].astype(bool)
    return cov.reset_index(drop=True)


def derive_coverage(
    hotspots: pd.DataFrame,
    manifest: dict | None = None,
    missing: pd.DataFrame | None = None,
    gap_days: int = DEFAULT_GAP_DAYS,
    rule: str = "relative",
) -> pd.DataFrame:
    """Build the coverage_day table (region, local_date, sensor, operating).

    See the module docstring for the operating rule. `manifest` is the parsed
    RAW_DIR/manifest.json; `missing` is (sensor, local_date) from load_missing().
    """
    con = duckdb.connect()
    try:
        con.register("hot_src", hotspots)
        _detections_view(con, "hot_src")
        records = records_from_manifest(manifest) if manifest else None
        return _normalize_coverage(_coverage_sql(con, records, missing, gap_days, rule))
    finally:
        con.close()


# --- aggregation ------------------------------------------------------------------------------


def _valid_ctes() -> str:
    """CTEs `cov_day` and `valid` over table `cov`: valid-day counts per (region, month).

    valid_days: days with any sensor operating; modis_valid_days: Terra or Aqua operating;
    viirs_valid_days: at least one VIIRS satellite operating.
    """
    modis = ", ".join(f"'{s}'" for s in common.MODIS_SENSORS)
    viirs = ", ".join(f"'{s}'" for s in common.VIIRS_SENSORS)
    return f"""cov_day AS (
            SELECT region, local_date,
                   bool_or(operating) AS any_op,
                   bool_or(operating) FILTER (WHERE sensor IN ({modis})) AS modis_op,
                   bool_or(operating) FILTER (WHERE sensor IN ({viirs})) AS viirs_op
            FROM cov GROUP BY region, local_date
        ),
        valid AS (
            SELECT region, CAST(date_trunc('month', local_date) AS DATE) AS month,
                   CAST(count(*) FILTER (WHERE any_op) AS INTEGER) AS valid_days,
                   CAST(count(*) FILTER (WHERE modis_op) AS INTEGER) AS modis_valid_days,
                   CAST(count(*) FILTER (WHERE viirs_op) AS INTEGER) AS viirs_valid_days
            FROM cov_day GROUP BY ALL
        )"""


def _aggregate_sql(con: duckdb.DuckDBPyConnection, day_night: bool) -> pd.DataFrame:
    """Aggregate view `det` with table `cov` into the r6 x month frame."""
    viirs = ", ".join(f"'{s}'" for s in common.VIIRS_SENSORS)

    splits = [("", "TRUE")]
    if day_night:
        splits += [("_day", "daynight = 'D'"), ("_night", "daynight = 'N'")]

    # Per (region, h3_r6, local_date, sensor): distinct res-8 cells, total and per split.
    cell_cols = ",\n".join(
        f"count(DISTINCT h3_r8) FILTER (WHERE {cond}) AS cells{sfx}" for sfx, cond in splits
    )
    sums = []
    for sfx, _ in splits:
        for col, sensor in _COUNT_COLS.items():
            sums.append(
                f"CAST(coalesce(sum(cells{sfx}) FILTER (WHERE sensor = '{sensor}'), 0) AS BIGINT)"
                f" AS {col}{sfx}"
            )
        sums.append(
            f"coalesce(sum(cells{sfx} / n_viirs) FILTER (WHERE sensor IN ({viirs}) "
            f"AND operating), 0.0) AS viirs{sfx}"
        )
    sums_sql = ",\n".join(sums)

    df = con.execute(
        f"""
        WITH cd AS (
            SELECT region, h3_r6, local_date, sensor,
                   {cell_cols}
            FROM det GROUP BY region, h3_r6, local_date, sensor
        ),
        nv AS (
            SELECT region, local_date, count(*) FILTER (WHERE operating) AS n_viirs
            FROM cov WHERE sensor IN ({viirs}) GROUP BY region, local_date
        ),
        joined AS (
            SELECT cd.*, coalesce(c.operating, FALSE) AS operating, nv.n_viirs
            FROM cd
            LEFT JOIN cov c USING (region, local_date, sensor)
            LEFT JOIN nv USING (region, local_date)
        ),
        agg AS (
            SELECT region, h3_r6, CAST(date_trunc('month', local_date) AS DATE) AS month,
                   {sums_sql}
            FROM joined GROUP BY ALL
        ),
        {_valid_ctes()}
        SELECT a.*,
               coalesce(v.valid_days, 0) AS valid_days,
               coalesce(v.modis_valid_days, 0) AS modis_valid_days,
               coalesce(v.viirs_valid_days, 0) AS viirs_valid_days
        FROM agg a LEFT JOIN valid v USING (region, month)
        ORDER BY region, h3_r6, month
        """
    ).df()

    for sfx, _ in splits:
        df[f"modis{sfx}"] = df[f"terra{sfx}"] + df[f"aqua{sfx}"]
    head = ["region", "h3_r6", "month", "terra", "aqua", "modis", "viirs"]
    head += ["snpp", "noaa20", "noaa21", "valid_days", "modis_valid_days", "viirs_valid_days"]
    tail = [
        f"{c}{sfx}"
        for sfx, _ in splits[1:]
        for c in ("terra", "aqua", "modis", "viirs", "snpp", "noaa20", "noaa21")
    ]
    df = df[head + tail]
    df["month"] = pd.to_datetime(df["month"]).dt.date
    for c in ("valid_days", "modis_valid_days", "viirs_valid_days"):
        df[c] = df[c].astype("int32")
    return df.reset_index(drop=True)


def _load_coverage(con: duckdb.DuckDBPyConnection, coverage: pd.DataFrame) -> None:
    """Create typed temp table `cov` from a coverage_day frame."""
    con.register("cov_df", _normalize_coverage(coverage))
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE cov AS
        SELECT CAST(region AS VARCHAR) AS region, CAST(local_date AS DATE) AS local_date,
               CAST(sensor AS VARCHAR) AS sensor, CAST(operating AS BOOLEAN) AS operating
        FROM cov_df
        """
    )
    con.unregister("cov_df")


def _run(
    con: duckdb.DuckDBPyConnection,
    coverage: pd.DataFrame,
    day_night: bool,
) -> pd.DataFrame:
    _load_coverage(con, coverage)
    return _aggregate_sql(con, day_night)


COVERAGE_MONTH_COLUMNS = [
    "region",
    "month",
    "valid_days",
    "modis_valid_days",
    "viirs_valid_days",
]


def coverage_by_month(
    coverage_day: pd.DataFrame, start: str = common.TERRA_ONLY_START
) -> pd.DataFrame:
    """Build the coverage_month table: valid-day counts per (region, month).

    One row for every region in coverage_day and every month from `start` (YYYY-MM) through
    the last month in which any region has an operating sensor, including months without fire.
    Uses the same valid-day definitions as the cell_days valid_days columns. Region-months with
    no operating sensor (or no coverage rows) get 0.
    """
    con = duckdb.connect()
    try:
        _load_coverage(con, coverage_day)
        df = con.execute(
            f"""
            WITH {_valid_ctes()},
            bounds AS (
                SELECT CAST(? AS DATE) AS m0, max(month) FILTER (WHERE valid_days > 0) AS m1
                FROM valid
            ),
            months AS (
                SELECT CAST(unnest(generate_series(m0, m1, INTERVAL 1 MONTH)) AS DATE) AS month
                FROM bounds WHERE m1 IS NOT NULL AND m1 >= m0
            ),
            grid AS (
                SELECT r.region, m.month
                FROM (SELECT DISTINCT region FROM cov) r CROSS JOIN months m
            )
            SELECT g.region, g.month,
                   coalesce(v.valid_days, 0) AS valid_days,
                   coalesce(v.modis_valid_days, 0) AS modis_valid_days,
                   coalesce(v.viirs_valid_days, 0) AS viirs_valid_days
            FROM grid g LEFT JOIN valid v USING (region, month)
            ORDER BY g.region, g.month
            """,
            [f"{start}-01"],
        ).df()
    finally:
        con.close()
    df = df[COVERAGE_MONTH_COLUMNS]
    df["region"] = df["region"].astype(str)
    df["month"] = pd.to_datetime(df["month"]).dt.date
    for c in COVERAGE_MONTH_COLUMNS[2:]:
        df[c] = df[c].astype("int32")
    return df.reset_index(drop=True)


def compute_cell_days(
    hotspots: pd.DataFrame,
    coverage: pd.DataFrame | None = None,
    day_night: bool = True,
) -> pd.DataFrame:
    """Aggregate cleaned hotspots to fire cell-days per (region, h3_r6, month).

    `coverage` is a coverage_day table (region, local_date, sensor, operating). If None it is
    derived from the hotspots alone with derive_coverage() defaults (no manifest).
    """
    hot = ensure_h3(hotspots)
    if "daynight" not in hot.columns:
        hot = hot.assign(daynight=None)
    if coverage is None:
        coverage = derive_coverage(hot)
    con = duckdb.connect()
    try:
        con.register("hot_src", hot)
        _detections_view(con, "hot_src")
        return _run(con, coverage, day_night)
    finally:
        con.close()


# --- CLI --------------------------------------------------------------------------------------


def _parquet_glob(path: Path) -> str:
    return str(path / "**" / "*.parquet") if path.is_dir() else str(path)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--input", type=Path, default=common.PROCESSED_DIR / "hotspots_clean.parquet")
    p.add_argument("--manifest", type=Path, default=common.RAW_DIR / "manifest.json")
    p.add_argument("--missing", type=Path, default=None, help="FIRMS missing-data list (CSV/JSON)")
    p.add_argument("--gap-days", type=int, default=DEFAULT_GAP_DAYS)
    p.add_argument("--rule", choices=RULES, default="relative")
    p.add_argument("--no-day-night", action="store_true", help="skip *_day / *_night columns")
    p.add_argument("--out-dir", type=Path, default=common.PROCESSED_DIR)
    args = p.parse_args()

    common.ensure_dirs()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    manifest = None
    if args.manifest.exists():
        manifest = json.loads(args.manifest.read_text())
    else:
        print(f"no manifest at {args.manifest}; records come from detection spans")
    missing = load_missing(args.missing) if args.missing else None

    con = duckdb.connect()
    try:
        src = (
            f"read_parquet('{_parquet_glob(args.input)}', hive_partitioning = true, "
            "union_by_name = true)"
        )
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        if {"h3_r8", "h3_r6", "daynight"} <= cols:
            con.execute(f"CREATE TEMP VIEW hot_src AS SELECT * FROM {src}")
        else:
            hot = con.execute(f"SELECT * FROM {src}").df()
            hot = ensure_h3(hot)
            if "daynight" not in hot.columns:
                hot["daynight"] = None
            con.register("hot_src", hot)
        _detections_view(con, "hot_src")

        records = records_from_manifest(manifest) if manifest else None
        coverage = _normalize_coverage(
            _coverage_sql(con, records, missing, args.gap_days, args.rule)
        )
        out = _run(con, coverage, day_night=not args.no_day_night)
    finally:
        con.close()

    cov_month = coverage_by_month(coverage)
    cov_path = args.out_dir / "coverage_day.parquet"
    cov_month_path = args.out_dir / "coverage_month.parquet"
    out_path = args.out_dir / "cell_days_r6_month.parquet"
    coverage.to_parquet(cov_path, index=False)
    cov_month.to_parquet(cov_month_path, index=False)
    out.to_parquet(out_path, index=False)
    print(f"wrote {cov_path} ({len(coverage)} rows), {cov_month_path} ({len(cov_month)} rows)")
    print(f"wrote {out_path} ({len(out)} rows)")


if __name__ == "__main__":
    main()
