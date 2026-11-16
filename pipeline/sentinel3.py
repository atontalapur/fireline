"""A11: independent check of the harmonized series against ESA Sentinel-3 SLSTR FRP.

Source: Planetary Computer STAC collection `sentinel-3-slstr-frp-l2-netcdf` (from 2020-08-08).
Each item is one ~3 minute SLSTR granule; the `frp-in` asset holds the fire table
(dimension `fires`: latitude, longitude, time, FRP_MWIR, confidence, classification).

Steps:
1. List granules over the region bbox (cached at RAW_DIR/sentinel3/items_{region}.parquet).
2. Sample whole local solar days (every `--day-step`th day) so the cell-day unit stays exact
   on the days we read. Download `frp-in` for those granules with a small thread pool and
   cache the in-bbox fires per granule at RAW_DIR/sentinel3/granules/{id}.parquet.
3. Keep vegetation fires, clip to the region polygon (regions.geojson, else bbox), drop
   duplicates from overlapping frames, then count monthly detections and unique H3 res-8
   cell-days per satellite (S3A + S3B summed, like Terra + Aqua). Monthly values are scaled by
   days_with_data / sampled_days.
4. Compare with the harmonized monthly totals: Spearman r and peak-month agreement per year.

Reading the HDF5-based NetCDF with the h5netcdf engine needs h5py (a pipeline dependency).
"""

from __future__ import annotations

import argparse
import calendar
import io
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

import h3
import numpy as np
import pandas as pd

import common

log = logging.getLogger("sentinel3")

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION = "sentinel-3-slstr-frp-l2-netcdf"
ASSET = "frp-in"
DATA_START = "2020-08-01"
VEGETATION_FIRE = 1  # bit in `classification` (flag_meanings: vegetation_fire ...)
DEFAULT_DAY_STEP = 2
DEFAULT_WORKERS = 8
MIN_DAY_COVERAGE = 0.8  # month must have data on >= 80% of its days to enter the comparison
MIN_YEAR_MONTHS = 6  # a year needs this many compared months for a peak-month check

FIRE_COLUMNS = ["latitude", "longitude", "time", "frp", "confidence", "classification", "processor"]
ITEM_COLUMNS = ["id", "datetime", "platform", "orbit_state", "absolute_orbit", "href"]

S3_DIR = common.RAW_DIR / "sentinel3"
GRANULE_DIR = S3_DIR / "granules"


# --------------------------------------------------------------------------- granules


def search_items(bbox: tuple, start: str, end: str) -> pd.DataFrame:
    """List FRP granules intersecting bbox. Hrefs are stored unsigned."""
    import pystac_client

    client = pystac_client.Client.open(STAC_URL)
    search = client.search(
        collections=[COLLECTION], bbox=list(bbox), datetime=f"{start}/{end}", limit=1000
    )
    rows = []
    for d in search.items_as_dicts():
        p = d["properties"]
        rows.append(
            {
                "id": d["id"],
                "datetime": pd.Timestamp(p["datetime"]),
                "platform": p.get("platform"),
                "orbit_state": p.get("sat:orbit_state"),
                "absolute_orbit": p.get("sat:absolute_orbit"),
                "href": d["assets"][ASSET]["href"],
            }
        )
    items = pd.DataFrame(rows, columns=ITEM_COLUMNS)
    items["datetime"] = pd.to_datetime(items["datetime"], utc=True).dt.tz_localize(None)
    return items.sort_values("datetime").reset_index(drop=True)


def local_solar_date(utc: pd.Series, lon) -> pd.Series:
    """Local solar date = UTC + lon/15 h (same rule as clean.py)."""
    offset = pd.to_timedelta(np.asarray(lon, dtype=float) / 15.0, unit="h")
    return (pd.to_datetime(utc) + offset).dt.floor("D")


def select_granules(items: pd.DataFrame, bbox: tuple, day_step: int) -> pd.DataFrame:
    """Add `local_date`, `month` and `sampled` (every day_step-th local solar day)."""
    out = items.copy()
    center_lon = (bbox[0] + bbox[2]) / 2.0
    out["local_date"] = local_solar_date(out["datetime"], np.full(len(out), center_lon))
    out["month"] = out["local_date"].dt.to_period("M").dt.to_timestamp()
    ordinal = out["local_date"].map(lambda d: d.toordinal())
    out["sampled"] = (ordinal % max(day_step, 1)) == 0
    return out


