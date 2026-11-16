import json
import math

import numpy as np
import pandas as pd
import pytest

import common
import validate as v


def ratio_fit(cell_days, fit_years=common.FIT_YEARS, **_):
    """Stand-in for calibrate.fit_calibration: k = sum(MODIS) / sum(VIIRS) per region x month."""
    d = cell_days.copy()
    m = pd.to_datetime(d["month"])
    d = d[m.dt.year.isin(fit_years)]
    d["month_of_year"] = pd.to_datetime(d["month"]).dt.month
    g = d.groupby(["region", "month_of_year"], as_index=False)[["modis", "viirs"]].sum()
    g["k"] = g["modis"] / g["viirs"]
    return g[["region", "month_of_year", "k"]]


def synthetic_cell_days(ratio=4.0, start="2008-01", end="2025-12", seed=0, regions=("a", "b")):
    """Two cells per region, seasonal MODIS counts, VIIRS = ratio x MODIS (from 2012)."""
    rng = np.random.default_rng(seed)
    months = pd.date_range(start, end, freq="MS")
    rows = []
    for region in regions:
        for cell in ("c1", "c2"):
            for mo in months:
                season = 50 + 40 * math.sin(2 * math.pi * (mo.month - 3) / 12)
                modis = max(1.0, season * rng.uniform(0.9, 1.1))
                viirs = ratio * modis if mo.year >= 2012 else 0.0
                rows.append(
                    {
                        "region": region,
                        "h3_r6": cell,
                        "month": mo.date(),
                        "modis": modis,
                        "viirs": viirs,
                    }
                )
    return pd.DataFrame(rows)


def synthetic_monthly(cell_days, calibration, switch="2020-01"):
    """Minimal splice: observed MODIS before the switch, k x VIIRS after."""
    d = cell_days.copy()
    d["month_of_year"] = pd.to_datetime(d["month"]).dt.month
    d = d.merge(calibration, on=["region", "month_of_year"], how="left")
    after = pd.to_datetime(d["month"]) >= pd.Timestamp(switch)
    d["harmonized"] = np.where(after, d["k"] * d["viirs"], d["modis"])
    return d[["region", "h3_r6", "month", "harmonized"]]


def test_pettitt_detects_step():
    rng = np.random.default_rng(1)
    x = np.concatenate([rng.normal(0, 1, 30), rng.normal(5, 1, 30)])
    p, t = v.pettitt_test(x)
    assert p < 0.01
    assert abs(t - 30) <= 2


def test_pettitt_flat_and_noise():
    p, _ = v.pettitt_test(np.ones(40))
    assert p == 1.0
    rng = np.random.default_rng(2)
    p, _ = v.pettitt_test(rng.normal(0, 1, 48))
    assert p > 0.05


def test_seam_ratio_near_one_on_consistent_data():
    cd = synthetic_cell_days()
    cal = ratio_fit(cd)
    monthly = synthetic_monthly(cd, cal)
    res = v.seam_metrics(monthly, "2020-01", ("2015-01",))
    for region in ("a", "b"):
        assert res[region]["seam_ratio"] == pytest.approx(1.0, abs=0.05)
        assert res[region]["changepoint_p"] > 0.05
        assert res[region]["placebo"][0]["month"] == "2015-01"
        assert res[region]["placebo"][0]["seam_ratio"] == pytest.approx(1.0, abs=0.05)


def test_seam_detects_unharmonized_step():
    cd = synthetic_cell_days()
    cal = ratio_fit(cd).assign(k=1.0)  # no scaling: VIIRS era is 4x higher
    monthly = synthetic_monthly(cd, cal)
    res = v.seam_metrics(monthly, "2020-01", ())
    assert res["a"]["seam_ratio"] == pytest.approx(4.0, rel=0.05)
    assert res["a"]["changepoint_p"] < 0.01
    assert res["a"]["changepoint_month"] == "2020-01"


def test_seam_insufficient_data_is_nan():
    s = pd.Series([1.0] * 6, index=pd.date_range("2019-10", periods=6, freq="MS"))
    res = v.seam_test(s, "2020-01")
    assert math.isnan(res["seam_ratio"])
    assert math.isnan(res["changepoint_p"])


