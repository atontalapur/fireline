from datetime import date

import numpy as np
import pandas as pd
import pytest

import common
import splice as sp


def make_cell_days(
    regions=("pantanal",),
    cells=("86a8100c7ffffff", "86a8100cfffffff"),
    start="2000-11",
    end="2025-12",
    terra=5.0,
    aqua=5.0,
    viirs_factor=4.0,
):
    """Constant synthetic cell-days. Aqua is zero before 2002-07, VIIRS zero before 2012."""
    months = pd.date_range(start, end, freq="MS")
    rows = []
    for region in regions:
        for cell in cells:
            for m in months:
                a = aqua if m >= pd.Timestamp("2002-07-01") else 0.0
                v = viirs_factor * (terra + aqua) if m >= pd.Timestamp("2012-01-01") else 0.0
                rows.append(
                    {
                        "region": region,
                        "h3_r6": cell,
                        "month": m.date(),
                        "terra": terra,
                        "aqua": a,
                        "modis": terra + a,
                        "viirs": v,
                        "valid_days": m.days_in_month,
                    }
                )
    return pd.DataFrame(rows)


def make_calibration(regions=("pantanal",), k=0.25, k_lo=0.2, k_hi=0.3):
    return pd.DataFrame(
        [
            {
                "region": r,
                "month_of_year": moy,
                "k": k,
                "k_lo": k_lo,
                "k_hi": k_hi,
                "n_years": 8,
            }
            for r in regions
            for moy in range(1, 13)
        ]
    )


TODAY = date(2030, 1, 15)


def run(cd=None, cal=None, **kw):
    kw.setdefault("today", TODAY)
    return sp.splice(
        make_cell_days() if cd is None else cd,
        make_calibration() if cal is None else cal,
        **kw,
    )


def at(df, month):
    return df[df["month"] == pd.Timestamp(month + "-01")]


def test_output_columns():
    out = run()
    assert list(out.columns) == sp.OUT_COLUMNS
    assert out["provisional"].dtype == bool


def test_source_per_period():
    out = run()
    assert set(at(out, "2000-11")["source"]) == {"terra_scaled"}
    assert set(at(out, "2002-06")["source"]) == {"terra_scaled"}
    assert set(at(out, "2002-07")["source"]) == {"modis"}
    assert set(at(out, "2019-12")["source"]) == {"modis"}
    assert set(at(out, "2020-01")["source"]) == {"viirs_scaled"}
    assert set(at(out, "2025-12")["source"]) == {"viirs_scaled"}


def test_raw_columns_null_outside_records():
    out = run()
    assert at(out, "2011-12")["viirs_raw"].isna().all()
    assert at(out, "2012-01")["viirs_raw"].notna().all()
    assert at(out, "2015-06")["modis_raw"].eq(10.0).all()


def test_modis_period_band_equals_value():
    m = run().query("source == 'modis'")
    assert (m["harmonized"] == m["modis_raw"]).all()
    assert (m["harmonized_lo"] == m["harmonized"]).all()
    assert (m["harmonized_hi"] == m["harmonized"]).all()


def test_viirs_scaled_uses_k_band():
    v = run().query("source == 'viirs_scaled'")
    assert np.allclose(v["harmonized"], 0.25 * v["viirs_raw"])
    assert np.allclose(v["harmonized_lo"], 0.2 * v["viirs_raw"])
    assert np.allclose(v["harmonized_hi"], 0.3 * v["viirs_raw"])


def test_band_brackets_harmonized():
    cal = make_calibration(k=0.25, k_lo=0.3, k_hi=0.2)  # inverted on purpose
    out = run(cal=cal)
    assert (out["harmonized_lo"] <= out["harmonized"]).all()
    assert (out["harmonized"] <= out["harmonized_hi"]).all()


def test_zero_viirs_gives_zero_harmonized():
    cd = make_cell_days()
    m = pd.to_datetime(cd["month"])
    cd.loc[(m == "2021-03-01") & (cd["h3_r6"] == "86a8100c7ffffff"), "viirs"] = 0.0
    out = run(cd=cd)
    row = at(out, "2021-03")
    # Cell still has MODIS fire so the row is kept, with harmonized = 0.
    kept = row[row["h3_r6"] == "86a8100c7ffffff"]
    assert len(kept) == 1
    assert kept["harmonized"].iloc[0] == 0.0
    assert kept["harmonized_hi"].iloc[0] == 0.0


def test_rows_without_any_fire_are_dropped():
    cd = make_cell_days()
    m = pd.to_datetime(cd["month"])
    sel = (m == "2021-03-01") & (cd["h3_r6"] == "86a8100c7ffffff")
    cd.loc[sel, ["terra", "aqua", "modis", "viirs"]] = 0.0
    out = run(cd=cd)
    assert len(at(out, "2021-03")) == 1


def test_months_before_terra_start_dropped():
    out = run(cd=make_cell_days(start="2000-08"))
    assert out["month"].min() == pd.Timestamp("2000-11-01")


def test_terra_scaling_ratio():
    # Fit window has terra 5, aqua 3 -> ratio 8/5.
    out = run(cd=make_cell_days(terra=5.0, aqua=3.0))
    t = out.query("source == 'terra_scaled'")
    assert np.allclose(t["harmonized"], 5.0 * 8.0 / 5.0)
    assert np.allclose(t["harmonized_lo"], t["harmonized"])


