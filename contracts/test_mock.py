"""Check the mock files against the contracts.

Run from the repo root: uv run --project pipeline pytest contracts/test_mock.py
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import h3
import pandas as pd
import pytest

import make_mock

MOCK = Path(__file__).resolve().parent / "mock"
MONTHLY = str(MOCK / "monthly.parquet")
CALIBRATION = str(MOCK / "calibration.parquet")
COVERAGE = str(MOCK / "coverage_month.parquet")
SERIES = str(MOCK / "series-pantanal.json")

MONTHLY_TYPES = [
    ("region", "VARCHAR"),
    ("h3_r6", "VARCHAR"),
    ("month", "DATE"),
    ("modis_raw", "DOUBLE"),
    ("viirs_raw", "DOUBLE"),
    ("harmonized", "DOUBLE"),
    ("harmonized_lo", "DOUBLE"),
    ("harmonized_hi", "DOUBLE"),
    ("source", "VARCHAR"),
    ("provisional", "BOOLEAN"),
    ("valid_days", "INTEGER"),
]
COVERAGE_TYPES = [
    ("region", "VARCHAR"),
    ("month", "DATE"),
    ("valid_days", "INTEGER"),
    ("modis_valid_days", "INTEGER"),
    ("viirs_valid_days", "INTEGER"),
]
CALIBRATION_TYPES = [
    ("region", "VARCHAR"),
    ("month_of_year", "INTEGER"),
    ("k", "DOUBLE"),
    ("k_lo", "DOUBLE"),
    ("k_hi", "DOUBLE"),
    ("n_years", "INTEGER"),
]
MONTH_KEYS = {
    "month",
    "harmonized",
    "lo",
    "hi",
    "modis_raw",
    "viirs_raw",
    "source",
    "provisional",
    "valid_days",
    "baseline_median",
    "baseline_mean",
    "z",
    "percentile",
}


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def monthly(con) -> pd.DataFrame:
    return con.execute("SELECT * FROM read_parquet(?)", [MONTHLY]).df()


@pytest.fixture(scope="module")
def coverage(con) -> pd.DataFrame:
    return con.execute("SELECT * FROM read_parquet(?)", [COVERAGE]).df()


def describe(con, sql: str, path: str) -> list[tuple[str, str]]:
    return [(r[0], r[1]) for r in con.execute(f"DESCRIBE {sql}", [path]).fetchall()]


def test_monthly_types(con):
    assert describe(con, "SELECT * FROM read_parquet(?)", MONTHLY) == MONTHLY_TYPES


def test_calibration_types(con):
    assert describe(con, "SELECT * FROM read_parquet(?)", CALIBRATION) == CALIBRATION_TYPES
    calib = con.execute("SELECT * FROM read_parquet(?)", [CALIBRATION]).df()
    assert sorted(calib["month_of_year"]) == list(range(1, 13))
    assert ((calib["k_lo"] <= calib["k"]) & (calib["k"] <= calib["k_hi"])).all()
    assert calib["k"].between(0.2, 0.34).all()  # raw VIIRS sees 3-5x more


def test_monthly_rules(monthly):
    m = monthly.assign(period=pd.to_datetime(monthly["month"]).dt.to_period("M"))
    assert str(m["period"].min()) == "2000-11"
    assert str(m["period"].max()) == "2026-10"
    assert set(m["region"]) == {"pantanal"}

    assert m["h3_r6"].notna().all()
    cells = m["h3_r6"].unique()
    assert 40 <= len(cells) <= 80
    assert all(h3.is_valid_cell(c) and h3.get_resolution(c) == 6 for c in cells)

    expected = m["period"].map(make_mock.source_for)
    assert (m["source"] == expected).all()
    assert (m.loc[m["period"] < pd.Period("2002-07", "M"), "source"] == "terra_scaled").all()

    assert m.loc[m["period"] < pd.Period("2012-01", "M"), "viirs_raw"].isna().all()
    assert m.loc[m["period"] >= pd.Period("2012-01", "M"), "viirs_raw"].notna().all()

    data = m[m["valid_days"] > 0]
    band = data["source"] != "viirs_scaled"
    assert (data.loc[band, "harmonized_lo"] == data.loc[band, "harmonized"]).all()
    assert (data.loc[band, "harmonized_hi"] == data.loc[band, "harmonized"]).all()
    observed = data[data["source"] == "modis"]
    assert (observed["harmonized"] == observed["modis_raw"]).all()
    assert (data["harmonized_lo"] <= data["harmonized"]).all()
    assert (data["harmonized"] <= data["harmonized_hi"]).all()
    viirs = data[data["source"] == "viirs_scaled"]
    assert (viirs["harmonized_lo"] < viirs["harmonized_hi"]).any()

    # Rows are cells with fire only; no-data months have no rows at all.
    assert ((m["modis_raw"] > 0) | (m["viirs_raw"].fillna(0) > 0)).all()
    assert not m.duplicated(["region", "h3_r6", "month"]).any()
    assert (m["valid_days"] > 0).all()
    assert m[["harmonized", "harmonized_lo", "harmonized_hi"]].notna().all().all()

    # valid_days and provisional are region-level: constant within a region-month.
    per_month = m.groupby("period")[["valid_days", "provisional", "source"]].nunique()
    assert (per_month == 1).all().all()
    assert set(m.loc[m["provisional"], "period"].astype(str)) == {"2026-10"}


def test_coverage_types(con):
    assert describe(con, "SELECT * FROM read_parquet(?)", COVERAGE) == COVERAGE_TYPES


def test_coverage_rules(coverage, monthly):
    c = coverage.assign(period=pd.to_datetime(coverage["month"]).dt.to_period("M"))
    full = pd.period_range("2000-11", "2026-10", freq="M")
    assert list(c["period"]) == list(full)  # every region-month, fire or not
    assert set(c["region"]) == {"pantanal"}
    assert not c.duplicated(["region", "month"]).any()
    days = c["period"].map(lambda p: p.days_in_month)
    for col in ("valid_days", "modis_valid_days", "viirs_valid_days"):
        assert c[col].between(0, days).all()
        assert (c[col] <= c["valid_days"]).all()
    assert (c.loc[c["period"] < pd.Period("2012-01", "M"), "viirs_valid_days"] == 0).all()

    fire_months = set(pd.to_datetime(monthly["month"]).dt.to_period("M"))
    no_rows = c[~c["period"].isin(fire_months)].set_index("period")["valid_days"]
    assert no_rows.to_dict() == {pd.Period("2001-07", "M"): 0, pd.Period("2005-02", "M"): 28}

    # monthly.valid_days repeats the coverage value for its region-month.
    m = monthly.merge(coverage, on=["region", "month"], suffixes=("", "_cov"))
    assert len(m) == len(monthly)
    assert (m["valid_days"] == m["valid_days_cov"]).all()


def test_monthly_shapes(monthly):
    m = monthly.assign(year=pd.to_datetime(monthly["month"]).dt.year)
    m["moy"] = pd.to_datetime(m["month"]).dt.month
    overlap = m[(m["year"] >= 2012) & (m["year"] <= 2019)]
    raw_ratio = overlap["viirs_raw"].sum() / overlap["modis_raw"].sum()
    assert 3.0 <= raw_ratio <= 5.0  # the 2012 raw-VIIRS jump

    annual = m.groupby("year")["harmonized"].sum()
    assert annual.idxmax() == 2020

    season = m[m["year"].between(2003, 2022)].groupby("moy")["harmonized"].sum()
    assert season.idxmax() in (8, 9)


def test_series_loads_in_duckdb(con):
    row = con.execute(
        "SELECT len(months), summary.peak_year, summary.peak_month_of_year, "
        "meta.method_version, meta.cell_count FROM read_json_auto(?)",
        [SERIES],
    ).fetchone()
    assert row[0] == 312
    assert row[1] == 2020
    assert row[2] in (8, 9)
    assert row[3] == "1.0"
    assert row[4] > 0


def test_series_shape():
    series = json.loads(Path(SERIES).read_text())
    assert set(series) == {"months", "summary", "meta"}
    for month in series["months"]:
        assert set(month) == MONTH_KEYS
    assert set(series["meta"]) == {"method_version", "area_km2", "cell_count", "warnings"}
    summary = series["summary"]
    assert {"current", "peak_month_of_year", "peak_year", "annual"} == set(summary)
    assert summary["current"]["month"] == "2026-10"
    assert summary["current"]["partial"] is True
    for entry in summary["annual"]:
        assert set(entry) == {"year", "total", "rank", "complete"}
        assert (entry["rank"] is None) == (not entry["complete"])


def test_series_zero_versus_missing():
    months = {m["month"]: m for m in json.loads(Path(SERIES).read_text())["months"]}
    assert months["2005-02"]["harmonized"] == 0.0 and months["2005-02"]["valid_days"] == 28
    assert months["2001-07"]["harmonized"] is None and months["2001-07"]["valid_days"] == 0


def test_series_matches_monthly(monthly, coverage):
    """The JSON is the reference output for the mock request; keep it in sync."""
    req = make_mock.MOCK_REQUEST
    got = make_mock.build_series(
        monthly,
        coverage,
        req["start"],
        req["end"],
        region=req["region"],
        baseline=tuple(req["baseline"]),
    )
    assert got == json.loads(Path(SERIES).read_text())


def test_mock_is_deterministic(monthly):
    a, calib_a = make_mock.build_monthly()
    b, calib_b = make_mock.build_monthly()
    pd.testing.assert_frame_equal(a, b)
    pd.testing.assert_frame_equal(calib_a, calib_b)
    assert len(a) == len(monthly)
    assert a["harmonized"].sum() == pytest.approx(monthly["harmonized"].sum())
    pd.testing.assert_frame_equal(make_mock.build_coverage(), make_mock.build_coverage())
