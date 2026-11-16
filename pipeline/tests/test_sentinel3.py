import json

import numpy as np
import pandas as pd
import pytest
import xarray as xr

import sentinel3

BBOX = (-59.2, -22.2, -54.8, -15.4)


def _items(dates_utc, platform="Sentinel-3A"):
    return pd.DataFrame(
        {
            "id": [f"g{i}" for i in range(len(dates_utc))],
            "datetime": pd.to_datetime(dates_utc),
            "platform": platform,
            "orbit_state": "descending",
            "absolute_orbit": range(len(dates_utc)),
            "href": "https://example.invalid/x.nc",
        }
    )


def test_parse_granule_filters_bbox_and_handles_missing_vars():
    ds = xr.Dataset(
        {
            "latitude": ("fires", [-18.0, -10.0]),
            "longitude": ("fires", [-57.0, -57.0]),
            "time": ("fires", pd.to_datetime(["2023-09-01T13:30", "2023-09-01T13:30"])),
            "FRP_MWIR": ("fires", [10.0, 20.0]),
            "classification": ("fires", np.array([1, 1], dtype="uint8")),
        },
        attrs={"source": "IPF-SL-2-FRP 01.09"},
    )
    df = sentinel3.parse_granule(ds, BBOX)
    assert len(df) == 1
    assert np.isnan(df["confidence"].iloc[0])
    assert df["processor"].iloc[0] == "IPF-SL-2-FRP 01.09"


def test_select_granules_samples_whole_days():
    # Two granules per UTC afternoon, 4 consecutive days.
    dates = [f"2023-09-0{d}T13:{m}" for d in range(1, 5) for m in ("30", "33")]
    items = sentinel3.select_granules(_items(dates), BBOX, day_step=2)
    per_day = items.groupby("local_date")["sampled"].agg(["all", "any"])
    assert (per_day["all"] == per_day["any"]).all()  # never half a day
    assert items.groupby("local_date")["sampled"].first().sum() == 2


def test_aggregate_monthly_counts_scales_and_dedupes():
    # 4 days with data in Sept 2023; day_step=1 -> no scaling.
    items = sentinel3.select_granules(
        _items([f"2023-09-0{d}T13:30" for d in range(1, 5)]), BBOX, day_step=1
    )
    fires = pd.DataFrame(
        {
            "latitude": [-18.0, -18.0, -18.0, -18.5, -30.0],
            "longitude": [-57.0, -57.0, -57.0, -57.5, -57.0],
            "time": pd.to_datetime(
                [
                    "2023-09-01T13:30",
                    "2023-09-01T13:30",  # duplicate pixel, same orbit (frame overlap)
                    "2023-09-02T13:30",  # same cell, next day -> new cell-day
                    "2023-09-02T13:30",
                    "2023-09-02T13:30",  # outside bbox
                ]
            ),
            "classification": [1, 1, 1, 16, 1],  # 16 = industrial, dropped
            "platform": "Sentinel-3A",
            "orbit": [0, 0, 1, 1, 1],
        }
    )
    out = sentinel3.aggregate_monthly(fires, items, "pantanal", BBOX)
    row = out.iloc[0]
    assert list(out.columns[:5]) == ["region", "month", "detections", "cell_days", "granules"]
    assert str(row["month"]) == "2023-09-01"
    assert row["detections"] == 2
    assert row["cell_days"] == 2
    assert row["granules"] == 4

    # Same input sampled every 2nd day: counts scale by days_with_data / sampled_days.
    items2 = sentinel3.select_granules(items.drop(columns=["sampled"]), BBOX, day_step=2)
    out2 = sentinel3.aggregate_monthly(fires, items2, "pantanal", BBOX).iloc[0]
    assert out2["sampled_days"] == 2 and out2["days_with_data"] == 4
    assert out2["detections"] == 4  # 2 raw x (4 / 2)
    assert out2["cell_days"] == 4


def _synthetic():
    months = pd.date_range("2021-01-01", "2023-12-01", freq="MS")
    season = np.array([1, 1, 2, 3, 5, 10, 30, 80, 120, 60, 10, 2], dtype=float)
    base = np.tile(season, len(months) // 12)
    s3 = pd.DataFrame(
        {
            "region": "pantanal",
            "month": months.date,
            "detections": base * 3,
            "cell_days": base * 2,
            "granules": 160,
            "days_with_data": 30,
            "days_in_month": 30,
        }
    )
    # Harmonized lives at h3_r6 x month: split each month across two cells.
    harm = pd.concat(
        [
            pd.DataFrame(
                {"region": "pantanal", "h3_r6": c, "month": months, "harmonized": base * 5 / 2}
            )
            for c in ("a", "b")
        ]
    )
    return s3, harm


def test_compare_perfect_rank_agreement():
    s3, harm = _synthetic()
    res = sentinel3.compare(s3, harm)
    assert res["n_months"] == 36
    assert res["spearman_r"] == pytest.approx(1.0)
    assert res["peak_month_match"] == 1.0
    assert res["peak_months"]["2022"] == {"sentinel3": 9, "harmonized": 9, "match": True}


def test_compare_drops_low_coverage_and_provisional_months():
    s3, harm = _synthetic()
    s3.loc[0, "days_with_data"] = 10  # < 80% of 30 days
    harm["provisional"] = False
    harm.loc[harm["month"] == pd.Timestamp("2023-12-01"), "provisional"] = True
    res = sentinel3.compare(s3, harm)
    assert res["n_months"] == 34


def test_compare_peak_mismatch_and_too_short():
    s3, harm = _synthetic()
    sept_2021 = harm["month"] == pd.Timestamp("2021-09-01")
    harm.loc[sept_2021, "harmonized"] = 0
    res = sentinel3.compare(s3, harm)
    assert res["peak_months"]["2021"]["match"] is False
    assert res["peak_month_match"] == pytest.approx(2 / 3, abs=1e-3)

    short = sentinel3.compare(s3.head(2), harm)
    assert short["spearman_r"] is None and short["n_months"] == 2


def test_write_results_merges_into_validation_json(tmp_path):
    (tmp_path / "validation.json").write_text(
        json.dumps({"method_version": "1.0", "regions": {"pantanal": {"loyo_r": 0.9}}})
    )
    res = {"status": "ok", "spearman_r": 0.8, "n_months": 30, "peak_month_match": 1.0}
    out = sentinel3.write_results(res, tmp_path)
    data = json.loads(out.read_text())
    assert out.name == "validation.json"
    assert data["regions"]["pantanal"]["loyo_r"] == 0.9
    assert data["sentinel3"]["spearman_r"] == 0.8


def test_write_results_sidecar_when_pending_or_missing(tmp_path):
    out = sentinel3.write_results({"status": "ok", "spearman_r": 0.5}, tmp_path)
    assert out.name == "validation_sentinel3.json"
    (tmp_path / "validation.json").write_text("{}")
    out = sentinel3.write_results({"status": "pending"}, tmp_path)
    assert out.name == "validation_sentinel3.json"
    assert json.loads((tmp_path / "validation.json").read_text()) == {}


def test_plot_writes_png(tmp_path):
    s3, harm = _synthetic()
    merged = sentinel3.merge_series(s3, harm)
    path = sentinel3.plot(s3, merged, tmp_path / "s3.png", "pantanal")
    assert path.exists() and path.stat().st_size > 0
