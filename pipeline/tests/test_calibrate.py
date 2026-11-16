import time

import numpy as np
import pandas as pd
import pytest

import common
from calibrate import apply_k, fit_calibration


def make_cell_days(
    region="pantanal",
    years=common.FIT_YEARS,
    ratio=0.3,
    viirs_per_month=200.0,
    cells=3,
    noise=0.0,
    seed=0,
    overrides=None,
):
    """Synthetic cell_days rows: `cells` H3 cells per month, modis ~= ratio * viirs.

    overrides maps month_of_year -> (modis_per_cell, viirs_per_cell) to force a stratum.
    """
    rng = np.random.default_rng(seed)
    rows = []
    for y in years:
        for m in range(1, 13):
            for c in range(cells):
                viirs = viirs_per_month / cells
                modis = ratio * viirs * (1 + noise * rng.standard_normal())
                if overrides and m in overrides:
                    modis, viirs = overrides[m]
                rows.append(
                    {
                        "region": region,
                        "h3_r6": f"86{c:013x}",
                        "month": pd.Timestamp(year=y, month=m, day=1).date(),
                        "modis": max(modis, 0.0),
                        "viirs": viirs,
                    }
                )
    return pd.DataFrame(rows)


def test_output_contract():
    out = fit_calibration(make_cell_days(), n_boot=50)
    assert list(out.columns) == ["region", "month_of_year", "k", "k_lo", "k_hi", "n_years"]
    assert len(out) == 12
    assert sorted(out["month_of_year"]) == list(range(1, 13))
    assert (out["n_years"] == len(common.FIT_YEARS)).all()
    np.testing.assert_allclose(out["k"], 0.3)


def test_ignores_rows_outside_fit_years():
    fit = make_cell_days(ratio=0.3)
    outside = make_cell_days(years=(2008, 2022), ratio=5.0)
    out = fit_calibration(pd.concat([fit, outside]), n_boot=20)
    np.testing.assert_allclose(out["k"], 0.3)


def test_zero_viirs_month_stays_zero():
    # Month 7 has MODIS fires but no VIIRS: k falls back to k_region (finite), and applying k
    # to zero VIIRS gives zero harmonized.
    cd = make_cell_days(overrides={7: (5.0, 0.0)})
    out = fit_calibration(cd, n_boot=100).set_index("month_of_year")
    k_region = cd["modis"].sum() / cd["viirs"].sum()
    assert out.loc[7, "k"] == pytest.approx(k_region)
    assert np.isfinite(out.loc[7, ["k", "k_lo", "k_hi"]].astype(float)).all()
    assert apply_k(0.0, out.loc[7, "k"]) == 0.0
    harmonized = apply_k(pd.Series([0.0, 0.0, 10.0]), out["k"].to_numpy()[:3])
    assert harmonized.iloc[0] == 0.0 and harmonized.iloc[1] == 0.0
    assert harmonized.iloc[2] == pytest.approx(10.0 * out["k"].to_numpy()[2])


def test_apply_k_zero_with_nan_k_and_no_intercept():
    assert apply_k(0.0, np.nan) == 0.0
    np.testing.assert_allclose(apply_k(np.array([0.0, 4.0]), 0.25), [0.0, 1.0])


def test_tiny_stratum_pulled_toward_region():
    # Month 3 is thin (n = 8 years * 1 = 8 MODIS cell-days) with raw k = 1.0; everything else
    # is 0.3 with plenty of data. Shrinkage should land near k_region, far from 1.0.
    cd = make_cell_days(cells=1, overrides={3: (1.0, 1.0)}, viirs_per_month=1000.0)
    out = fit_calibration(cd, n0=50.0, n_boot=50).set_index("month_of_year")
    k_region = cd["modis"].sum() / cd["viirs"].sum()
    n = 8.0
    expected = (n * 1.0 + 50.0 * k_region) / (n + 50.0)
    assert out.loc[3, "k"] == pytest.approx(expected)
    assert abs(out.loc[3, "k"] - k_region) < abs(1.0 - k_region) / 2
    # A large stratum barely moves.
    assert out.loc[6, "k"] == pytest.approx(0.3, rel=0.02)
    # Without shrinkage the thin stratum keeps its raw ratio.
    raw = fit_calibration(cd, n0=0.0, n_boot=0).set_index("month_of_year")
    assert raw.loc[3, "k"] == pytest.approx(1.0)


def test_bootstrap_seeded_and_reproducible():
    cd = make_cell_days(noise=0.4, seed=3)
    a = fit_calibration(cd, n_boot=200, seed=7)
    b = fit_calibration(cd, n_boot=200, seed=7)
    pd.testing.assert_frame_equal(a, b)
    c = fit_calibration(cd, n_boot=200, seed=8)
    assert not np.allclose(a["k_lo"], c["k_lo"])
    # Point estimate does not depend on the seed.
    np.testing.assert_allclose(a["k"], c["k"])


def test_band_contains_point_estimate():
    cd = pd.concat(
        [
            make_cell_days("pantanal", noise=0.5, seed=1),
            make_cell_days("punjab", ratio=0.2, noise=0.8, seed=2, cells=1, viirs_per_month=20),
        ]
    )
    out = fit_calibration(cd, n_boot=300)
    assert (out["k_lo"] <= out["k"]).all()
    assert (out["k"] <= out["k_hi"]).all()
    assert (out["k_hi"] > out["k_lo"]).any()
    assert set(out["region"]) == {"pantanal", "punjab"}


def test_leave_one_year_out_subset():
    cd = make_cell_days(noise=0.3, seed=5)
    for held in common.FIT_YEARS:
        train = [y for y in common.FIT_YEARS if y != held]
        out = fit_calibration(cd, fit_years=train, n_boot=100)
        assert len(out) == 12
        assert (out["n_years"] == len(train)).all()
        assert np.isfinite(out["k"]).all()
        assert (out["k_lo"] <= out["k"]).all() and (out["k"] <= out["k_hi"]).all()
    # Excluding a year changes the fit when that year differs.
    skew = cd.copy()
    skew.loc[pd.to_datetime(skew["month"]).dt.year == 2015, "modis"] *= 3
    full = fit_calibration(skew, n_boot=0)
    loyo = fit_calibration(skew, fit_years=[y for y in common.FIT_YEARS if y != 2015], n_boot=0)
    assert (loyo["k"] < full["k"]).all()


def test_month_without_fit_data_uses_region_k():
    cd = make_cell_days()
    cd = cd[pd.to_datetime(cd["month"]).dt.month != 1]
    out = fit_calibration(cd, n_boot=50).set_index("month_of_year")
    assert out.loc[1, "n_years"] == 0
    assert out.loc[1, "k"] == pytest.approx(0.3)


def test_bootstrap_is_fast_enough():
    cd = pd.concat(
        make_cell_days(r, cells=20, noise=0.3, seed=i) for i, r in enumerate(common.REGIONS)
    )
    t0 = time.perf_counter()
    for held in common.FIT_YEARS:
        fit_calibration(cd, fit_years=[y for y in common.FIT_YEARS if y != held])
    assert time.perf_counter() - t0 < 10.0


def test_region_band_independent_of_other_regions():
    a = make_cell_days("pantanal", noise=0.4, seed=1)
    b = make_cell_days("punjab", noise=0.4, seed=2)
    both = fit_calibration(pd.concat([a, b]), n_boot=200)
    alone = fit_calibration(b, n_boot=200)
    pd.testing.assert_frame_equal(
        both[both["region"] == "punjab"].reset_index(drop=True), alone.reset_index(drop=True)
    )
