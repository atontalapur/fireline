import json
from datetime import date

import numpy as np
import pandas as pd
import pytest

import weather


class FakeResponse:
    def __init__(self, text, status=200):
        self.text = text
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise weather.requests.HTTPError(f"HTTP {self.status_code}")


class FakeSession:
    """Records calls; answers Open-Meteo style requests with synthetic daily data."""

    def __init__(self, status=200):
        self.calls = []
        self.status = status

    def get(self, url, params=None, auth=None, timeout=None):
        self.calls.append((url, params, auth))
        if self.status >= 400:
            return FakeResponse("error", self.status)
        days = pd.date_range(params["start_date"], params["end_date"], freq="D")
        daily = {"time": [d.strftime("%Y-%m-%d") for d in days]}
        for spec in weather.VARIABLES.values():
            daily[spec["open_meteo"]] = [float(d.month) for d in days]
        return FakeResponse(json.dumps({"daily": daily}))


def test_daily_to_monthly_mean_and_sum():
    days = pd.date_range("2020-02-01", "2020-02-29", freq="D")
    daily = pd.concat(
        [
            pd.DataFrame({"region": "r", "date": days, "variable": "t2m_mean", "value": 10.0}),
            pd.DataFrame({"region": "r", "date": days, "variable": "precip_total", "value": 2.0}),
        ]
    )
    m = weather.daily_to_monthly(daily).set_index("variable")["value"]
    assert m["t2m_mean"] == pytest.approx(10.0)
    assert m["precip_total"] == pytest.approx(58.0)  # 29 days x 2 mm


def test_daily_to_monthly_scales_precip_and_drops_sparse_months():
    days = pd.date_range("2021-01-01", "2021-01-31", freq="D")
    values = np.full(len(days), 1.0)
    values[:2] = np.nan  # 29/31 valid days, above the 90% threshold
    jan = pd.DataFrame({"region": "r", "date": days, "variable": "precip_total", "value": values})
    feb_days = pd.date_range("2021-02-01", "2021-02-10", freq="D")  # 10/28 days, dropped
    feb = pd.DataFrame({"region": "r", "date": feb_days, "variable": "precip_total", "value": 1.0})
    m = weather.daily_to_monthly(pd.concat([jan, feb]))
    assert len(m) == 1
    assert m["value"].iloc[0] == pytest.approx(31.0)


def test_add_anomalies_uses_baseline_climatology():
    months = pd.date_range("2001-07-01", "2024-07-01", freq="12MS")
    values = pd.Series(range(len(months)), dtype=float)
    monthly = pd.DataFrame(
        {"region": "r", "month": months, "variable": "t2m_mean", "value": values}
    )
    out = weather.add_anomalies(monthly, baseline_years=(2003, 2022))
    base = out[out["month"].dt.year.between(2003, 2022)]["value"]
    row = out[out["month"].dt.year == 2024].iloc[0]
    assert row["anomaly"] == pytest.approx(row["value"] - base.mean())
    assert row["anomaly_z"] == pytest.approx(row["anomaly"] / base.std())
    assert out[out["month"].dt.year.between(2003, 2022)]["anomaly"].mean() == pytest.approx(0)


def test_cache_hit_avoids_second_request(tmp_path):
    session = FakeSession()
    first = weather.fetch_open_meteo(
        "punjab", date(2020, 1, 1), date(2020, 3, 31), session, tmp_path
    )
    assert len(session.calls) == 1
    assert session.calls[0][1]["models"] == "era5"
    second = weather.fetch_open_meteo(
        "punjab", date(2020, 1, 1), date(2020, 3, 31), session, tmp_path
    )
    assert len(session.calls) == 1
    pd.testing.assert_frame_equal(first, second)
    assert list((tmp_path / "open_meteo").glob("*.json"))


def test_cached_get_retries_on_rate_limit(tmp_path):
    responses = [FakeResponse("slow down", 429), FakeResponse("ok")]

    class RSession:
        calls = 0

        def get(self, url, params=None, auth=None, timeout=None):
            self.calls += 1
            return responses.pop(0)

    s = RSession()
    waits = []
    text = weather.cached_get(s, "https://x.test", tmp_path / "a.txt", sleep=waits.append)
    assert text == "ok"
    assert s.calls == 2
    assert waits == [weather.RETRY_WAIT_S]


def test_chunks_split_long_ranges():
    chunks = weather.date_chunks(date(2000, 1, 1), date(2026, 10, 31))
    assert chunks[0] == (date(2000, 1, 1), date(2004, 12, 31))
    assert chunks[-1] == (date(2025, 1, 1), date(2026, 10, 31))
    assert len(chunks) == 6


