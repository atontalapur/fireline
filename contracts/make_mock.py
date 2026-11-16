"""Generate deterministic mock data that follows the Fireline contracts.

Writes, next to this file:
  mock/monthly.parquet        synthetic monthly.parquet for region `pantanal` (contracts/monthly.md)
  mock/coverage_month.parquet region-month valid days for the mock (contracts/coverage.md)
  mock/calibration.parquet    k per calendar month fitted on the mock (contracts/calibration.md)
  mock/series-pantanal.json   POST /api/series response, full record (contracts/api-series.md)

The numbers are synthetic. They only reproduce the shapes the app has to handle: a dry-season
peak in Aug-Sep, the raw-VIIRS jump in 2012, the 2020 spike, the Terra-only start, one month
with data but no fire, one month with no satellite data and a provisional last month.

Run: cd contracts && uv run --project ../pipeline python make_mock.py
"""

from __future__ import annotations

import calendar
import json
import sys
from pathlib import Path

import h3
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
MOCK_DIR = HERE / "mock"
sys.path.insert(0, str(HERE.parent / "pipeline"))

import common  # noqa: E402

REGION = "pantanal"
SEED = 20261114
N_CELLS = 60
FIRST_MONTH = pd.Period(common.TERRA_ONLY_START, "M")  # 2000-11, first MODIS Terra month
LAST_MONTH = pd.Period("2026-10", "M")
AQUA_START = pd.Period(common.TERRA_RATIO_FIT[0], "M")  # 2002-07
VIIRS_START = pd.Period(common.FIT_START, "M")  # 2012-01, S-NPP
NOAA20_START = pd.Period("2018-04", "M")
NOAA21_START = pd.Period("2023-03", "M")
DRIFT_START = pd.Period("2021-01", "M")  # Terra/Aqua orbit drift lowers MODIS counts after this
NO_DATA_MONTH = pd.Period("2001-07", "M")  # synthetic outage, exercises valid_days = 0
NO_FIRE_MONTH = pd.Period("2005-02", "M")  # data but no fire: no monthly rows, valid_days > 0
LAST_VALID_DAYS = 28  # provisional last month with NRT gaps, exercises the partial flag

# Relative fire activity by calendar month (Jan..Dec), dry-season peak in Aug-Sep.
SEASON = np.array([0.05, 0.04, 0.05, 0.08, 0.15, 0.30, 0.60, 1.00, 1.00, 0.60, 0.25, 0.10])
# Raw VIIRS / MODIS cell-day ratio by calendar month, 3-5x as in the real overlap.
VIIRS_RATIO = np.array([4.8, 4.9, 4.6, 4.2, 3.8, 3.4, 3.1, 3.0, 3.0, 3.3, 3.9, 4.5])
YEAR_BOOST = {2019: 1.6, 2020: 3.5, 2024: 2.4}
PEAK_CELL_DAYS = 3.0  # mean MODIS cell-days per cell in a normal peak month

MONTHLY_SCHEMA = pa.schema(
    [
        ("region", pa.string()),
        ("h3_r6", pa.string()),
        ("month", pa.date32()),
        ("modis_raw", pa.float64()),
        ("viirs_raw", pa.float64()),
        ("harmonized", pa.float64()),
        ("harmonized_lo", pa.float64()),
        ("harmonized_hi", pa.float64()),
        ("source", pa.string()),
        ("provisional", pa.bool_()),
        ("valid_days", pa.int32()),
    ]
)
COVERAGE_SCHEMA = pa.schema(
    [
        ("region", pa.string()),
        ("month", pa.date32()),
        ("valid_days", pa.int32()),
        ("modis_valid_days", pa.int32()),
        ("viirs_valid_days", pa.int32()),
    ]
)
CALIBRATION_SCHEMA = pa.schema(
    [
        ("region", pa.string()),
        ("month_of_year", pa.int32()),
        ("k", pa.float64()),
        ("k_lo", pa.float64()),
        ("k_hi", pa.float64()),
        ("n_years", pa.int32()),
    ]
)


