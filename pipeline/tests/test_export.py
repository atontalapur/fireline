import datetime as dt
import hashlib
import json

import duckdb
import pandas as pd
import pytest

import common
import export


def _hotspots() -> pd.DataFrame:
    # Deliberately unsorted, tz-aware timestamps and an extra column, as clean.py might write.
    return pd.DataFrame(
        {
            "region": ["pantanal", "pantanal", "punjab", "pantanal"],
            "sensor": ["VIIRS_NOAA20", "MODIS_TERRA", "MODIS_AQUA", "VIIRS_SNPP"],
            "product": ["SP", "SP", "SP", "NRT"],
            "acq_datetime_utc": pd.to_datetime(
                ["2020-08-02 17:00", "2019-08-01 13:30", "2018-10-20 05:10", "2020-08-01 04:00"],
                utc=True,
            ),
            "local_date": [dt.date(2020, 8, 2), dt.date(2019, 8, 1), dt.date(2018, 10, 20),
                           dt.date(2020, 7, 31)],
            "latitude": [-18.1, -18.2, 30.5, -18.3],
            "longitude": [-57.1, -57.2, 75.5, -57.3],
            "confidence": ["nominal", "high", "low", "high"],
            "confidence_raw": ["n", "85", "35", "h"],
            "frp": [5.0, 12.5, 3.25, 7.0],
            "daynight": ["D", "D", "N", "N"],
            "h3_r8": ["88a8100001fffff"] * 4,
            "h3_r6": ["86a810007ffffff"] * 4,
            "scan": [0.4, 1.0, 1.1, 0.5],
        }
    )  # fmt: skip


def _monthly() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "region": ["pantanal", "pantanal"],
            "h3_r6": ["86a810007ffffff", "86a810007ffffff"],
            "month": [dt.date(2020, 8, 1), dt.date(2019, 8, 1)],
            "modis_raw": [None, 4.0],
            "viirs_raw": [3.0, 9.5],
            "harmonized": [1.2, 4.0],
            "harmonized_lo": [1.0, 4.0],
            "harmonized_hi": [1.5, 4.0],
            "source": ["viirs_scaled", "modis"],
            "provisional": [False, False],
            "valid_days": [31, 31],
        }
    )


def _coverage_month() -> pd.DataFrame:
    # Includes a zero-fire month (2020-07) and a no-data month (2020-06) with no monthly rows.
    return pd.DataFrame(
        {
            "region": ["pantanal"] * 3,
            "month": [dt.date(2020, 8, 1), dt.date(2020, 7, 1), dt.date(2020, 6, 1)],
            "valid_days": pd.array([31, 31, 0], dtype="int32"),
            "modis_valid_days": [31, 31, 0],
            "viirs_valid_days": pd.array([31, 30, 0], dtype="int32"),
        }
    )


def _calibration() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "region": ["pantanal", "punjab"],
            "month_of_year": [8, 10],
            "k": [0.4, 0.35],
            "k_lo": [0.3, 0.3],
            "k_hi": [0.5, 0.4],
            "n_years": [8, 8],
        }
    )


@pytest.fixture
def processed(tmp_path):
    d = tmp_path / "processed"
    (d / "figures").mkdir(parents=True)
    con = duckdb.connect()
    hot = _hotspots()  # noqa: F841 (read by DuckDB replacement scan)
    con.execute(
        f"COPY hot TO '{d / 'hotspots_clean.parquet'}' (FORMAT parquet, PARTITION_BY (region))"
    )
    _monthly().to_parquet(d / "monthly.parquet")
    _calibration().to_parquet(d / "calibration.parquet")
    _coverage_month().to_parquet(d / "coverage_month.parquet")
    (d / "validation.json").write_text(
        json.dumps({"method_version": common.METHOD_VERSION, "regions": {"pantanal": {}}})
    )
    pd.DataFrame({"region": ["pantanal"], "temp_c": [31.0]}).to_parquet(d / "weather.parquet")
    for name in ("seam_pantanal.png", "scatter_pantanal.png"):
        (d / "figures" / name).write_bytes(b"\x89PNG fake " + name.encode())
    return d


def _describe(path) -> dict[str, str]:
    rows = duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    return {r[0]: r[1] for r in rows}


def test_export_writes_contract_files(processed, tmp_path):
    public = tmp_path / "public"
    export.export(processed, public)

    names = sorted(p.relative_to(public).as_posix() for p in public.rglob("*") if p.is_file())
    assert names == [
        "calibration.parquet",
        "coverage_month.parquet",
        "figures/scatter_pantanal.png",
        "figures/seam_pantanal.png",
        "hotspots_pantanal.parquet",
        "hotspots_punjab.parquet",
        "index.json",
        "monthly.parquet",
        "validation.json",
        "weather.parquet",
    ]
    for name in ("hotspots", "monthly", "coverage_month", "calibration"):
        path = public / (f"{name}.parquet" if name != "hotspots" else "hotspots_pantanal.parquet")
        assert _describe(path) == export.CONTRACTS[name]

    pan = duckdb.sql(f"SELECT * FROM read_parquet('{public / 'hotspots_pantanal.parquet'}')").df()
    assert len(pan) == 3 and set(pan["region"]) == {"pantanal"}
    assert pan["acq_datetime_utc"].is_monotonic_increasing
    assert pan["acq_datetime_utc"].iloc[0] == pd.Timestamp("2019-08-01 13:30")

    codecs = duckdb.sql(
        f"SELECT DISTINCT compression FROM parquet_metadata('{public / 'monthly.parquet'}')"
    ).fetchall()
    assert codecs == [("ZSTD",)]
    assert (public / "validation.json").read_bytes() == (processed / "validation.json").read_bytes()

    cov = duckdb.sql(f"SELECT * FROM read_parquet('{public / 'coverage_month.parquet'}')").df()
    assert list(cov["month"].astype(str)) == ["2020-06-01", "2020-07-01", "2020-08-01"]
    assert list(cov["valid_days"]) == [0, 31, 31]