def parse_granule(ds, bbox: tuple) -> pd.DataFrame:
    """Fire table of one `frp-in` dataset, restricted to bbox."""
    if "fires" not in ds.sizes or ds.sizes["fires"] == 0:
        return pd.DataFrame(columns=FIRE_COLUMNS)
    n_fires = ds.sizes["fires"]

    def _opt(name, default):
        # `confidence` exists in IPF-SL-2-FRP 01.04 but not in 01.09; keep the schema stable.
        return ds[name].values if name in ds else np.full(n_fires, default)

    df = pd.DataFrame(
        {
            "latitude": ds["latitude"].values.astype(float),
            "longitude": ds["longitude"].values.astype(float),
            "time": pd.to_datetime(ds["time"].values),
            "frp": _opt("FRP_MWIR", np.nan).astype(float),
            "confidence": _opt("confidence", np.nan).astype(float),
            "classification": _opt("classification", VEGETATION_FIRE).astype(int),
        }
    )
    df["processor"] = str(ds.attrs.get("source", ""))
    w, s, e, n = bbox
    keep = df["longitude"].between(w, e) & df["latitude"].between(s, n)
    return df[keep].reset_index(drop=True)


def _open_netcdf(content: bytes):
    import xarray as xr

    try:
        return xr.open_dataset(io.BytesIO(content), engine="h5netcdf")
    except ImportError as exc:  # h5netcdf >= 1.8 needs an explicit HDF5 backend
        raise RuntimeError(
            "h5netcdf needs h5py to read Sentinel-3 NetCDF4: run `uv sync` in pipeline/"
        ) from exc


def fetch_granule(item: dict, bbox: tuple, cache_dir: Path, session=None) -> pd.DataFrame:
    """Download one granule's frp-in asset (or read the cached result)."""
    path = cache_dir / f"{item['id']}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    import planetary_computer
    import requests

    session = session or requests
    last_exc: Exception | None = None
    for attempt in range(4):
        try:
            resp = session.get(planetary_computer.sign(item["href"]), timeout=120)
            resp.raise_for_status()
            with _open_netcdf(resp.content) as ds:
                df = parse_granule(ds, bbox)
            break
        except RuntimeError:
            raise
        except Exception as exc:  # network or truncated file: retry
            last_exc = exc
            time.sleep(2**attempt)
    else:
        raise RuntimeError(f"failed to fetch {item['id']}: {last_exc}")
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return df


def fetch_all(
    items: pd.DataFrame, bbox: tuple, cache_dir: Path, workers: int
) -> tuple[pd.DataFrame, list[str]]:
    """Fetch sampled granules in parallel; return (fires with granule metadata, failed ids)."""
    import requests

    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_maxsize=workers)
    session.mount("https://", adapter)
    todo = items[items["sampled"]].to_dict("records")
    frames: list[pd.DataFrame] = []
    failed: list[str] = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(fetch_granule, it, bbox, cache_dir, session): it for it in todo}
        for k, fut in enumerate(as_completed(futures), 1):
            it = futures[fut]
            try:
                df = fut.result()
            except RuntimeError as exc:
                if "h5py" in str(exc):
                    raise
                log.warning("%s", exc)
                failed.append(it["id"])
                continue
            if len(df):
                df = df.assign(
                    granule=it["id"], platform=it["platform"], orbit=it["absolute_orbit"]
                )
                frames.append(df)
            if k % 250 == 0:
                log.info("granules %d/%d (%.0fs)", k, len(todo), time.time() - t0)
    if failed:
        log.warning("%d granules failed and were skipped", len(failed))
    if not frames:
        return pd.DataFrame(columns=FIRE_COLUMNS + ["granule", "platform", "orbit"]), failed
    return pd.concat(frames, ignore_index=True), failed


# --------------------------------------------------------------------------- aggregation