def region_cells(region: str = REGION) -> list[str]:
    """All H3 res-6 cells whose centers fall in the region bbox (stand-in for the polygon)."""
    w, s, e, n = common.REGIONS[region]["bbox"]
    poly = h3.LatLngPoly([(s, w), (s, e), (n, e), (n, w)])
    return sorted(h3.polygon_to_cells(poly, common.H3_STORE_RES))


def source_for(month: pd.Period) -> str:
    if month <= pd.Period(common.TERRA_ONLY_END, "M"):
        return "terra_scaled"
    if month < pd.Period(common.SWITCH_MONTH, "M"):
        return "modis"
    return "viirs_scaled"


def _viirs_satellites(month: pd.Period) -> int:
    if month < VIIRS_START:
        return 0
    if month < NOAA20_START:
        return 1
    if month < NOAA21_START:
        return 2
    return 3


def simulate_counts(seed: int = SEED) -> tuple[list[str], pd.DataFrame]:
    """Per-cell, per-month synthetic counts: terra, aqua, viirs (NaN when not flying)."""
    rng = np.random.default_rng(seed)
    cells = sorted(rng.choice(region_cells(), size=N_CELLS, replace=False).tolist())
    weights = rng.lognormal(0.0, 0.8, N_CELLS)
    weights /= weights.mean()
    years = range(FIRST_MONTH.year, LAST_MONTH.year + 1)
    year_factor = {y: rng.lognormal(0.0, 0.3) * YEAR_BOOST.get(y, 1.0) for y in years}
    # Keep 2020 the record year whatever the random draws were.
    year_factor[2020] = max(
        year_factor[2020], 1.6 * max(v for y, v in year_factor.items() if y != 2020)
    )
    last_drift = (LAST_MONTH - DRIFT_START).n

    frames = []
    for month in pd.period_range(FIRST_MONTH, LAST_MONTH, freq="M"):
        m = month.month
        mu = PEAK_CELL_DAYS * SEASON[m - 1] * year_factor[month.year] * weights
        mu = mu * rng.lognormal(0.0, 0.2)  # month-level noise shared by all cells
        if month == NO_DATA_MONTH:
            continue
        drift = 1.0
        if month >= DRIFT_START:
            drift = 1.0 - 0.2 * (month - DRIFT_START).n / last_drift
        terra = rng.poisson(0.5 * mu * drift).astype(float)
        aqua = (
            rng.poisson(0.5 * mu * drift).astype(float)
            if month >= AQUA_START
            else np.full(N_CELLS, np.nan)
        )
        n_sat = _viirs_satellites(month)
        if n_sat:
            viirs = rng.poisson(VIIRS_RATIO[m - 1] * mu, size=(n_sat, N_CELLS)).mean(axis=0)
        else:
            viirs = np.full(N_CELLS, np.nan)
        if month == NO_FIRE_MONTH:  # draws above keep the random stream of later months
            terra, aqua, viirs = terra * 0, aqua * 0, viirs * 0
        frames.append(
            pd.DataFrame(
                {"h3_r6": cells, "month": month, "terra": terra, "aqua": aqua, "viirs": viirs}
            )
        )
    return cells, pd.concat(frames, ignore_index=True)


def _in_period(months: pd.Series, start: str, end: str) -> pd.Series:
    return (months >= pd.Period(start, "M")) & (months <= pd.Period(end, "M"))


def terra_ratio(counts: pd.DataFrame) -> pd.Series:
    """(Terra + Aqua) / Terra by calendar month over common.TERRA_RATIO_FIT."""
    fit = counts[_in_period(counts["month"], *common.TERRA_RATIO_FIT)]
    moy = fit["month"].dt.month
    sums = fit.assign(moy=moy).groupby("moy")[["terra", "aqua"]].sum()
    return (sums["terra"] + sums["aqua"]) / sums["terra"]