def test_index_json(processed, tmp_path):
    public = tmp_path / "public"
    export.export(processed, public)
    index = json.loads((public / "index.json").read_text())

    assert index["method_version"] == common.METHOD_VERSION
    assert index["generated_at"].endswith("Z")
    by_path = {f["path"]: f for f in index["files"]}
    assert "index.json" not in by_path
    assert by_path["hotspots_pantanal.parquet"]["rows"] == 3
    assert by_path["hotspots_punjab.parquet"]["rows"] == 1
    assert by_path["monthly.parquet"]["rows"] == 2
    assert by_path["coverage_month.parquet"]["rows"] == 3
    assert by_path["validation.json"]["rows"] is None
    for rel, entry in by_path.items():
        data = (public / rel).read_bytes()
        assert entry["bytes"] == len(data)
        assert entry["sha256"] == hashlib.sha256(data).hexdigest()


@pytest.mark.parametrize(
    ("file", "mutate", "match"),
    [
        ("monthly", lambda df: df.assign(month=df["month"].astype(str)), "month: expected DATE"),
        ("monthly", lambda df: df.drop(columns="valid_days"), "missing columns"),
        ("calibration", lambda df: df.assign(n_years=df["n_years"] * 1.5), "n_years"),
        ("monthly", lambda df: df.assign(source="scaled"), "source has unexpected"),
        (
            "coverage_month",
            lambda df: df.assign(month=pd.to_datetime(df["month"])),
            "month: expected DATE",
        ),
        ("coverage_month", lambda df: df.drop(columns="viirs_valid_days"), "missing columns"),
        ("coverage_month", lambda df: df.assign(region="amazon"), "region has unexpected"),
    ],
)
def test_schema_mismatch_fails_before_writing(processed, tmp_path, file, mutate, match):
    frames = {"monthly": _monthly, "calibration": _calibration, "coverage_month": _coverage_month}
    frame = frames[file]()
    mutate(frame).to_parquet(processed / f"{file}.parquet")
    public = tmp_path / "public"
    public.mkdir()
    (public / "old.txt").write_text("previous export")

    with pytest.raises(export.ContractError, match=match):
        export.export(processed, public)
    assert (public / "old.txt").exists()


def test_missing_coverage_month_fails(processed, tmp_path):
    (processed / "coverage_month.parquet").unlink()
    with pytest.raises(FileNotFoundError, match="coverage_month"):
        export.export(processed, tmp_path / "public")


def test_bad_hotspot_sensor_fails(processed, tmp_path):
    con = duckdb.connect()
    hot = _hotspots().assign(sensor="MODIS")  # noqa: F841
    path = processed / "hotspots_clean.parquet"
    for f in path.rglob("*.parquet"):
        f.unlink()
    con.execute(f"COPY hot TO '{path}' (FORMAT parquet, PARTITION_BY (region))")
    with pytest.raises(export.ContractError, match="sensor"):
        export.export(processed, tmp_path / "public")


def test_upload_destinations(processed, tmp_path):
    public = tmp_path / "public"
    export.export(processed, public)
    uploads, meta = [], {}

    def fake_upload(local, dest, bucket):
        uploads.append((local.relative_to(public).as_posix(), dest, bucket))
        return f"gs://{bucket}/{dest}"

    def fake_meta(dest, ctype, cache, bucket):
        meta[dest] = (ctype, cache)

    urls = export.upload_public(public, "fire-bkt", upload=fake_upload, set_metadata=fake_meta)

    assert len(uploads) == 10
    assert all(dest == "public/v1/" + rel and b == "fire-bkt" for rel, dest, b in uploads)
    assert uploads[-1][1] == "public/v1/index.json"
    assert meta["public/v1/index.json"] == ("application/json", export.CACHE_CONTROL_INDEX)
    assert meta["public/v1/monthly.parquet"][0] == "application/vnd.apache.parquet"
    assert meta["public/v1/figures/seam_pantanal.png"][0] == "image/png"
    assert urls[-1] == "https://storage.googleapis.com/fire-bkt/public/v1/index.json"


def test_upload_needs_bucket(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "DATA_BUCKET", "")
    with pytest.raises(RuntimeError, match="DATA_BUCKET"):
        export.upload_public(tmp_path, None, upload=lambda *a: "", set_metadata=lambda *a: None)