def load_region_polygon(region: str, path: Path = common.REGIONS_GEOJSON):
    """Return a list of matplotlib Paths (polygon exteriors) or None if not available."""
    if not path.exists():
        return None
    from matplotlib.path import Path as MplPath

    gj = json.loads(path.read_text())
    rings = []
    for feat in gj.get("features", []):
        if feat.get("properties", {}).get("region") != region:
            continue
        geom = feat["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        rings.extend(MplPath(np.asarray(poly[0])[:, :2]) for poly in polys)
    return rings or None


def clip(df: pd.DataFrame, bbox: tuple, polygon=None) -> pd.DataFrame:
    w, s, e, n = bbox
    keep = df["longitude"].between(w, e) & df["latitude"].between(s, n)
    df = df[keep]
    if polygon is not None and len(df):
        pts = df[["longitude", "latitude"]].to_numpy()
        inside = np.zeros(len(df), dtype=bool)
        for ring in polygon:
            inside |= ring.contains_points(pts)
        df = df[inside]
    return df


def aggregate_monthly(
    fires: pd.DataFrame,
    items: pd.DataFrame,
    region: str,
    bbox: tuple,
    polygon=None,
) -> pd.DataFrame:
    """Monthly detections and H3 res-8 cell-days, scaled from sampled days to all days.

    fires: latitude, longitude, time, classification, platform, orbit (sampled granules only).
    items: output of select_granules (all granules, with `sampled`).
    """
    f = fires[(fires["classification"].astype(int) & VEGETATION_FIRE) > 0]
    f = clip(f, bbox, polygon).copy()
    # Adjacent frames of the same overpass overlap slightly: count each pixel once.
    f["lat_r"] = f["latitude"].round(4)
    f["lon_r"] = f["longitude"].round(4)
    f = f.drop_duplicates(["platform", "orbit", "lat_r", "lon_r"])
    f["local_date"] = local_solar_date(f["time"], f["longitude"].to_numpy())
    f["month"] = f["local_date"].dt.to_period("M").dt.to_timestamp()
    f["h3_r8"] = [
        h3.latlng_to_cell(la, lo, common.H3_FINE_RES)
        for la, lo in zip(f["latitude"], f["longitude"], strict=True)
    ]

    det = f.groupby("month").size().rename("detections_sampled")
    cd = (
        f.drop_duplicates(["platform", "h3_r8", "local_date"])
        .groupby("month")
        .size()
        .rename("cell_days_sampled")
    )

    g = items.groupby("month")
    out = pd.DataFrame(
        {
            "granules": g.size(),
            "granules_sampled": g["sampled"].sum(),
            "days_with_data": g["local_date"].nunique(),
            "sampled_days": items[items["sampled"]].groupby("month")["local_date"].nunique(),
        }
    )
    out = out.join(det).join(cd).fillna(0)
    out = out[out["sampled_days"] > 0]
    scale = out["days_with_data"] / out["sampled_days"]
    out["detections"] = (out["detections_sampled"] * scale).round(1)
    out["cell_days"] = (out["cell_days_sampled"] * scale).round(1)
    out["days_in_month"] = [calendar.monthrange(m.year, m.month)[1] for m in out.index]
    out = out.reset_index().rename(columns={"index": "month"})
    out.insert(0, "region", region)
    int_cols = [
        "granules",
        "granules_sampled",
        "days_with_data",
        "sampled_days",
        "detections_sampled",
        "cell_days_sampled",
        "days_in_month",
    ]
    out[int_cols] = out[int_cols].astype(int)
    out["month"] = pd.to_datetime(out["month"]).dt.date
    cols = ["region", "month", "detections", "cell_days", "granules"]
    return out[cols + [c for c in out.columns if c not in cols]]


# --------------------------------------------------------------------------- comparison


def merge_series(
    s3_monthly: pd.DataFrame,
    monthly_harmonized: pd.DataFrame,
    region: str = "pantanal",
    min_day_coverage: float = MIN_DAY_COVERAGE,
) -> pd.DataFrame:
    """Join S3 monthly values with the harmonized monthly region total on overlapping months.

    Drops months with day coverage < min_day_coverage and provisional harmonized months.
    """
    s3 = s3_monthly[s3_monthly["region"] == region].copy()
    s3["month"] = pd.to_datetime(s3["month"])
    if {"days_with_data", "days_in_month"} <= set(s3.columns):
        s3 = s3[s3["days_with_data"] >= min_day_coverage * s3["days_in_month"]]

    h = monthly_harmonized[monthly_harmonized["region"] == region].copy()
    h["month"] = pd.to_datetime(h["month"])
    if "provisional" in h.columns:
        prov = h.groupby("month")["provisional"].any()
        h = h[~h["month"].isin(prov[prov].index)]
    h = h.groupby("month", as_index=False)["harmonized"].sum()

    m = s3[["month", "detections", "cell_days"]].merge(h, on="month", how="inner")
    return m.sort_values("month").reset_index(drop=True)


def compare(
    s3_monthly: pd.DataFrame,
    monthly_harmonized: pd.DataFrame,
    region: str = "pantanal",
    min_day_coverage: float = MIN_DAY_COVERAGE,
    min_year_months: int = MIN_YEAR_MONTHS,
) -> dict:
    """Spearman r on monthly totals and per-year peak-month agreement."""
    from scipy.stats import spearmanr

    m = merge_series(s3_monthly, monthly_harmonized, region, min_day_coverage)
    result: dict = {"region": region, "n_months": int(len(m))}
    if len(m) < 3:
        result.update(spearman_r=None, spearman_r_detections=None, peak_month_match=None)
        result["peak_months"] = {}
        return result

    def _r(a, b):
        r = spearmanr(a, b).statistic
        return None if np.isnan(r) else round(float(r), 3)

    result["spearman_r"] = _r(m["cell_days"], m["harmonized"])
    result["spearman_r_detections"] = _r(m["detections"], m["harmonized"])

    peaks = {}
    for year, grp in m.groupby(m["month"].dt.year):
        if len(grp) < min_year_months:
            continue
        s3_peak = int(grp.loc[grp["cell_days"].idxmax(), "month"].month)
        h_peak = int(grp.loc[grp["harmonized"].idxmax(), "month"].month)
        peaks[str(year)] = {"sentinel3": s3_peak, "harmonized": h_peak, "match": s3_peak == h_peak}
    result["peak_months"] = peaks
    result["peak_month_match"] = (
        round(sum(p["match"] for p in peaks.values()) / len(peaks), 3) if peaks else None
    )
    result["months"] = [m["month"].min().strftime("%Y-%m"), m["month"].max().strftime("%Y-%m")]
    return result


def plot(s3_monthly: pd.DataFrame, merged: pd.DataFrame | None, path: Path, region: str) -> Path:
    """Both series indexed to their own peak (= 1) on one axis."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    blue, orange = "#2a78d6", "#eb6834"
    ink, muted = "#0b0b0b", "#52514e"
    fig, ax = plt.subplots(figsize=(10, 4), dpi=150)
    fig.patch.set_facecolor("#fcfcfb")
    ax.set_facecolor("#fcfcfb")

    if merged is not None and len(merged):
        x = merged["month"]
        s3 = merged["cell_days"] / merged["cell_days"].max()
        hz = merged["harmonized"] / merged["harmonized"].max()
        ax.plot(x, hz, color=blue, lw=2, label="Fireline harmonized (MODIS-equivalent)")
        ax.plot(x, s3, color=orange, lw=2, label="Sentinel-3 SLSTR FRP")
        ax.set_ylabel("Fire cell-days, share of series peak", color=muted)
    else:
        s = s3_monthly[s3_monthly["region"] == region].copy()
        s["month"] = pd.to_datetime(s["month"])
        if {"days_with_data", "days_in_month"} <= set(s.columns):
            s = s[s["days_with_data"] >= MIN_DAY_COVERAGE * s["days_in_month"]]
        ax.plot(s["month"], s["cell_days"], color=orange, lw=2)
        ax.set_ylabel("Fire cell-days (H3 res 8)", color=muted)

    name = common.REGIONS.get(region, {}).get("name", region)
    if merged is not None and len(merged):
        ax.set_title(f"{name}: Sentinel-3 vs Fireline, monthly", color=ink, loc="left")
        ax.legend(frameon=False, loc="upper left", labelcolor=ink)
    else:
        ax.set_title(f"{name}: Sentinel-3 SLSTR monthly fire cell-days", color=ink, loc="left")
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#c3c2b7")
    ax.tick_params(colors=muted)
    ax.grid(axis="y", color="#e6e5e0", lw=0.8)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)
    return path


def write_results(result: dict, processed_dir: Path = common.PROCESSED_DIR) -> Path:
    """Merge into validation.json under `sentinel3` if it exists, else write a sidecar file."""
    vpath = processed_dir / "validation.json"
    if vpath.exists() and result.get("status") == "ok":
        data = json.loads(vpath.read_text())
        data["sentinel3"] = result
        vpath.write_text(json.dumps(data, indent=2, default=str))
        return vpath
    out = processed_dir / "validation_sentinel3.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, default=str))
    return out


def run_comparison(s3_monthly: pd.DataFrame, region: str, day_step: int) -> Path:
    fig_path = common.FIGURES_DIR / f"sentinel3_{region}.png"
    monthly_path = common.PROCESSED_DIR / "monthly.parquet"
    sampling = {
        "day_step": day_step,
        "granules_total": int(s3_monthly["granules"].sum()),
        "granules_read": int(s3_monthly["granules_sampled"].sum()),
    }
    base = {
        "source": f"ESA Sentinel-3 SLSTR L2 FRP via Microsoft Planetary Computer ({COLLECTION})",
        "sampling": sampling,
        "figure": f"figures/{fig_path.name}",
    }
    if monthly_path.exists():
        harmonized = pd.read_parquet(monthly_path)
        merged = merge_series(s3_monthly, harmonized, region)
        result = {"status": "ok", **compare(s3_monthly, harmonized, region), **base}
        plot(s3_monthly, merged, fig_path, region)
    else:
        result = {
            "status": "pending",
            "reason": "processed/monthly.parquet not found; rerun with --compare-only",
            "region": region,
            "spearman_r": None,
            "n_months": 0,
            "peak_month_match": None,
            **base,
        }
        plot(s3_monthly, None, fig_path, region)
    out = write_results(result)
    log.info("comparison: %s", {k: result.get(k) for k in ("status", "spearman_r", "n_months")})
    return out


# --------------------------------------------------------------------------- CLI


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="pantanal", choices=sorted(common.REGIONS))
    ap.add_argument("--start", default=DATA_START)
    ap.add_argument("--end", default=(date.today() + timedelta(days=1)).isoformat())
    ap.add_argument(
        "--day-step",
        type=int,
        default=DEFAULT_DAY_STEP,
        help="read every Nth local solar day (1 = all granules)",
    )
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--refresh-items", action="store_true", help="re-run the STAC search")
    ap.add_argument(
        "--compare-only",
        action="store_true",
        help="skip downloads; compare existing sentinel3_monthly.parquet",
    )
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    common.ensure_dirs()

    out_path = common.PROCESSED_DIR / "sentinel3_monthly.parquet"
    if args.compare_only:
        s3_monthly = pd.read_parquet(out_path)
        print(run_comparison(s3_monthly, args.region, args.day_step))
        return

    bbox = common.REGIONS[args.region]["bbox"]
    items_path = S3_DIR / f"items_{args.region}.parquet"
    if items_path.exists() and not args.refresh_items:
        items = pd.read_parquet(items_path)
    else:
        log.info("searching %s over %s", COLLECTION, bbox)
        items = search_items(bbox, args.start, args.end)
        items_path.parent.mkdir(parents=True, exist_ok=True)
        items.to_parquet(items_path, index=False)
    items = items[(items["datetime"] >= args.start) & (items["datetime"] < args.end)]
    items = select_granules(items, bbox, args.day_step)
    log.info(
        "%d granules, %d sampled (day step %d)", len(items), items["sampled"].sum(), args.day_step
    )

    fires, failed = fetch_all(items, bbox, GRANULE_DIR, args.workers)
    # A failed granule is treated as not read; its day still counts if another granule worked.
    items.loc[items["id"].isin(failed), "sampled"] = False
    polygon = load_region_polygon(args.region)
    log.info("clip: %s", "regions.geojson" if polygon else "bbox")
    s3_monthly = aggregate_monthly(fires, items, args.region, bbox, polygon)
    s3_monthly.to_parquet(out_path, index=False)
    log.info("wrote %s (%d months)", out_path, len(s3_monthly))
    print(run_comparison(s3_monthly, args.region, args.day_step))


if __name__ == "__main__":
    main()
