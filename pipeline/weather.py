"""A10: monthly weather context per region (temperature, humidity, wind, precipitation).

Backends:
  meteomatics  Meteomatics Weather API, daily 24h parameters at the region point.
               Needs METEOMATICS_USERNAME / METEOMATICS_PASSWORD (HTTP basic auth).
  era5_pc      ERA5 on Microsoft Planetary Computer (`era5-pds`). The collection ends 2020-12
               and reading it needs `zarr` and `adlfs`, which are not pipeline dependencies.
  open_meteo   Open-Meteo Historical Weather API with `models=era5`, no key, CC BY 4.0.
  auto         First backend above that works for the requested range.

Values are taken at the centroid of each region bbox (common.REGIONS), aggregated from daily to
monthly (means for temperature, humidity and wind, totals for precipitation), and compared with
the common.BASELINE_YEARS climatology for the same calendar month.

Every HTTP response is cached under RAW_DIR/weather/<backend>/, so reruns cost no queries.
Output: PROCESSED_DIR/weather.parquet (published to public/v1/ by export.py) with columns
  region, month (DATE), variable, value, anomaly, anomaly_z, unit, source, license.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import time
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import numpy as np
import pandas as pd
import requests

import common

START_MONTH = "2000-01"
CHUNK_YEARS = 5  # one request per region per 5-year chunk
MIN_DAY_FRACTION = 0.9  # months with fewer valid days than this are dropped
DATA_LAG_DAYS = 6  # ERA5 on Open-Meteo is published about 5 days late
TIMEOUT_S = 120
MAX_RETRIES = 5  # retries on HTTP 429 (Open-Meteo allows 600 weighted calls per minute)
RETRY_WAIT_S = 65

# Output variable -> unit, monthly aggregation, and the name used by each backend.
VARIABLES: dict[str, dict] = {
    "t2m_mean": {
        "unit": "degC",
        "agg": "mean",
        "meteomatics": "t_mean_2m_24h:C",
        "open_meteo": "temperature_2m_mean",
    },
    "rh2m_mean": {
        "unit": "%",
        "agg": "mean",
        "meteomatics": "relative_humidity_mean_2m_24h:p",
        "open_meteo": "relative_humidity_2m_mean",
    },
    "wind10m_mean": {
        "unit": "m/s",
        "agg": "mean",
        "meteomatics": "wind_speed_mean_10m_24h:ms",
        "open_meteo": "wind_speed_10m_mean",
    },
    "precip_total": {
        "unit": "mm",
        "agg": "sum",
        "meteomatics": "precip_24h:mm",
        "open_meteo": "precipitation_sum",
    },
}

SOURCES: dict[str, dict] = {
    "meteomatics": {
        "source": "Meteomatics Weather API",
        "license": "Meteomatics terms of use (NASA Space Apps 2026 Global Offer account)",
    },
    "era5_pc": {
        "source": "ERA5 hourly (ECMWF/C3S) via Microsoft Planetary Computer era5-pds",
        "license": "CC BY 4.0, contains modified Copernicus Climate Change Service information",
    },
    "open_meteo": {
        "source": "Open-Meteo Historical Weather API (ERA5, ECMWF/C3S)",
        "license": "CC BY 4.0 (Open-Meteo, open-meteo.com); ERA5 contains modified Copernicus "
        "Climate Change Service information",
    },
}
BACKENDS = ("meteomatics", "era5_pc", "open_meteo")

METEOMATICS_URL = "https://api.meteomatics.com"
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
PC_STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

CACHE_DIR = common.RAW_DIR / "weather"


# ---------------------------------------------------------------- helpers


def region_point(region: str) -> tuple[float, float]:
    """(lat, lon) of the bbox centroid, rounded to 0.01 degrees."""
    west, south, east, north = common.REGIONS[region]["bbox"]
    return round((south + north) / 2, 2), round((west + east) / 2, 2)


def last_complete_month(today: date | None = None, lag_days: int = DATA_LAG_DAYS) -> pd.Timestamp:
    """First day of the last calendar month fully covered by data published `lag_days` late."""
    available = (today or date.today()) - timedelta(days=lag_days)
    first_of_month = pd.Timestamp(available.year, available.month, 1)
    return first_of_month - pd.DateOffset(months=1)


def date_chunks(start: date, end: date, years: int = CHUNK_YEARS) -> list[tuple[date, date]]:
    """Split [start, end] into chunks aligned to `years`-year blocks (2000-2004, 2005-2009, ...)."""
    out = []
    cur = start
    while cur <= end:
        block_end_year = cur.year - (cur.year % years) + years - 1
        chunk_end = min(date(block_end_year, 12, 31), end)
        out.append((cur, chunk_end))
        cur = chunk_end + timedelta(days=1)
    return out


def cached_get(
    session,
    url: str,
    cache_path: Path,
    params: dict | None = None,
    auth: tuple[str, str] | None = None,
    sleep=time.sleep,
) -> str:
    """GET `url` and return the body text, reading from / writing to `cache_path`.

    Waits and retries on HTTP 429 (rate limit), honouring Retry-After when given.
    """
    if cache_path.exists():
        return cache_path.read_text()
    for attempt in range(MAX_RETRIES + 1):
        resp = session.get(url, params=params, auth=auth, timeout=TIMEOUT_S)
        if resp.status_code != 429 or attempt == MAX_RETRIES:
            break
        wait = float(getattr(resp, "headers", {}).get("Retry-After") or RETRY_WAIT_S)
        print(f"weather: rate limited, waiting {wait:.0f}s")
        sleep(wait)
    resp.raise_for_status()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache_path.with_suffix(cache_path.suffix + ".part")
    tmp.write_text(resp.text)
    tmp.replace(cache_path)
    return resp.text


def _cache_name(region: str, start: date, end: date, key: str, ext: str) -> str:
    digest = hashlib.sha1(key.encode()).hexdigest()[:8]
    return f"{region}_{start:%Y%m%d}_{end:%Y%m%d}_{digest}.{ext}"


# ---------------------------------------------------------------- backends (daily data)
# Each fetcher returns a long frame: region, date (datetime64), variable, value.


def parse_open_meteo(text: str) -> pd.DataFrame:
    daily = json.loads(text)["daily"]
    wide = pd.DataFrame(daily)
    wide["date"] = pd.to_datetime(wide.pop("time"))
    rename = {spec["open_meteo"]: var for var, spec in VARIABLES.items()}
    wide = wide.rename(columns=rename)[["date", *VARIABLES]]
    return wide.melt(id_vars="date", var_name="variable", value_name="value")


def fetch_open_meteo(
    region: str, start: date, end: date, session, cache_dir: Path = CACHE_DIR
) -> pd.DataFrame:
    lat, lon = region_point(region)
    frames = []
    for c_start, c_end in date_chunks(start, end):
        params = {
            "latitude": lat,
            "longitude": lon,
            "start_date": c_start.isoformat(),
            "end_date": c_end.isoformat(),
            "daily": ",".join(spec["open_meteo"] for spec in VARIABLES.values()),
            "models": "era5",
            "timezone": "GMT",
            "wind_speed_unit": "ms",
            "temperature_unit": "celsius",
            "precipitation_unit": "mm",
        }
        key = json.dumps(params, sort_keys=True)
        path = cache_dir / "open_meteo" / _cache_name(region, c_start, c_end, key, "json")
        frames.append(parse_open_meteo(cached_get(session, OPEN_METEO_URL, path, params=params)))
    out = pd.concat(frames, ignore_index=True)
    out.insert(0, "region", region)
    return out


def parse_meteomatics_csv(text: str) -> pd.DataFrame:
    """Parse a Meteomatics point time-series CSV (`validdate;param;...`).

    24h parameters are right-aligned: the value stamped D+1 00:00Z covers day D, so dates are
    shifted back one day.
    """
    wide = pd.read_csv(StringIO(text), sep=";")
    wide["date"] = pd.to_datetime(wide.pop("validdate"), utc=True).dt.tz_localize(None)
    wide["date"] = wide["date"].dt.normalize() - pd.Timedelta(days=1)
    rename = {spec["meteomatics"]: var for var, spec in VARIABLES.items()}
    wide = wide.rename(columns=rename)[["date", *VARIABLES]]
    out = wide.melt(id_vars="date", var_name="variable", value_name="value")
    out["value"] = pd.to_numeric(out["value"], errors="coerce")
    out.loc[out["value"] <= -666, "value"] = np.nan  # -666/-999 are Meteomatics no-data codes
    return out


def meteomatics_auth(env: dict | None = None) -> tuple[str, str] | None:
    env = os.environ if env is None else env
    user = env.get("METEOMATICS_USERNAME", "")
    password = env.get("METEOMATICS_PASSWORD", "")
    return (user, password) if user and password else None


def fetch_meteomatics(
    region: str,
    start: date,
    end: date,
    session,
    cache_dir: Path = CACHE_DIR,
    auth: tuple[str, str] | None = None,
) -> pd.DataFrame:
    auth = auth or meteomatics_auth()
    if auth is None:
        raise RuntimeError("METEOMATICS_USERNAME / METEOMATICS_PASSWORD are not set")
    lat, lon = region_point(region)
    params = ",".join(spec["meteomatics"] for spec in VARIABLES.values())
    frames = []
    for c_start, c_end in date_chunks(start, end):
        t0 = (c_start + timedelta(days=1)).isoformat()
        t1 = (c_end + timedelta(days=1)).isoformat()
        # Time range syntax: <start>--<end>:<step>; one query per request.
        url = f"{METEOMATICS_URL}/{t0}T00:00:00Z--{t1}T00:00:00Z:P1D/{params}/{lat},{lon}/csv"
        path = cache_dir / "meteomatics" / _cache_name(region, c_start, c_end, url, "csv")
        frames.append(parse_meteomatics_csv(cached_get(session, url, path, auth=auth)))
    out = pd.concat(frames, ignore_index=True)
    out.insert(0, "region", region)
    return out


def hourly_to_daily(hourly: pd.DataFrame) -> pd.DataFrame:
    """ERA5 hourly point values -> daily long frame.

    Input columns: time, t2m_k, d2m_k, u10, v10, tp_m (precipitation in metres per hour).
    Relative humidity from temperature and dew point with the Magnus formula (over water).
    """
    h = hourly.copy()
    t_c = h["t2m_k"] - 273.15
    td_c = h["d2m_k"] - 273.15
    a, b = 17.625, 243.04
    h["t2m_mean"] = t_c
    h["rh2m_mean"] = (100 * np.exp(a * td_c / (b + td_c)) / np.exp(a * t_c / (b + t_c))).clip(
        upper=100
    )
    h["wind10m_mean"] = np.hypot(h["u10"], h["v10"])
    h["precip_total"] = h["tp_m"] * 1000
    h["date"] = pd.to_datetime(h["time"]).dt.normalize()
    aggs = {var: spec["agg"] for var, spec in VARIABLES.items()}
    daily = h.groupby("date").agg(aggs).reset_index()
    return daily.melt(id_vars="date", var_name="variable", value_name="value")


ERA5_PC_ASSETS = {
    "t2m_k": "air_temperature_at_2_metres",
    "d2m_k": "dew_point_temperature_at_2_metres",
    "u10": "eastward_wind_at_10_metres",
    "v10": "northward_wind_at_10_metres",
    "tp_m": "precipitation_amount_1hour_Accumulation",
}


def era5_pc_status(end: date, client=None) -> tuple[bool, str]:
    """Whether era5_pc can serve data through `end`. Returns (ok, reason)."""
    missing = [m for m in ("zarr", "adlfs") if importlib.util.find_spec(m) is None]
    if missing:
        return False, f"era5_pc needs {', '.join(missing)} (not in pyproject)"
    if client is None:
        import planetary_computer
        import pystac_client

        client = pystac_client.Client.open(PC_STAC_URL, modifier=planetary_computer.sign_inplace)
    latest = next(client.search(collections=["era5-pds"], sortby="-datetime", max_items=1).items())
    last = pd.Timestamp(latest.properties["end_datetime"]).date()
    if last < end:
        return False, f"era5-pds ends {last.isoformat()}, before {end.isoformat()}"
    return True, f"era5-pds covers through {last.isoformat()}"


def fetch_era5_pc(
    region: str, start: date, end: date, session=None, cache_dir: Path = CACHE_DIR
) -> pd.DataFrame:
    """Read hourly ERA5 at the region point, one STAC item pair (an/fc) per month.

    Slow (about 5 zarr opens per month) and limited to 1979-2020; kept for completeness.
    """
    import planetary_computer
    import pystac_client
    import xarray as xr

    lat, lon = region_point(region)
    client = pystac_client.Client.open(PC_STAC_URL, modifier=planetary_computer.sign_inplace)
    frames = []
    for month in pd.date_range(start, end, freq="MS"):
        path = cache_dir / "era5_pc" / f"{region}_{month:%Y%m}.json"
        if path.exists():
            frames.append(pd.read_json(StringIO(path.read_text()), orient="records"))
            continue
        items = client.search(collections=["era5-pds"], datetime=f"{month:%Y-%m}").item_collection()
        assets = {k: v for item in items for k, v in item.assets.items()}
        cols = {}
        for col, name in ERA5_PC_ASSETS.items():
            asset = assets[name]
            ds = xr.open_dataset(asset.href, **asset.extra_fields["xarray:open_kwargs"])
            da = ds[name].sel(lat=lat, lon=lon % 360, method="nearest")
            if "time1" in da.dims:
                da = da.rename(time1="time")
            cols[col] = da.to_series()
        hourly = pd.DataFrame(cols).reset_index().rename(columns={"index": "time"})
        daily = hourly_to_daily(hourly)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(daily.to_json(orient="records", date_format="iso"))
        frames.append(daily)
    out = pd.concat(frames, ignore_index=True)
    out["date"] = pd.to_datetime(out["date"]).dt.tz_localize(None)
    out.insert(0, "region", region)
    return out


FETCHERS = {
    "meteomatics": fetch_meteomatics,
    "era5_pc": fetch_era5_pc,
    "open_meteo": fetch_open_meteo,
}


# ---------------------------------------------------------------- aggregation


def daily_to_monthly(daily: pd.DataFrame, min_fraction: float = MIN_DAY_FRACTION) -> pd.DataFrame:
    """Daily long frame (region, date, variable, value) -> monthly (region, month, variable, value).

    Mean variables use the mean of valid days. Precipitation is the sum over valid days, scaled
    to the full month when a few days are missing. Months below `min_fraction` valid days drop.
    """
    d = daily.dropna(subset=["value"]).copy()
    d["month"] = pd.to_datetime(d["date"]).dt.to_period("M").dt.to_timestamp()
    g = d.groupby(["region", "month", "variable"])["value"]
    m = g.agg(mean="mean", total="sum", n="count").reset_index()
    m["days_in_month"] = m["month"].dt.days_in_month
    m = m[m["n"] >= min_fraction * m["days_in_month"]].copy()
    is_sum = m["variable"].map(lambda v: VARIABLES[v]["agg"] == "sum")
    m["value"] = np.where(is_sum, m["total"] * m["days_in_month"] / m["n"], m["mean"])
    return m[["region", "month", "variable", "value"]].reset_index(drop=True)


def add_anomalies(
    monthly: pd.DataFrame, baseline_years: tuple[int, int] = common.BASELINE_YEARS
) -> pd.DataFrame:
    """Add anomaly (value - baseline mean) and anomaly_z (anomaly / baseline std) per
    region, variable and calendar month. Baseline years are inclusive."""
    out = monthly.copy()
    out["moy"] = out["month"].dt.month
    y0, y1 = baseline_years
    base = out[out["month"].dt.year.between(y0, y1)]
    clim = (
        base.groupby(["region", "variable", "moy"])["value"]
        .agg(clim_mean="mean", clim_std="std")
        .reset_index()
    )
    out = out.merge(clim, on=["region", "variable", "moy"], how="left")
    out["anomaly"] = out["value"] - out["clim_mean"]
    std = out["clim_std"].where(out["clim_std"] > 0)
    out["anomaly_z"] = out["anomaly"] / std
    return out.drop(columns=["moy", "clim_mean", "clim_std"])


# ---------------------------------------------------------------- backend selection


def choose_backends(source: str, end: date, env: dict | None = None, era5_status=None) -> list:
    """Ordered backends to try. `auto` skips meteomatics without credentials and era5_pc when it
    cannot cover `end`. Returns [(backend, reason), ...]."""
    if source != "auto":
        return [(source, "requested")]
    order = []
    if meteomatics_auth(env) is not None:
        order.append(("meteomatics", "credentials found"))
    try:
        ok, reason = (era5_status or era5_pc_status)(end)
    except Exception as exc:  # network or catalog error: skip, don't fail the run
        ok, reason = False, f"era5_pc probe failed: {exc}"
    if ok:
        order.append(("era5_pc", reason))
    else:
        print(f"weather: skipping era5_pc ({reason})")
    order.append(("open_meteo", "no-key fallback"))
    return order


def build_weather(
    backend: str,
    regions: list[str],
    start: date,
    end: date,
    session,
    cache_dir: Path = CACHE_DIR,
    fetchers: dict | None = None,
) -> pd.DataFrame:
    fetch = (fetchers or FETCHERS)[backend]
    daily = pd.concat(
        [fetch(r, start, end, session, cache_dir=cache_dir) for r in regions], ignore_index=True
    )
    daily = daily[(daily["date"] >= pd.Timestamp(start)) & (daily["date"] <= pd.Timestamp(end))]
    monthly = daily_to_monthly(daily)
    first = monthly.groupby("region")["month"].min()
    late = first[first > pd.Timestamp(start) + pd.DateOffset(months=12)]
    if monthly.empty or not late.empty:
        raise ValueError(f"{backend} history too short: first months {late.to_dict()}")
    monthly = add_anomalies(monthly)
    monthly["unit"] = monthly["variable"].map(lambda v: VARIABLES[v]["unit"])
    monthly["source"] = SOURCES[backend]["source"]
    monthly["license"] = SOURCES[backend]["license"]
    monthly["month"] = monthly["month"].dt.date
    cols = ["region", "month", "variable", "value", "anomaly", "anomaly_z", "unit"]
    cols += ["source", "license"]
    return monthly[cols].sort_values(["region", "variable", "month"]).reset_index(drop=True)


def run(
    source: str,
    regions: list[str],
    start: date,
    end: date,
    session,
    cache_dir: Path = CACHE_DIR,
    env: dict | None = None,
    era5_status=None,
    fetchers: dict | None = None,
) -> tuple[pd.DataFrame, str]:
    """Try backends in order, return (frame, backend used)."""
    errors = []
    for backend, reason in choose_backends(source, end, env=env, era5_status=era5_status):
        print(f"weather: trying {backend} ({reason})")
        try:
            df = build_weather(backend, regions, start, end, session, cache_dir, fetchers)
            return df, backend
        except Exception as exc:
            if source != "auto":
                raise
            errors.append(f"{backend}: {exc}")
            print(f"weather: {backend} failed: {exc}")
    raise RuntimeError("all weather backends failed: " + "; ".join(errors))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", choices=["auto", *BACKENDS], default="auto")
    p.add_argument("--regions", nargs="+", default=list(common.REGIONS), choices=common.REGIONS)
    p.add_argument("--start", default=START_MONTH, help="first month, YYYY-MM")
    p.add_argument("--end", default=None, help="last month, YYYY-MM (default: last complete)")
    p.add_argument("--out", type=Path, default=common.PROCESSED_DIR / "weather.parquet")
    p.add_argument("--upload", action="store_true", help="upload to gs://$DATA_BUCKET/public/v1/")
    args = p.parse_args()

    start = pd.Timestamp(args.start).date()
    end_month = pd.Timestamp(args.end) if args.end else last_complete_month()
    end = (end_month + pd.offsets.MonthEnd(0)).date()

    common.ensure_dirs()
    with requests.Session() as session:
        df, backend = run(args.source, args.regions, start, end, session)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.out, index=False)
    print(
        f"weather: {len(df)} rows, {df['month'].min()}..{df['month'].max()}, "
        f"backend={backend}, license={SOURCES[backend]['license']} -> {args.out}"
    )
    if args.upload:
        uri = common.upload_to_gcs(args.out, "public/v1/weather.parquet")
        print(f"weather: uploaded {uri}")


if __name__ == "__main__":
    main()