def fit_mock_calibration(counts: pd.DataFrame, seed: int = common.BOOT_SEED) -> pd.DataFrame:
    """Stand-in for calibrate.fit_calibration: shrunk ratio of sums plus a year bootstrap."""
    fit = counts[_in_period(counts["month"], common.FIT_START, common.FIT_END)].copy()
    fit["modis"] = fit["terra"] + fit["aqua"]
    fit["year"] = fit["month"].dt.year
    fit["moy"] = fit["month"].dt.month
    by = fit.groupby(["moy", "year"])[["modis", "viirs"]].sum()
    k_region = by["modis"].sum() / by["viirs"].sum()
    n0 = common.SHRINK_N0
    rng = np.random.default_rng(seed)
    rows = []
    for moy in range(1, 13):
        sub = by.loc[moy]
        n = sub["modis"].sum()

        def shrunk(modis: float, viirs: float, n: float = n) -> float:
            return (n * (modis / viirs) + n0 * k_region) / (n + n0)

        k = shrunk(sub["modis"].sum(), sub["viirs"].sum())
        idx = rng.integers(0, len(sub), size=(common.N_BOOT, len(sub)))
        boot = [
            shrunk(sub["modis"].to_numpy()[i].sum(), sub["viirs"].to_numpy()[i].sum()) for i in idx
        ]
        lo, hi = np.percentile(boot, [5, 95])
        rows.append((REGION, moy, k, min(lo, k), max(hi, k), len(sub)))
    return pd.DataFrame(rows, columns=CALIBRATION_SCHEMA.names)