def test_overlap_bias_raw_four_harmonized_one():
    cd = synthetic_cell_days(ratio=4.0)
    res = v.overlap_bias(cd, ratio_fit(cd))
    for region in ("a", "b"):
        assert res[region]["raw_bias"] == pytest.approx(4.0)
        assert res[region]["harmonized_bias"] == pytest.approx(1.0, abs=0.05)
        assert res[region]["harmonized_bias_pooled"] == pytest.approx(1.0)
        assert res[region]["bias_n_months"] == 96
        assert res[region]["bias_period"] == ["2012-01", "2019-12"]


def test_loyo_excludes_held_out_year():
    cd = synthetic_cell_days(start="2012-01", end="2019-12")
    calls = []

    def spy(cell_days, fit_years):
        years_in_data = set(pd.to_datetime(cell_days["month"]).dt.year)
        calls.append((tuple(fit_years), years_in_data))
        return ratio_fit(cell_days, fit_years)

    res = v.loyo(cd, spy)
    assert len(calls) == len(common.FIT_YEARS)
    for held_out, (fit_years, years_in_data) in zip(common.FIT_YEARS, calls, strict=True):
        assert held_out not in fit_years
        assert held_out not in years_in_data
        assert set(fit_years) == set(common.FIT_YEARS) - {held_out}
    assert res["a"]["loyo_r"] > 0.9
    assert res["a"]["loyo_nrmse"] < 0.2
    assert res["a"]["loyo_n_months"] == 96


def test_forward_test_reports_drift():
    cd = synthetic_cell_days()
    after = pd.to_datetime(cd["month"]) >= pd.Timestamp("2020-01")
    cd.loc[after, "modis"] *= 0.8  # MODIS loses 20% after the switch (orbit drift)
    res = v.forward_test(cd, ratio_fit)
    assert res["a"]["forward_bias_pooled"] == pytest.approx(1.25, rel=0.05)
    assert res["a"]["forward_n_months"] == 72
    assert res["a"]["forward_period"] == ["2020-01", "2025-12"]


def test_peak_month_match():
    cd = synthetic_cell_days(start="2012-01", end="2019-12")
    pred = v.apply_k(v.region_month_totals(cd, ["modis", "viirs"]), ratio_fit(cd))
    res = v.peak_month_match(pred)
    assert res["a"]["peak_month_n_years"] == 8
    assert res["a"]["peak_month_match"] == 1.0


def test_validate_json_serializable_with_nulls(tmp_path):
    cd = synthetic_cell_days(end="2021-06")  # too short for the 2023 placebo
    cal = ratio_fit(cd)
    monthly = synthetic_monthly(cd, cal)
    payload = v.validate(cd, ratio_fit, cal, monthly, figures_dir=tmp_path / "figures")
    out = v.write_json(payload, tmp_path / "validation.json")
    data = json.loads(out.read_text())
    assert data["method_version"] == common.METHOD_VERSION
    region = data["regions"]["a"]
    for key in (
        "raw_bias",
        "harmonized_bias",
        "loyo_r",
        "loyo_nrmse",
        "forward_r",
        "seam_ratio",
        "changepoint_p",
        "placebo",
        "peak_month_match",
        "figures",
    ):
        assert key in region
    placebo_2023 = [p for p in region["placebo"] if p["month"] == "2023-01"][0]
    assert placebo_2023["seam_ratio"] is None
    assert region["figures"]["scatter"] == "figures/scatter_a.png"
    assert region["figures"]["seam"] is None
    assert (tmp_path / "figures" / "scatter_a.png").exists()


def test_to_jsonable_nan_to_null():
    obj = {"a": float("nan"), "b": np.float64(np.inf), "c": [np.int64(3), np.bool_(True)]}
    assert json.loads(json.dumps(v.to_jsonable(obj), allow_nan=False)) == {
        "a": None,
        "b": None,
        "c": [3, True],
    }
