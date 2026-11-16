import datetime as dt
import json

import duckdb
import h3
import pandas as pd
import pytest

import clean
import common

PUNJAB = (30.9, 75.0)  # lat, lon inside Indian Punjab
LAHORE = (31.55, 74.35)  # Pakistani Punjab, outside the region
KAMLOOPS = (50.67, -120.33)
PANTANAL = (-18.0, -57.0)


def det(
    lat_lon=PUNJAB,
    *,
    product="SP",
    sensor_dir="MODIS",
    satellite="Terra",
    acq_date="2020-06-01",
    acq_time="1030",
    confidence="50",
    fire_type="0",
    daynight="D",
    frp="12.5",
):
    """One raw FIRMS row as A1 would land it (all strings, like a CSV read)."""
    return {
        "latitude": str(lat_lon[0]),
        "longitude": str(lat_lon[1]),
        "acq_date": acq_date,
        "acq_time": str(acq_time),
        "satellite": satellite,
        "confidence": str(confidence),
        "type": fire_type,
        "daynight": daynight,
        "frp": frp,
        "product": product,
        "sensor_dir": sensor_dir,
    }


def run(rows, coverage=None):
    return clean.clean_frame(pd.DataFrame(rows), coverage=coverage)


def test_regions_geojson_matches_contract():
    fc = json.loads(common.REGIONS_GEOJSON.read_text())
    assert fc["type"] == "FeatureCollection"
    keys = {f["properties"]["region"] for f in fc["features"]}
    assert keys == set(common.REGIONS)
    for f in fc["features"]:
        assert f["properties"]["source"] and f["properties"]["license"]
    assert common.REGIONS_GEOJSON.stat().st_size < 1_000_000


def test_region_clipping():
    out = run(
        [
            det(PUNJAB),
            det(LAHORE),
            det(KAMLOOPS),
            det(PANTANAL),
            det((0.0, 0.0)),
        ]
    )
    assert sorted(out["region"]) == ["pantanal", "punjab", "w_canada"]
    assert out.loc[out["region"] == "punjab", "longitude"].item() == pytest.approx(PUNJAB[1])


def test_confidence_filter_and_normalization_modis():
    out = run([det(confidence=c, acq_time=f"10{i:02d}") for i, c in enumerate([0, 29, 30, 79, 80])])
    assert out["confidence_raw"].tolist() == ["30", "79", "80"]
    assert out["confidence"].tolist() == ["nominal", "nominal", "high"]


def test_confidence_filter_and_normalization_viirs():
    rows = [
        det(sensor_dir="VIIRS_NOAA20", satellite="N20", confidence=c, acq_time=f"10{i:02d}")
        for i, c in enumerate(["l", "n", "h"])
    ]
    out = run(rows)
    assert out["confidence_raw"].tolist() == ["n", "h"]
    assert out["confidence"].tolist() == ["nominal", "high"]
    assert set(out["sensor"]) == {"VIIRS_NOAA20"}


def test_local_solar_date_night_pass_east_of_greenwich():
    # Lon 75 E is UTC+5 h solar. 20:30 UTC on Nov 9 is 01:30 local on Nov 10.
    out = run([det(PUNJAB, acq_date="2024-11-09", acq_time="2030", daynight="N")])
    row = out.iloc[0]
    assert row["acq_datetime_utc"] == pd.Timestamp("2024-11-09 20:30")
    assert row["local_date"].date() == dt.date(2024, 11, 10)


def test_local_solar_date_west_of_greenwich():
    # Lon -120.33 is about UTC-8 h. 03:00 UTC on Aug 2 is the evening of Aug 1 locally.
    out = run([det(KAMLOOPS, acq_date="2024-08-02", acq_time="300")])
    assert out.iloc[0]["local_date"].date() == dt.date(2024, 8, 1)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("5", "00:05"), ("130", "01:30"), ("0130", "01:30"), (130, "01:30"), ("2359", "23:59")],
)
def test_acq_time_parsing(raw, expected):
    out = run([det(acq_time=raw)])
    assert out.iloc[0]["acq_datetime_utc"].strftime("%H:%M") == expected


def test_bad_acq_time_dropped():
    out = run([det(acq_time="2460"), det(acq_time=""), det(acq_time="1200")])
    assert len(out) == 1