def test_auto_picks_fallback_without_credentials(tmp_path):
    def era5_unavailable(end):
        return False, "era5-pds ends 2020-12-31"

    order = weather.choose_backends(
        "auto", date(2026, 10, 31), env={}, era5_status=era5_unavailable
    )
    assert [b for b, _ in order] == ["open_meteo"]

    session = FakeSession()
    df, backend = weather.run(
        "auto",
        ["pantanal"],
        date(2019, 1, 1),
        date(2020, 12, 31),
        session,
        cache_dir=tmp_path,
        env={},
        era5_status=era5_unavailable,
    )
    assert backend == "open_meteo"
    assert all(auth is None for _, _, auth in session.calls)
    assert set(df["source"]) == {weather.SOURCES["open_meteo"]["source"]}
    assert df["license"].str.contains("CC BY 4.0").all()
    assert list(df.columns) == [
        "region",
        "month",
        "variable",
        "value",
        "anomaly",
        "anomaly_z",
        "unit",
        "source",
        "license",
    ]
    assert len(df) == 24 * len(weather.VARIABLES)
    assert isinstance(df["month"].iloc[0], date)


def test_auto_tries_meteomatics_first_and_falls_back(tmp_path):
    def failing_meteomatics(region, start, end, session, cache_dir):
        raise weather.requests.HTTPError("403 history not available")

    fetchers = dict(weather.FETCHERS, meteomatics=failing_meteomatics)
    env = {"METEOMATICS_USERNAME": "u", "METEOMATICS_PASSWORD": "p"}
    order = weather.choose_backends(
        "auto", date(2020, 12, 31), env=env, era5_status=lambda end: (False, "x")
    )
    assert [b for b, _ in order] == ["meteomatics", "open_meteo"]
    df, backend = weather.run(
        "auto",
        ["punjab"],
        date(2020, 1, 1),
        date(2020, 12, 31),
        FakeSession(),
        cache_dir=tmp_path,
        env=env,
        era5_status=lambda end: (False, "x"),
        fetchers=fetchers,
    )
    assert backend == "open_meteo"


def test_parse_meteomatics_shifts_right_aligned_days():
    params = [spec["meteomatics"] for spec in weather.VARIABLES.values()]
    text = "validdate;" + ";".join(params) + "\n"
    text += "2020-08-02T00:00:00Z;30.5;20;3.1;0\n2020-08-03T00:00:00Z;31.0;-999;2.9;1.2\n"
    df = weather.parse_meteomatics_csv(text)
    t = df[df["variable"] == "t2m_mean"]
    assert list(t["date"]) == [pd.Timestamp("2020-08-01"), pd.Timestamp("2020-08-02")]
    rh = df[df["variable"] == "rh2m_mean"]["value"]
    assert np.isnan(rh.iloc[1])


def test_meteomatics_uses_basic_auth_and_cache(tmp_path):
    names = [spec["meteomatics"] for spec in weather.VARIABLES.values()]

    class MSession:
        calls = []

        def get(self, url, params=None, auth=None, timeout=None):
            self.calls.append((url, auth))
            body = "validdate;" + ";".join(names) + "\n2020-01-02T00:00:00Z;1;2;3;4\n"
            return FakeResponse(body)

    s = MSession()
    auth = ("u", "p")
    weather.fetch_meteomatics("pantanal", date(2020, 1, 1), date(2020, 1, 1), s, tmp_path, auth)
    weather.fetch_meteomatics("pantanal", date(2020, 1, 1), date(2020, 1, 1), s, tmp_path, auth)
    assert len(s.calls) == 1
    url, used_auth = s.calls[0]
    assert used_auth == auth
    assert "2020-01-02T00:00:00Z--2020-01-02T00:00:00Z:P1D/t_mean_2m_24h:C," in url
    assert url.endswith("/-18.8,-57.0/csv")


def test_hourly_to_daily_era5():
    times = pd.date_range("2020-08-01", periods=24, freq="h")
    hourly = pd.DataFrame(
        {"time": times, "t2m_k": 303.15, "d2m_k": 303.15, "u10": 3.0, "v10": 4.0, "tp_m": 0.001}
    )
    d = weather.hourly_to_daily(hourly).set_index("variable")["value"]
    assert d["t2m_mean"] == pytest.approx(30.0)
    assert d["rh2m_mean"] == pytest.approx(100.0)
    assert d["wind10m_mean"] == pytest.approx(5.0)
    assert d["precip_total"] == pytest.approx(24.0)


def test_last_complete_month():
    assert weather.last_complete_month(date(2026, 11, 15)) == pd.Timestamp("2026-10-01")
    assert weather.last_complete_month(date(2026, 11, 3)) == pd.Timestamp("2026-09-01")
