"""A7: export final datasets to PUBLIC_DIR and, with --upload, to gs://$DATA_BUCKET/public/v1/.

Reads PROCESSED_DIR outputs of A2-A6 (hotspots, monthly, coverage_month, calibration,
validation.json), checks each Parquet input against the contract in DuckDB,
writes contract-typed Parquet (zstd) plus validation.json, optional weather.parquet and figures,
then writes index.json with sizes, sha256 and row counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import duckdb

import common

GCS_PREFIX = "public/v1/"
HOTSPOTS_ROW_GROUP = 100_000

# Contract columns and DuckDB types (contracts/*.md). Order is the output column order.
CONTRACTS: dict[str, dict[str, str]] = {
    "hotspots": {
        "region": "VARCHAR",
        "sensor": "VARCHAR",
        "product": "VARCHAR",
        "acq_datetime_utc": "TIMESTAMP",
        "local_date": "DATE",
        "latitude": "DOUBLE",
        "longitude": "DOUBLE",
        "confidence": "VARCHAR",
        "confidence_raw": "VARCHAR",
        "frp": "DOUBLE",
        "daynight": "VARCHAR",
        "h3_r8": "VARCHAR",
        "h3_r6": "VARCHAR",
    },
    "monthly": {
        "region": "VARCHAR",
        "h3_r6": "VARCHAR",
        "month": "DATE",
        "modis_raw": "DOUBLE",
        "viirs_raw": "DOUBLE",
        "harmonized": "DOUBLE",
        "harmonized_lo": "DOUBLE",
        "harmonized_hi": "DOUBLE",
        "source": "VARCHAR",
        "provisional": "BOOLEAN",
        "valid_days": "INTEGER",
    },
    "coverage_month": {
        "region": "VARCHAR",
        "month": "DATE",
        "valid_days": "INTEGER",
        "modis_valid_days": "INTEGER",
        "viirs_valid_days": "INTEGER",
    },
    "calibration": {
        "region": "VARCHAR",
        "month_of_year": "INTEGER",
        "k": "DOUBLE",
        "k_lo": "DOUBLE",
        "k_hi": "DOUBLE",
        "n_years": "INTEGER",
    },
}

SORT_KEYS = {
    "hotspots": ("acq_datetime_utc", "sensor", "latitude", "longitude"),
    "monthly": ("region", "h3_r6", "month"),
    "coverage_month": ("region", "month"),
    "calibration": ("region", "month_of_year"),
}

# Allowed values for categorical columns. Nulls are not checked here.
ENUMS: dict[str, dict[str, tuple[str, ...]]] = {
    "hotspots": {
        "region": tuple(common.REGIONS),
        "sensor": common.SENSORS,
        "product": ("SP", "NRT"),
        "confidence": ("low", "nominal", "high"),
        "daynight": ("D", "N"),
    },
    "monthly": {
        "region": tuple(common.REGIONS),
        "source": ("modis", "terra_scaled", "viirs_scaled"),
    },
    "coverage_month": {"region": tuple(common.REGIONS)},
    "calibration": {"region": tuple(common.REGIONS)},
}

_INT_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
}  # fmt: skip
_FLOAT_TYPES = {"FLOAT", "DOUBLE"}
# Input types that cast to the contract type without changing meaning. A failed cast
# (e.g. integer overflow) raises in DuckDB, so these stay loud.
COMPATIBLE: dict[str, set[str]] = {
    "VARCHAR": {"VARCHAR"},
    "DATE": {"DATE"},
    "BOOLEAN": {"BOOLEAN"},
    "INTEGER": _INT_TYPES,
    "DOUBLE": _INT_TYPES | _FLOAT_TYPES,
    "TIMESTAMP": {
        "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE",
    },
}  # fmt: skip

CONTENT_TYPES = {
    ".parquet": "application/vnd.apache.parquet",
    ".json": "application/json",
    ".png": "image/png",
}
CACHE_CONTROL_INDEX = "public, max-age=60"
CACHE_CONTROL_JSON = "public, max-age=300"
CACHE_CONTROL_DEFAULT = "public, max-age=3600"


class ContractError(ValueError):
    """A dataset does not match its contract."""


def _q(path: Path | str) -> str:
    """Quote a path as a SQL string literal."""
    return "'" + str(path).replace("'", "''") + "'"


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # TIMESTAMPTZ -> TIMESTAMP casts use the session zone; force UTC.
    con.execute("SET TimeZone = 'UTC'")
    return con


def parquet_source(path: Path) -> str:
    """read_parquet() expression for a single file or a hive-partitioned directory."""
    if path.is_dir():
        return f"read_parquet({_q(path / '**' / '*.parquet')}, hive_partitioning = true)"
    if not path.exists():
        raise FileNotFoundError(f"missing input: {path}")
    return f"read_parquet({_q(path)})"


def describe(con: duckdb.DuckDBPyConnection, source: str) -> dict[str, str]:
    rows = con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
    return {r[0]: r[1] for r in rows}


def check_schema(
    con: duckdb.DuckDBPyConnection, source: str, name: str, *, strict: bool = False
) -> None:
    """Raise ContractError if columns or types don't match CONTRACTS[name].

    strict=False accepts castable types (COMPATIBLE) and extra columns, for inputs.
    strict=True requires exact columns, order and types, for exported files.
    """
    expected = CONTRACTS[name]
    actual = describe(con, source)
    problems = []
    missing = [c for c in expected if c not in actual]
    if missing:
        problems.append(f"missing columns {missing}")
    for col, want in expected.items():
        got = actual.get(col)
        if got is None:
            continue
        if strict:
            ok = got == want
        else:
            ok = got in COMPATIBLE[want] or (want == "DOUBLE" and got.startswith("DECIMAL"))
        if not ok:
            problems.append(f"{col}: expected {want}, got {got}")
    if strict and list(actual) != list(expected):
        problems.append(f"columns {list(actual)} != contract {list(expected)}")
    if problems:
        raise ContractError(f"{name} contract mismatch: " + "; ".join(problems))


def check_values(con: duckdb.DuckDBPyConnection, source: str, name: str) -> None:
    """Raise ContractError if a categorical column holds a value outside ENUMS[name]."""
    problems = []
    for col, allowed in ENUMS.get(name, {}).items():
        values = ", ".join(_q(v) for v in allowed)
        bad = con.execute(
            f"SELECT DISTINCT CAST({col} AS VARCHAR) FROM {source} "
            f"WHERE {col} IS NOT NULL AND CAST({col} AS VARCHAR) NOT IN ({values}) LIMIT 5"
        ).fetchall()
        if bad:
            problems.append(f"{col} has unexpected values {[b[0] for b in bad]}")
    if problems:
        raise ContractError(f"{name} contract mismatch: " + "; ".join(problems))


def _contract_select(name: str, source: str, where: str = "") -> str:
    cols = ", ".join(f"CAST({c} AS {t}) AS {c}" for c, t in CONTRACTS[name].items())
    order = ", ".join(SORT_KEYS[name])
    return f"SELECT {cols} FROM {source} {where} ORDER BY {order}"


def write_parquet(
    con: duckdb.DuckDBPyConnection, select_sql: str, out: Path, row_group_size: int | None = None
) -> None:
    opts = "FORMAT parquet, COMPRESSION zstd"
    if row_group_size:
        opts += f", ROW_GROUP_SIZE {row_group_size}"
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY ({select_sql}) TO {_q(out)} ({opts})")


def export_table(
    con: duckdb.DuckDBPyConnection,
    name: str,
    source: str,
    out: Path,
    where: str = "",
    row_group_size: int | None = None,
) -> int:
    """Write one contract table and re-check the written file strictly. Returns row count."""
    write_parquet(con, _contract_select(name, source, where), out, row_group_size)
    written = parquet_source(out)
    check_schema(con, written, name, strict=True)
    return con.execute(f"SELECT count(*) FROM {written}").fetchone()[0]


def check_input(con: duckdb.DuckDBPyConnection, source: str, name: str) -> None:
    """Contract checks for an input table: columns, castable types, categorical values."""
    check_schema(con, source, name)
    check_values(con, source, name)
    if con.execute(f"SELECT count(*) FROM {source} WHERE region IS NULL").fetchone()[0]:
        raise ContractError(f"{name} contract mismatch: null region")


def export_hotspots(
    con: duckdb.DuckDBPyConnection, source: str, public_dir: Path
) -> dict[str, int]:
    """Write one hotspots_{region}.parquet per region, sorted by time. Returns row counts."""
    regions = [
        r[0]
        for r in con.execute(
            f"SELECT DISTINCT CAST(region AS VARCHAR) FROM {source} ORDER BY 1"
        ).fetchall()
    ]
    for region in sorted(set(common.REGIONS) - set(regions)):
        print(f"warning: no hotspots for region {region}", file=sys.stderr)
    counts = {}
    for region in regions:
        out = public_dir / f"hotspots_{region}.parquet"
        where = f"WHERE CAST(region AS VARCHAR) = {_q(region)}"
        counts[region] = export_table(con, "hotspots", source, out, where, HOTSPOTS_ROW_GROUP)
    return counts


def _check_validation(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"missing input: {path}")
    data = json.loads(path.read_text())
    missing = [k for k in ("method_version", "regions") if k not in data]
    if missing:
        raise ContractError(f"validation.json missing keys {missing}")
    if data["method_version"] != common.METHOD_VERSION:
        raise ContractError(
            f"validation.json method_version {data['method_version']!r} "
            f"!= {common.METHOD_VERSION!r}"
        )


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def content_type(path: Path | str) -> str:
    return CONTENT_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def cache_control(path: Path | str) -> str:
    p = Path(path)
    if p.name == "index.json":
        return CACHE_CONTROL_INDEX
    if p.suffix.lower() == ".json":
        return CACHE_CONTROL_JSON
    return CACHE_CONTROL_DEFAULT


def build_index(
    con: duckdb.DuckDBPyConnection, public_dir: Path, generated_at: str | None = None
) -> dict:
    files = []
    for path in sorted(p for p in public_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(public_dir).as_posix()
        if rel == "index.json":
            continue
        rows = None
        if path.suffix == ".parquet":
            rows = con.execute(f"SELECT count(*) FROM read_parquet({_q(path)})").fetchone()[0]
        files.append(
            {
                "path": rel,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "rows": rows,
                "content_type": content_type(path),
            }
        )
    return {
        "method_version": common.METHOD_VERSION,
        "generated_at": generated_at
        or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "files": files,
    }


def export(
    processed_dir: Path = common.PROCESSED_DIR,
    public_dir: Path = common.PUBLIC_DIR,
    figures_dir: Path | None = None,
) -> dict:
    """Build PUBLIC_DIR from PROCESSED_DIR. Returns the index.json content."""
    processed_dir, public_dir = Path(processed_dir), Path(public_dir)
    if figures_dir is None:
        figures_dir = processed_dir / common.FIGURES_DIR.relative_to(common.PROCESSED_DIR)
    con = _connect()

    # Check every input before touching PUBLIC_DIR, so a bad run leaves the old export intact.
    hot_src = parquet_source(processed_dir / "hotspots_clean.parquet")
    check_input(con, hot_src, "hotspots")
    sources = {}
    for name in ("monthly", "coverage_month", "calibration"):
        sources[name] = parquet_source(processed_dir / f"{name}.parquet")
        check_input(con, sources[name], name)
    _check_validation(processed_dir / "validation.json")
    weather = processed_dir / "weather.parquet"
    weather_src = parquet_source(weather) if weather.exists() else None
    if weather_src:
        describe(con, weather_src)  # must at least be readable

    # PUBLIC_DIR is fully derived; rebuild it so stale files never get uploaded.
    if public_dir.exists():
        shutil.rmtree(public_dir)
    public_dir.mkdir(parents=True)

    counts = export_hotspots(con, hot_src, public_dir)
    for region, n in counts.items():
        print(f"hotspots_{region}.parquet: {n} rows")
    for name, source in sources.items():
        n = export_table(con, name, source, public_dir / f"{name}.parquet")
        print(f"{name}.parquet: {n} rows")
    shutil.copyfile(processed_dir / "validation.json", public_dir / "validation.json")
    if weather_src:
        write_parquet(con, f"SELECT * FROM {weather_src}", public_dir / "weather.parquet")
        print("weather.parquet: copied")

    figures = sorted(figures_dir.glob("*.png")) if figures_dir.is_dir() else []
    if not figures:
        print(f"warning: no figures in {figures_dir}", file=sys.stderr)
    for fig in figures:
        (public_dir / "figures").mkdir(exist_ok=True)
        shutil.copyfile(fig, public_dir / "figures" / fig.name)
    print(f"figures: {len(figures)}")

    index = build_index(con, public_dir)
    (public_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"wrote {public_dir / 'index.json'} ({len(index['files'])} files)")
    return index


def _set_gcs_metadata(dest: str, content_type: str, cache_control: str, bucket: str) -> None:
    """Set Content-Type and Cache-Control on an uploaded object.

    common.upload_to_gcs does not take these, so they are patched after upload.
    """
    from google.cloud import storage

    blob = storage.Client().bucket(bucket).blob(dest)
    blob.content_type = content_type
    blob.cache_control = cache_control
    blob.patch()


def upload_public(
    public_dir: Path = common.PUBLIC_DIR,
    bucket: str | None = None,
    *,
    upload: Callable[..., str] | None = None,
    set_metadata: Callable[[str, str, str, str], None] | None = None,
) -> list[str]:
    """Upload PUBLIC_DIR to gs://{bucket}/public/v1/. index.json goes last. Returns public URLs."""
    bucket = bucket or common.DATA_BUCKET
    if not bucket:
        raise RuntimeError("DATA_BUCKET is not set")
    upload = upload or common.upload_to_gcs
    set_metadata = set_metadata or _set_gcs_metadata
    public_dir = Path(public_dir)
    if not (public_dir / "index.json").exists():
        raise FileNotFoundError(f"{public_dir / 'index.json'} not found; run export first")

    files = sorted(p for p in public_dir.rglob("*") if p.is_file())
    files.sort(key=lambda p: p.relative_to(public_dir).as_posix() == "index.json")
    urls = []
    for path in files:
        dest = GCS_PREFIX + path.relative_to(public_dir).as_posix()
        upload(path, dest, bucket)
        set_metadata(dest, content_type(path), cache_control(path), bucket)
        url = common.public_url(dest, bucket)
        print(url)
        urls.append(url)
    return urls


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--processed-dir", type=Path, default=common.PROCESSED_DIR)
    parser.add_argument("--public-dir", type=Path, default=common.PUBLIC_DIR)
    parser.add_argument("--figures-dir", type=Path, default=None)
    parser.add_argument("--upload", action="store_true", help="upload to gs://$DATA_BUCKET")
    parser.add_argument("--bucket", default=common.DATA_BUCKET)
    args = parser.parse_args()

    if args.upload and not args.bucket:
        parser.error("--upload needs DATA_BUCKET or --bucket")
    try:
        export(args.processed_dir, args.public_dir, args.figures_dir)
    except (ContractError, FileNotFoundError) as exc:
        sys.exit(f"export failed: {exc}")
    if args.upload:
        upload_public(args.public_dir, args.bucket)


if __name__ == "__main__":
    main()