def test_type_filter():
    rows = [det(fire_type=str(t), acq_time=f"10{t:02d}") for t in range(4)]
    rows.append(det(product="NRT", fire_type=None, acq_date="2026-10-01"))
    out = run(rows)
    assert len(out) == 2
    assert set(out["product"]) == {"SP", "NRT"}


def test_sensor_mapping():
    rows = [
        det(satellite="Terra", acq_time="1001"),
        det(satellite="A", acq_time="1002"),
        det(satellite="T", acq_time="1003"),
        det(sensor_dir="VIIRS_SNPP", satellite="N", confidence="n", acq_time="1004"),
        det(sensor_dir="VIIRS_NOAA21", satellite="N21", confidence="h", acq_time="1005"),
        det(sensor_dir="VIIRS_NOAA20", satellite="1", confidence="n", acq_time="1006"),
    ]
    out = run(rows).sort_values("acq_datetime_utc")
    assert out["sensor"].tolist() == [
        "MODIS_TERRA",
        "MODIS_AQUA",
        "MODIS_TERRA",
        "VIIRS_SNPP",
        "VIIRS_NOAA21",
        "VIIRS_NOAA20",
    ]


def test_sp_wins_over_nrt_same_sensor_and_date():
    rows = [
        det(product="SP", acq_date="2025-06-30", acq_time="1000"),
        # Same sensor and date in NRT (a slightly different position): dropped.
        det((30.95, 75.05), product="NRT", fire_type=None, acq_date="2025-06-30"),
        # NRT after the SP window: kept.
        det(product="NRT", fire_type=None, acq_date="2025-07-01"),
        # Same date but a sensor without SP coverage: kept.
        det(product="NRT", fire_type=None, satellite="Aqua", acq_date="2025-06-30"),
    ]
    out = run(rows)
    got = sorted(zip(out["sensor"], out["product"], out["acq_datetime_utc"].dt.date, strict=True))
    assert got == [
        ("MODIS_AQUA", "NRT", dt.date(2025, 6, 30)),
        ("MODIS_TERRA", "NRT", dt.date(2025, 7, 1)),
        ("MODIS_TERRA", "SP", dt.date(2025, 6, 30)),
    ]
    both = out.groupby(["region", "sensor", out["acq_datetime_utc"].dt.date])["product"].nunique()
    assert (both == 1).all()


