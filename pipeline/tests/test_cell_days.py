import calendar
import datetime as dt

import duckdb
import h3
import pandas as pd
import pytest

import common
from cell_days import (
    COVERAGE_MONTH_COLUMNS,
    compute_cell_days,
    coverage_by_month,
    derive_coverage,
    ensure_h3,
    load_missing,
    records_from_manifest,
)

LAT, LON = -18.0, -57.0
CELL8 = h3.latlng_to_cell(LAT, LON, common.H3_FINE_RES)
CELL6 = h3.cell_to_parent(CELL8, common.H3_STORE_RES)
D1 = dt.date(2020, 8, 10)


def _point_in_other_r8(n: int = 1) -> tuple[float, float]:
    """Centroid of a res-8 cell n rings away from CELL8, inside the same res-6 parent."""
    for ring in range(n, 10):
        for c in h3.grid_ring(CELL8, ring):
            if h3.cell_to_parent(c, common.H3_STORE_RES) == CELL6:
                return h3.cell_to_latlng(c)
    raise AssertionError("no neighbour in same parent")


def hot(rows):
    """rows: (sensor, date, lat, lon[, daynight])."""
    recs = []
    for r in rows:
        sensor, date, lat, lon = r[:4]
        daynight = r[4] if len(r) > 4 else "D"
        c8 = h3.latlng_to_cell(lat, lon, common.H3_FINE_RES)
        recs.append(
            {
                "region": "pantanal",
                "sensor": sensor,
                "product": "SP",
                "local_date": date,
                "latitude": lat,
                "longitude": lon,
                "confidence": "nominal",
                "daynight": daynight,
                "h3_r8": c8,
                "h3_r6": h3.cell_to_parent(c8, common.H3_STORE_RES),
            }
        )
    return pd.DataFrame(recs)


def cov(day_sensors: dict[dt.date, list[str]], region: str = "pantanal") -> pd.DataFrame:
    """Coverage with every sensor listed, operating True only for the named ones."""
    rows = [
        {"region": region, "local_date": d, "sensor": s, "operating": s in ops}
        for d, ops in day_sensors.items()
        for s in common.SENSORS
    ]
    return pd.DataFrame(rows)


def one(df: pd.DataFrame) -> pd.Series:
    assert len(df) == 1
    return df.iloc[0]


def test_seven_viirs_points_in_one_cell_is_one_cell_day():
    lat, lon = h3.cell_to_latlng(CELL8)
    jitter = [(lat + i * 1e-5, lon + i * 1e-5) for i in range(7)]
    assert {h3.latlng_to_cell(a, b, common.H3_FINE_RES) for a, b in jitter} == {CELL8}
    df = hot([("VIIRS_SNPP", D1, a, b) for a, b in jitter])
    out = one(compute_cell_days(df, cov({D1: ["VIIRS_SNPP"]})))
    assert out["snpp"] == 1
    assert out["viirs"] == pytest.approx(1.0)


def test_snpp_and_noaa20_same_cell_gives_viirs_one():
    df = hot([("VIIRS_SNPP", D1, LAT, LON), ("VIIRS_NOAA20", D1, LAT, LON)])
    out = one(compute_cell_days(df, cov({D1: ["VIIRS_SNPP", "VIIRS_NOAA20"]})))
    assert out["snpp"] == 1 and out["noaa20"] == 1
    assert out["viirs"] == pytest.approx(1.0)


def test_noaa21_launch_does_not_raise_viirs():
    before, after = dt.date(2023, 1, 5), dt.date(2023, 2, 5)
    two = ["VIIRS_SNPP", "VIIRS_NOAA20"]
    three = two + ["VIIRS_NOAA21"]
    df = hot([(s, before, LAT, LON) for s in two] + [(s, after, LAT, LON) for s in three])
    out = compute_cell_days(df, cov({before: two, after: three}))
    assert list(out["viirs"]) == pytest.approx([1.0, 1.0])
    assert list(out["noaa21"]) == [0, 1]