def test_terra_ratio_by_calendar_month_and_fallback():
    cd = make_cell_days(terra=5.0, aqua=5.0)
    m = pd.to_datetime(cd["month"])
    cd.loc[m.dt.month == 8, "aqua"] = 15.0  # August ratio 20/5 = 4
    cd.loc[m.dt.month == 2, "terra"] = 0.0  # February thin -> region-wide ratio
    cd["modis"] = cd["terra"] + cd["aqua"]
    ratio = sp.fit_terra_ratio(cd).set_index("month_of_year")
    assert ratio.loc[8, "ratio"] == pytest.approx(4.0)
    assert not ratio.loc[8, "fallback"]
    assert ratio.loc[3, "ratio"] == pytest.approx(2.0)
    assert ratio.loc[2, "fallback"]
    win = (m >= "2002-07-01") & (m <= "2007-12-01")
    region_wide = (cd.loc[win, "terra"] + cd.loc[win, "aqua"]).sum() / cd.loc[win, "terra"].sum()
    assert ratio.loc[2, "ratio"] == pytest.approx(region_wide)


def test_terra_ratio_per_region():
    a = make_cell_days(regions=("pantanal",), terra=5.0, aqua=5.0)
    b = make_cell_days(regions=("punjab",), terra=5.0, aqua=10.0)
    ratio = sp.fit_terra_ratio(pd.concat([a, b])).set_index(["region", "month_of_year"])
    assert ratio.loc[("pantanal", 6), "ratio"] == pytest.approx(2.0)
    assert ratio.loc[("punjab", 6), "ratio"] == pytest.approx(3.0)


def test_switch_month_configurable():
    out = run(switch_month="2016-01")
    assert set(at(out, "2015-12")["source"]) == {"modis"}
    assert set(at(out, "2016-01")["source"]) == {"viirs_scaled"}
    assert common.SWITCH_MONTH == "2020-01"


def test_switch_before_viirs_rejected():
    with pytest.raises(ValueError):
        run(switch_month="2010-01")


def test_provisional_current_month():
    out = run(cd=make_cell_days(end="2025-11"), today=date(2025, 11, 15))
    assert at(out, "2025-11")["provisional"].all()
    assert not at(out, "2025-10")["provisional"].any()


def test_provisional_months_argument():
    out = run(provisional_months={("pantanal", "2024-08"), ("punjab", date(2024, 9, 1))})
    assert at(out, "2024-08")["provisional"].all()
    assert not at(out, "2024-09")["provisional"].any()
    assert out["provisional"].sum() == len(at(out, "2024-08"))


def test_provisional_from_product_column():
    cd = make_cell_days()
    cd["product"] = "SP"
    cd.loc[pd.to_datetime(cd["month"]) == "2025-12-01", "product"] = "NRT"
    out = run(cd=cd)
    assert at(out, "2025-12")["provisional"].all()
    assert out["provisional"].sum() == len(at(out, "2025-12"))


def test_provisional_from_manifest():
    manifest = {
        "entries": [
            {"product": "SP", "sensor": "VIIRS_NOAA20", "country": "Brazil",
             "first_date": "2018-04-01", "last_date": "2026-08-31"},
            {"product": "NRT", "sensor": "VIIRS_NOAA20", "country": "Brazil",
             "first_date": "2026-07-01", "last_date": "2026-10-20"},
        ]
    }  # fmt: skip
    got = sp.provisional_from_manifest(manifest)
    assert got == {
        ("pantanal", pd.Timestamp("2026-09-01")),
        ("pantanal", pd.Timestamp("2026-10-01")),
    }


def test_no_step_at_switch():
    # VIIRS = 4x MODIS everywhere and k = 0.25, so the spliced totals stay flat across 2020-01.
    out = run()
    tot = sp.region_totals(out, "pantanal")["harmonized"]
    before = tot["2019-01":"2019-12"].mean()
    after = tot["2020-01":"2020-12"].mean()
    assert after == pytest.approx(before)
    assert tot[pd.Timestamp("2019-12-01")] == pytest.approx(tot[pd.Timestamp("2020-01-01")])
    # Raw VIIRS shows a jump at 2012 that the harmonized line does not.
    raw = sp.region_totals(out, "pantanal")
    assert raw.loc["2012-01-01", "viirs_raw"] > 3 * raw.loc["2012-01-01", "harmonized"]
    assert raw.loc["2011-12-01", "harmonized"] == pytest.approx(raw.loc["2012-01-01", "harmonized"])


def test_missing_calibration_region_raises():
    with pytest.raises(ValueError):
        run(cal=make_calibration(regions=("punjab",)))


def test_write_and_seam_figure(tmp_path):
    out = run()
    path = tmp_path / "monthly.parquet"
    sp.write_monthly(out, path)
    back = pd.read_parquet(path)
    assert list(back.columns) == sp.OUT_COLUMNS
    assert len(back) == len(out)
    import pyarrow.parquet as pq

    schema = pq.read_schema(path)
    assert str(schema.field("month").type) == "date32[day]"
    assert str(schema.field("valid_days").type) == "int32"

    png = sp.plot_seam(out, "pantanal", tmp_path / "seam_pantanal.png")
    assert png.exists() and png.stat().st_size > 10_000