def test_sp_coverage_from_manifest(tmp_path):
    manifest = {
        "generated_at": "2026-11-15T00:00:00Z",
        "entries": [
            {
                "product": "SP",
                "sensor": "MODIS",
                "country": "India",
                "first_date": "2000-11-01",
                "last_date": "2025-07-02",
                "rows": 1,
                "files": [],
            }
        ],
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    cov = clean.manifest_coverage(path)
    assert set(cov["sensor"]) == set(common.MODIS_SENSORS)
    rows = [
        det(product="SP", acq_date="2025-06-30"),
        det(product="NRT", fire_type=None, acq_date="2025-07-01"),
        det(product="NRT", fire_type=None, acq_date="2025-07-03"),
    ]
    out = run(rows, coverage=cov)
    assert sorted(out["acq_datetime_utc"].dt.date) == [dt.date(2025, 6, 30), dt.date(2025, 7, 3)]


def test_nrt_static_mask():
    static = (30.70, 76.70)  # e.g. an industrial site, flagged type 2 in SP
    normal = (30.40, 75.50)
    sp = [
        det(static, fire_type="2", acq_date=f"{y}-{m:02d}-15")
        for y in range(2012, 2019)
        for m in range(1, 13)
    ]
    # A cell burning every October for 7 years is seasonal, not static.
    sp += [det(normal, acq_date=f"{y}-10-15") for y in range(2012, 2019)]
    nrt = [
        det(static, product="NRT", fire_type=None, acq_date="2026-10-01"),
        det(normal, product="NRT", fire_type=None, acq_date="2026-10-01"),
    ]
    out = run(sp + nrt)
    assert static[0] not in set(out["latitude"].round(2))
    assert len(out[out["product"] == "NRT"]) == 1
    assert out.loc[out["product"] == "NRT", "latitude"].item() == pytest.approx(normal[0])
    assert len(out[out["product"] == "SP"]) == 7


def test_h3_columns_match_h3py():
    out = run([det(PUNJAB)])
    r8 = h3.latlng_to_cell(PUNJAB[0], PUNJAB[1], common.H3_FINE_RES)
    assert out.iloc[0]["h3_r8"] == r8
    assert out.iloc[0]["h3_r6"] == h3.cell_to_parent(r8, common.H3_STORE_RES)


def test_h3_udf_fallback_matches_extension():
    con = duckdb.connect()
    clean.register_h3_udfs(con)
    r8, r6 = con.execute(
        "SELECT h3_latlng_to_cell_string(30.9, 75.0, 8), "
        "h3_cell_to_parent(h3_latlng_to_cell_string(30.9, 75.0, 8), 6)"
    ).fetchone()
    assert r8 == h3.latlng_to_cell(30.9, 75.0, 8)
    assert r6 == h3.cell_to_parent(r8, 6)


def _write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(path, index=False)


@pytest.fixture
def raw_dir(tmp_path):
    raw = tmp_path / "raw"
    modis_cols = dict(brightness=320.1, scan=1.0, track=1.0, instrument="MODIS", version="6.1NRT")
    _write_csv(
        raw / "firms/SP/MODIS/India/modis_2024_India.csv",
        [
            dict(
                latitude=30.9,
                longitude=75.0,
                acq_date="2024-11-09",
                acq_time=2030,
                satellite="Aqua",
                confidence=85,
                bright_t31=290.0,
                frp=20.0,
                daynight="N",
                type=0,
                **modis_cols,
            ),
            dict(
                latitude=31.55,
                longitude=74.35,
                acq_date="2024-11-09",
                acq_time=530,
                satellite="Terra",
                confidence=90,
                bright_t31=290.0,
                frp=20.0,
                daynight="D",
                type=0,
                **modis_cols,
            ),
        ],
    )
    _write_csv(
        raw / "firms/NRT/VIIRS_NOAA20/Canada/viirs_nrt.csv",
        [
            dict(
                latitude=50.67,
                longitude=-120.33,
                bright_ti4=330.0,
                scan=0.4,
                track=0.4,
                acq_date="2026-08-02",
                acq_time=5,
                satellite="N20",
                instrument="VIIRS",
                confidence="h",
                version="2.0NRT",
                bright_ti5=295.0,
                frp=4.2,
                daynight="N",
            )
        ],
    )
    return raw


def test_end_to_end_files(raw_dir, tmp_path):
    raw = raw_dir
    con = clean.connect()
    clean.load_regions(con)
    assert clean.read_raw(con, raw) == 2
    clean.clean(con, "raw_in", clean.manifest_coverage(raw / "manifest.json")).to_table("final")
    counts = clean.log_counts(con.table("final"))
    assert counts["rows"].sum() == 2

    out = tmp_path / "processed" / clean.OUTPUT_NAME
    clean.write_output(con, "final", out)
    assert (out / "region=punjab").is_dir() and (out / "region=w_canada").is_dir()
    back = con.execute(
        f"SELECT * FROM read_parquet('{out}/**/*.parquet', hive_partitioning = true) "
        "ORDER BY region"
    ).df()
    assert set(back.columns) == set(clean.OUTPUT_COLUMNS)
    assert back["region"].tolist() == ["punjab", "w_canada"]
    assert back["sensor"].tolist() == ["MODIS_AQUA", "VIIRS_NOAA20"]
    assert back["local_date"].dt.date.tolist() == [dt.date(2024, 11, 10), dt.date(2026, 8, 1)]
    assert back["confidence_raw"].tolist() == ["85", "h"]
    desc = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}/**/*.parquet')").fetchall()
    types = {r[0]: r[1] for r in desc}
    assert types["acq_datetime_utc"] == "TIMESTAMP"
    assert types["local_date"] == "DATE"


def test_main_writes_partitioned_output(raw_dir, tmp_path, monkeypatch, caplog):
    out = tmp_path / "out" / clean.OUTPUT_NAME
    monkeypatch.setattr("sys.argv", ["clean.py", "--raw-dir", str(raw_dir), "--out", str(out)])
    with caplog.at_level("INFO", logger="clean"):
        clean.main()
    assert sorted(p.name for p in out.iterdir()) == ["region=punjab", "region=w_canada"]
    assert "MODIS_AQUA" in caplog.text and "VIIRS_NOAA20" in caplog.text