def test_operating_satellite_without_fire_counts_as_zero():
    df = hot([("VIIRS_SNPP", D1, LAT, LON)])
    out = one(compute_cell_days(df, cov({D1: ["VIIRS_SNPP", "VIIRS_NOAA20"]})))
    assert out["viirs"] == pytest.approx(0.5)
    # Same detections, NOAA-20 down: it leaves the denominator.
    out = one(compute_cell_days(df, cov({D1: ["VIIRS_SNPP"]})))
    assert out["viirs"] == pytest.approx(1.0)


def test_terra_plus_aqua_sum():
    lat2, lon2 = _point_in_other_r8()
    df = hot(
        [
            ("MODIS_TERRA", D1, LAT, LON),
            ("MODIS_TERRA", D1, LAT, LON),  # duplicate pixel, same cell-day
            ("MODIS_AQUA", D1, LAT, LON),
            ("MODIS_AQUA", D1, lat2, lon2),
        ]
    )
    out = one(compute_cell_days(df, cov({D1: list(common.MODIS_SENSORS)})))
    assert out["terra"] == 1 and out["aqua"] == 2
    assert out["modis"] == 3
    assert out["viirs"] == 0


def test_month_rollup_sums_days_and_cells():
    lat2, lon2 = _point_in_other_r8()
    days = [dt.date(2020, 8, d) for d in (1, 2, 31)]
    rows = [("MODIS_TERRA", d, LAT, LON) for d in days]
    rows += [("MODIS_TERRA", days[0], lat2, lon2)]
    rows += [("MODIS_TERRA", dt.date(2020, 9, 1), LAT, LON)]
    df = hot(rows)
    coverage = cov({dt.date(2020, 8, d): ["MODIS_TERRA"] for d in range(1, 32)})
    coverage = pd.concat([coverage, cov({dt.date(2020, 9, 1): ["MODIS_TERRA"]})])
    out = compute_cell_days(df, coverage)
    assert list(out["month"]) == [dt.date(2020, 8, 1), dt.date(2020, 9, 1)]
    assert list(out["terra"]) == [4, 1]
    assert list(out["h3_r6"]) == [CELL6, CELL6]
    assert list(out["valid_days"]) == [31, 1]
    assert list(out["modis_valid_days"]) == [31, 1]
    assert list(out["viirs_valid_days"]) == [0, 0]


def test_day_night_split():
    df = hot([("MODIS_AQUA", D1, LAT, LON, "D"), ("MODIS_AQUA", D1, LAT, LON, "N")])
    out = one(compute_cell_days(df, cov({D1: ["MODIS_AQUA"]})))
    assert out["aqua"] == 1
    assert out["aqua_day"] == 1 and out["aqua_night"] == 1
    no_split = compute_cell_days(df, cov({D1: ["MODIS_AQUA"]}), day_night=False)
    assert "aqua_day" not in no_split.columns


def test_missing_h3_columns_are_computed():
    df = hot([("VIIRS_NOAA20", D1, LAT, LON)]).drop(columns=["h3_r8", "h3_r6"])
    filled = ensure_h3(df)
    assert filled.loc[0, "h3_r8"] == CELL8 and filled.loc[0, "h3_r6"] == CELL6
    out = one(compute_cell_days(df, cov({D1: ["VIIRS_NOAA20"]})))
    assert out["h3_r6"] == CELL6 and out["noaa20"] == 1