def build_monthly(seed: int = SEED) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (monthly, calibration) mock frames in contract column order."""
    _, counts = simulate_counts(seed)
    ratio = terra_ratio(counts)
    calib = fit_mock_calibration(counts)
    k = calib.set_index("month_of_year")

    df = counts.copy()
    moy = df["month"].dt.month
    df["modis_raw"] = df["terra"] + df["aqua"].fillna(0.0)
    df["viirs_raw"] = df["viirs"]
    df["source"] = df["month"].map(source_for)
    df["harmonized"] = df["modis_raw"]
    df["harmonized_lo"] = df["modis_raw"]
    df["harmonized_hi"] = df["modis_raw"]
    terra_only = df["source"] == "terra_scaled"
    df.loc[terra_only, "harmonized"] = df["terra"] * moy.map(ratio)
    viirs = df["source"] == "viirs_scaled"
    for col, kcol in (("harmonized", "k"), ("harmonized_lo", "k_lo"), ("harmonized_hi", "k_hi")):
        df.loc[viirs, col] = df["viirs_raw"] * moy.map(k[kcol])
    df.loc[terra_only, "harmonized_lo"] = df["harmonized"]
    df.loc[terra_only, "harmonized_hi"] = df["harmonized"]

    # Only cells with any fire are stored. Region-months without fire live in coverage_month.
    fire = (df["modis_raw"] > 0) | (df["viirs_raw"].fillna(0) > 0)
    df = df[fire].copy()

    df["region"] = REGION
    df["provisional"] = df["month"] == LAST_MONTH
    df["valid_days"] = df["month"].map(_valid_days).astype("int32")
    df = df.sort_values(["month", "h3_r6"]).reset_index(drop=True)
    df["month"] = df["month"].map(lambda p: p.start_time.date())
    return df[MONTHLY_SCHEMA.names], calib


def _valid_days(month: pd.Period) -> int:
    if month == NO_DATA_MONTH:
        return 0
    if month == LAST_MONTH:
        return LAST_VALID_DAYS
    return month.days_in_month


def build_coverage() -> pd.DataFrame:
    """Mock coverage_month: one row per region-month, fire or not (contracts/coverage.md)."""
    months = pd.period_range(FIRST_MONTH, LAST_MONTH, freq="M")
    valid = [_valid_days(m) for m in months]
    viirs = [_valid_days(m) if m >= VIIRS_START else 0 for m in months]
    df = pd.DataFrame(
        {
            "region": REGION,
            "month": [m.start_time.date() for m in months],
            "valid_days": valid,
            "modis_valid_days": valid,  # Terra (and Aqua from 2002-07) up whenever any data
            "viirs_valid_days": viirs,
        }
    )
    for col in COVERAGE_SCHEMA.names[2:]:
        df[col] = df[col].astype("int32")
    return df[COVERAGE_SCHEMA.names]


def _num(x: float | None, digits: int = 3) -> float | None:
    if x is None or pd.isna(x):
        return None
    return round(float(x), digits)


def build_series(
    monthly: pd.DataFrame,
    coverage: pd.DataFrame,
    start: str,
    end: str,
    region: str | None = None,
    cells: list[str] | None = None,
    baseline: tuple[int, int] = common.BASELINE_YEARS,
    area_cells: list[str] | None = None,
) -> dict:
    """Reference implementation of POST /api/series (contracts/api-series.md).

    `coverage` is coverage_month.parquet; it supplies the month axis and valid_days.
    `area_cells` is the cell set used for meta.area_km2 / cell_count. It defaults to `cells`,
    or to region_cells(region) for a region request.
    """
    if (region is None) == (cells is None):
        raise ValueError("pass exactly one of region or cells")
    df = monthly.copy()
    df["month"] = pd.to_datetime(df["month"]).dt.to_period("M")
    if region is None:
        region = df.loc[df["h3_r6"].isin(cells), "region"].iloc[0]
    reg = df[df["region"] == region]
    sel = reg if cells is None else reg[reg["h3_r6"].isin(cells)]
    if area_cells is None:
        area_cells = list(cells) if cells is not None else region_cells(region)

    # Region-level fields. The month axis and valid days come from coverage_month, so months
    # without any fire row are still present. source follows the splice table; provisional is
    # true if any row of the region-month says so.
    cov = coverage[coverage["region"] == region].copy()
    cov["month"] = pd.to_datetime(cov["month"]).dt.to_period("M")
    rm = cov.set_index("month").sort_index()[["valid_days"]]
    rm["source"] = rm.index.map(source_for)
    prov = reg.groupby("month")["provisional"].any()
    rm["provisional"] = prov.reindex(rm.index, fill_value=False).astype(bool)
    rm["modis_on"] = cov.set_index("month")["modis_valid_days"].reindex(rm.index) > 0
    rm["viirs_on"] = cov.set_index("month")["viirs_valid_days"].reindex(rm.index) > 0
    value_cols = ["harmonized", "harmonized_lo", "harmonized_hi", "modis_raw", "viirs_raw"]
    sums = sel.groupby("month")[value_cols].sum(min_count=1).reindex(rm.index)
    series = rm.join(sums)
    has_data = series["valid_days"] > 0
    for col in ["harmonized", "harmonized_lo", "harmonized_hi"]:
        series[col] = series[col].fillna(0.0).where(has_data)
    series["modis_raw"] = series["modis_raw"].fillna(0.0).where(has_data & series["modis_on"])
    series["viirs_raw"] = series["viirs_raw"].fillna(0.0).where(has_data & series["viirs_on"])

    warnings: list[str] = []
    record_start, record_end = series.index.min(), series.index.max()
    lo_p, hi_p = pd.Period(start, "M"), pd.Period(end, "M")
    if lo_p < record_start or hi_p > record_end:
        warnings.append(f"Requested range clipped to the record {record_start} to {record_end}.")
    lo_p, hi_p = max(lo_p, record_start), min(hi_p, record_end)

    # Baseline per calendar month from the full record, not only the requested range.
    b0, b1 = baseline
    base = series[(series.index.year >= b0) & (series.index.year <= b1)]["harmonized"].dropna()
    stats = {}
    for moy in range(1, 13):
        b = base[base.index.month == moy].to_numpy()
        if len(b) == 0:
            stats[moy] = None
            continue
        med = float(np.median(b))
        mad = float(np.median(np.abs(b - med)))
        stats[moy] = {"b": b, "median": med, "mean": float(b.mean()), "mad": mad}
        if mad == 0:
            name = calendar.month_name[moy]
            warnings.append(f"Baseline MAD is 0 for {name}; z is null for that month.")

    window = series[(series.index >= lo_p) & (series.index <= hi_p)]
    months = []
    for month, row in window.iterrows():
        st = stats[month.month]
        x = row["harmonized"]
        z = pct = None
        if st is not None and not pd.isna(x):
            if st["mad"] > 0:
                z = (x - st["median"]) / (1.4826 * st["mad"])
            b = st["b"]
            pct = 100.0 * ((b < x).sum() + 0.5 * (b == x).sum()) / len(b)
        if row["valid_days"] == 0:
            warnings.append(f"{month}: no satellite data (valid_days = 0).")
        months.append(
            {
                "month": str(month),
                "harmonized": _num(x),
                "lo": _num(row["harmonized_lo"]),
                "hi": _num(row["harmonized_hi"]),
                "modis_raw": _num(row["modis_raw"]),
                "viirs_raw": _num(row["viirs_raw"]),
                "source": row["source"],
                "provisional": bool(row["provisional"]),
                "valid_days": int(row["valid_days"]),
                "baseline_median": _num(st["median"]) if st else None,
                "baseline_mean": _num(st["mean"]) if st else None,
                "z": _num(z),
                "percentile": _num(pct, 1),
            }
        )
    prov = [m["month"] for m in months if m["provisional"]]
    if prov:
        warnings.append(f"Provisional (NRT or incomplete) months: {', '.join(prov)}.")

    # Summary.
    cur = months[-1]
    cur_period = window.index[-1]
    med = cur["baseline_median"]
    ratio = None
    if cur["harmonized"] is not None and med:
        ratio = _num(cur["harmonized"] / med, 2)
    current = {
        "month": cur["month"],
        "harmonized": cur["harmonized"],
        "baseline_median": med,
        "ratio_to_median": ratio,
        "z": cur["z"],
        "percentile": cur["percentile"],
        "provisional": cur["provisional"],
        "partial": cur["valid_days"] < cur_period.days_in_month,
    }
    means = {m: st["mean"] for m, st in stats.items() if st is not None}
    peak_moy = max(means, key=lambda m: (means[m], -m)) if means else None

    years = sorted({p.year for p in window.index})
    annual = []
    for y in years:
        yr = window[window.index.year == y]
        complete = len(yr) == 12 and bool((yr["valid_days"] > 0).all())
        annual.append(
            {"year": y, "total": _num(yr["harmonized"].sum()), "rank": None, "complete": complete}
        )
    ranked = sorted((a for a in annual if a["complete"]), key=lambda a: (-a["total"], a["year"]))
    for a in ranked:
        a["rank"] = 1 + sum(1 for b in ranked if b["total"] > a["total"])
    peak_year = ranked[0]["year"] if ranked else None

    return {
        "months": months,
        "summary": {
            "current": current,
            "peak_month_of_year": peak_moy,
            "peak_year": peak_year,
            "annual": annual,
        },
        "meta": {
            "method_version": common.METHOD_VERSION,
            "area_km2": _num(sum(h3.cell_area(c, "km^2") for c in area_cells), 1),
            "cell_count": len(area_cells),
            "warnings": warnings,
        },
    }


MOCK_REQUEST = {
    "cells": None,
    "region": REGION,
    "start": str(FIRST_MONTH),
    "end": str(LAST_MONTH),
    "baseline": list(common.BASELINE_YEARS),
}


def main() -> None:
    MOCK_DIR.mkdir(exist_ok=True)
    monthly, calib = build_monthly()
    coverage = build_coverage()
    pq.write_table(
        pa.Table.from_pandas(monthly, schema=MONTHLY_SCHEMA, preserve_index=False),
        MOCK_DIR / "monthly.parquet",
    )
    pq.write_table(
        pa.Table.from_pandas(coverage, schema=COVERAGE_SCHEMA, preserve_index=False),
        MOCK_DIR / "coverage_month.parquet",
    )
    pq.write_table(
        pa.Table.from_pandas(calib, schema=CALIBRATION_SCHEMA, preserve_index=False),
        MOCK_DIR / "calibration.parquet",
    )
    req = MOCK_REQUEST
    series = build_series(
        monthly,
        coverage,
        req["start"],
        req["end"],
        region=req["region"],
        baseline=tuple(req["baseline"]),
    )
    out = MOCK_DIR / f"series-{REGION}.json"
    out.write_text(json.dumps(series, indent=1, allow_nan=False) + "\n")
    print(f"monthly.parquet: {len(monthly)} rows, {monthly['h3_r6'].nunique()} cells")
    print(f"coverage_month.parquet: {len(coverage)} rows")
    print(f"calibration.parquet: k = {calib['k'].round(3).tolist()}")
    print(f"{out.name}: {len(series['months'])} months, peak_year {series['summary']['peak_year']}")


if __name__ == "__main__":
    main()