def test_derived_coverage_relative_rule():
    # S-NPP and NOAA-20 both active Aug 1-20; NOAA-20 silent Aug 8-14 while S-NPP sees fire
    # (outage). Aug 21-25 nobody sees fire (quiet, stays operating).
    days = [dt.date(2020, 8, d) for d in range(1, 21)]
    rows = [("VIIRS_SNPP", d, LAT, LON) for d in days]
    rows += [("VIIRS_NOAA20", d, LAT, LON) for d in days if not 8 <= d.day <= 14]
    rows += [("VIIRS_SNPP", dt.date(2020, 8, 26), LAT, LON)]
    rows += [("VIIRS_NOAA20", dt.date(2020, 8, 26), LAT, LON)]
    c = derive_coverage(hot(rows), gap_days=1)
    n20 = c[c.sensor == "VIIRS_NOAA20"].set_index("local_date")["operating"]
    assert not n20[dt.date(2020, 8, 10)]
    assert n20[dt.date(2020, 8, 8)]  # within gap of Aug 7 detection
    assert n20[dt.date(2020, 8, 23)]  # quiet day
    assert set(c.sensor) == {"VIIRS_SNPP", "VIIRS_NOAA20"}

    strict = derive_coverage(hot(rows), gap_days=1, rule="strict")
    s = strict[strict.sensor == "VIIRS_NOAA20"].set_index("local_date")["operating"]
    assert not s[dt.date(2020, 8, 23)]


def test_manifest_records_bound_coverage():
    manifest = {
        "entries": [
            {
                "product": "SP",
                "sensor": "MODIS",
                "country": "Brazil",
                "first_date": "2020-08-02",
                "last_date": "2020-08-05",
                "rows": 10,
                "files": [],
            },
            {
                "product": "NRT",
                "sensor": "MODIS",
                "country": "Brazil",
                "first_date": "2020-08-06",
                "last_date": "2020-08-09",
                "rows": 10,
                "files": [],
            },
            {
                "product": "SP",
                "sensor": "VIIRS_NOAA21",
                "country": "Canada",
                "first_date": "2024-01-01",
                "last_date": "2024-01-02",
                "rows": 1,
                "files": [],
            },
        ]
    }
    rec = records_from_manifest(manifest)
    terra = one(rec[(rec.region == "pantanal") & (rec.sensor == "MODIS_TERRA")])
    assert terra["first_date"] == dt.date(2020, 8, 1)
    assert terra["last_date"] == dt.date(2020, 8, 10)
    assert set(rec.sensor) == {"MODIS_TERRA", "MODIS_AQUA", "VIIRS_NOAA21"}

    df = hot([("MODIS_TERRA", dt.date(2020, 8, 5), LAT, LON)])
    c = derive_coverage(df, manifest=manifest)
    p = c[c.region == "pantanal"]
    assert p.local_date.min() == dt.date(2020, 8, 1)
    assert p.local_date.max() == dt.date(2020, 8, 10)
    aqua = p[p.sensor == "MODIS_AQUA"].set_index("local_date")["operating"]
    assert not aqua[dt.date(2020, 8, 5)]  # Terra saw fire, Aqua nothing within the gap
    assert aqua[dt.date(2020, 8, 10)]  # quiet day inside the record


def test_missing_list_marks_days_down(tmp_path):
    path = tmp_path / "missing.csv"
    path.write_text("satellite,date\nN20,2020-08-02\nunknown,2020-08-02\n")
    miss = load_missing(path)
    assert miss.to_dict("records") == [
        {"sensor": "VIIRS_NOAA20", "local_date": dt.date(2020, 8, 2)}
    ]
    days = [dt.date(2020, 8, d) for d in (1, 2, 3)]
    df = hot([(s, d, LAT, LON) for d in days for s in ("VIIRS_SNPP", "VIIRS_NOAA20")])
    c = derive_coverage(df, missing=miss)
    out = compute_cell_days(df, c)
    # Aug 2 NOAA-20 is excluded from numerator and denominator: still 1 per day.
    assert one(out)["viirs"] == pytest.approx(3.0)
    n20 = c[c.sensor == "VIIRS_NOAA20"].set_index("local_date")["operating"]
    assert not n20[dt.date(2020, 8, 2)]


def test_default_coverage_when_none():
    df = hot([("VIIRS_SNPP", D1, LAT, LON), ("VIIRS_NOAA20", D1, LAT, LON)])
    out = one(compute_cell_days(df))
    assert out["viirs"] == pytest.approx(1.0)
    assert out["valid_days"] == 1


def _month_days(year: int, month: int) -> list[dt.date]:
    n = calendar.monthrange(year, month)[1]
    return [dt.date(year, month, d) for d in range(1, n + 1)]


def test_coverage_month_keeps_zero_fire_month():
    # Fire only in September; August had sensors up and no fire.
    days = {d: ["MODIS_TERRA", "VIIRS_SNPP"] for d in _month_days(2020, 8)}
    days |= {d: ["MODIS_TERRA"] for d in _month_days(2020, 9)}
    coverage = cov(days)
    cells = compute_cell_days(hot([("MODIS_TERRA", dt.date(2020, 9, 3), LAT, LON)]), coverage)
    assert list(cells["month"]) == [dt.date(2020, 9, 1)]

    out = coverage_by_month(coverage, start="2020-08").set_index("month")
    aug = out.loc[dt.date(2020, 8, 1)]
    assert (aug["valid_days"], aug["modis_valid_days"], aug["viirs_valid_days"]) == (31, 31, 31)
    sep = out.loc[dt.date(2020, 9, 1)]
    assert (sep["valid_days"], sep["modis_valid_days"], sep["viirs_valid_days"]) == (30, 30, 0)
    # Same definition as the cell_days valid-day columns.
    assert cells.iloc[0]["valid_days"] == sep["valid_days"]


def test_coverage_month_no_operating_sensor_is_zero():
    # June has no coverage rows, July has rows with nothing operating, August is up.
    days = {d: [] for d in _month_days(2020, 7)}
    days |= {d: ["VIIRS_NOAA20"] for d in _month_days(2020, 8)}
    days |= {dt.date(2020, 9, 1): []}  # trailing month with nothing operating is not emitted
    out = coverage_by_month(cov(days), start="2020-06")
    assert list(out["month"]) == [dt.date(2020, m, 1) for m in (6, 7, 8)]
    assert list(out["valid_days"]) == [0, 0, 31]
    assert list(out["modis_valid_days"]) == [0, 0, 0]
    assert list(out["viirs_valid_days"]) == [0, 0, 31]


def test_coverage_month_default_start_and_regions():
    days = {dt.date(2000, 10, 31): ["MODIS_TERRA"], dt.date(2000, 11, 2): ["MODIS_TERRA"]}
    coverage = pd.concat([cov(days), cov({dt.date(2001, 1, 5): ["MODIS_TERRA"]}, region="punjab")])
    out = coverage_by_month(coverage)
    months = [dt.date(2000, 11, 1), dt.date(2000, 12, 1), dt.date(2001, 1, 1)]
    for region in ("pantanal", "punjab"):
        assert list(out.loc[out.region == region, "month"]) == months
    assert list(out.loc[out.region == "pantanal", "valid_days"]) == [1, 0, 0]
    assert list(out.loc[out.region == "punjab", "valid_days"]) == [0, 0, 1]


def test_coverage_month_dtypes(tmp_path):
    out = coverage_by_month(cov({D1: ["MODIS_AQUA"]}), start="2020-08")
    assert list(out.columns) == COVERAGE_MONTH_COLUMNS
    assert isinstance(out.iloc[0]["month"], dt.date)
    for c in ("valid_days", "modis_valid_days", "viirs_valid_days"):
        assert out[c].dtype == "int32"
    path = tmp_path / "coverage_month.parquet"
    out.to_parquet(path, index=False)
    types = {r[0]: r[1] for r in duckdb.sql(f"DESCRIBE SELECT * FROM '{path}'").fetchall()}
    assert types == {
        "region": "VARCHAR",
        "month": "DATE",
        "valid_days": "INTEGER",
        "modis_valid_days": "INTEGER",
        "viirs_valid_days": "INTEGER",
    }
