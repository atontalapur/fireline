"""A4: calibrate VIIRS to MODIS on the overlap years.

For each region x calendar month (stratum) over the fit years:

    k_s      = sum(MODIS cell-days) / sum(VIIRS cell-days)       (ratio, no intercept)
    k_region = same ratio over all months of the region
    k_hat    = (n * k_s + n0 * k_region) / (n + n0),  n = MODIS cell-days in the stratum

Strata with no VIIRS cell-days fall back to k_region. The 90% band (k_lo, k_hi) comes from a
bootstrap that resamples whole fit years with replacement and repeats the same shrinkage in
every replicate.

Input:  PROCESSED_DIR/cell_days_r6_month.parquet (region, month, modis, viirs, ...)
Output: PROCESSED_DIR/calibration.parquet (region, month_of_year, k, k_lo, k_hi, n_years)
"""

from __future__ import annotations

import argparse
import logging
import zlib
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pandas as pd

import common

log = logging.getLogger("calibrate")

# Expected range of k (VIIRS sees roughly 2-6x more fire cell-days than MODIS). Used for warnings.
K_EXPECTED_RANGE = (0.15, 0.5)
BAND_PCT = (5.0, 95.0)
MONTHS = np.arange(1, 13)
OUTPUT_COLUMNS = ["region", "month_of_year", "k", "k_lo", "k_hi", "n_years"]


def _yearly_sums(cell_days: pd.DataFrame, fit_years: Iterable[int]) -> pd.DataFrame:
    """Sum modis and viirs to region x year x month_of_year, keeping only fit years."""
    df = cell_days[["region", "month", "modis", "viirs"]].copy()
    month = pd.to_datetime(df["month"])
    df["year"] = month.dt.year.astype(int)
    df["month_of_year"] = month.dt.month.astype(int)
    df = df[df["year"].isin(set(int(y) for y in fit_years))]
    df[["modis", "viirs"]] = df[["modis", "viirs"]].fillna(0).astype(float)
    return df.groupby(["region", "year", "month_of_year"], as_index=False)[["modis", "viirs"]].sum()


def _year_month_matrix(r: pd.DataFrame, col: str, years: list[int]) -> np.ndarray:
    """Pivot one region's yearly sums to a (years, 12) array, zero-filled."""
    if not years:
        return np.zeros((0, 12))
    wide = r.pivot(index="year", columns="month_of_year", values=col)
    return wide.reindex(index=years, columns=MONTHS).fillna(0.0).to_numpy()


def _shrunk_k(m: np.ndarray, v: np.ndarray, n0: float) -> np.ndarray:
    """Shrunk k for MODIS/VIIRS sums with shape (..., 12). Returns the same shape.

    k_region is computed over the last axis. Strata with v == 0 get k_region. If the region has
    no VIIRS at all, the result is NaN.
    """
    m_tot = m.sum(axis=-1, keepdims=True)
    v_tot = v.sum(axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        k_region = np.where(v_tot > 0, m_tot / v_tot, np.nan)
        k_s = np.where(v > 0, m / np.where(v > 0, v, 1.0), 0.0)
        k_hat = (m * k_s + n0 * k_region) / (m + n0) if n0 > 0 else k_s
    k_region = np.broadcast_to(k_region, k_hat.shape)
    return np.where(v > 0, k_hat, k_region)


def _fit_region(
    m_y: np.ndarray, v_y: np.ndarray, n0: float, n_boot: int, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Point estimate and bootstrap band for one region. m_y, v_y have shape (years, 12)."""
    k = _shrunk_k(m_y.sum(axis=0), v_y.sum(axis=0), n0)
    n_years_avail = m_y.shape[0]
    if n_boot <= 0 or n_years_avail < 2:
        return k, k.copy(), k.copy()

    # Each replicate is a multiset of years; summing per-year totals weighted by draw counts
    # is equivalent to concatenating the resampled years.
    idx = rng.integers(0, n_years_avail, size=(n_boot, n_years_avail))
    counts = np.zeros((n_boot, n_years_avail))
    np.add.at(counts, (np.arange(n_boot)[:, None], idx), 1.0)
    k_boot = _shrunk_k(counts @ m_y, counts @ v_y, n0)  # (n_boot, 12)

    with np.errstate(all="ignore"):
        if np.isnan(k_boot).all():
            lo = hi = np.full(12, np.nan)
        else:
            lo, hi = np.nanpercentile(k_boot, BAND_PCT, axis=0)
    # A percentile band can miss a skewed point estimate; widen so k_lo <= k <= k_hi holds.
    lo = np.fmin(lo, k)
    hi = np.fmax(hi, k)
    return k, lo, hi


def fit_calibration(
    cell_days: pd.DataFrame,
    fit_years: Iterable[int] = common.FIT_YEARS,
    n0: float = common.SHRINK_N0,
    n_boot: int = common.N_BOOT,
    seed: int = common.BOOT_SEED,
) -> pd.DataFrame:
    """Fit k per region x calendar month with shrinkage and a year bootstrap.

    `cell_days` needs region, month (date or timestamp), modis, viirs. Any subset of fit years
    works (leave-one-year-out). Every region in the input gets all 12 months; a month with no
    fit-year data takes k_region. Same inputs and seed give identical output.
    """
    fit_years = tuple(int(y) for y in fit_years)
    sums = _yearly_sums(cell_days, fit_years)
    regions = sorted(cell_days["region"].dropna().unique())

    frames = []
    for region in regions:
        r = sums[sums["region"] == region]
        years = sorted(r["year"].unique())
        m_y = _year_month_matrix(r, "modis", years)
        v_y = _year_month_matrix(r, "viirs", years)
        # Per-region stream so a region's band does not depend on which other regions are present.
        rng = np.random.default_rng([seed, zlib.crc32(str(region).encode())])
        k, lo, hi = _fit_region(m_y, v_y, n0, n_boot, rng)
        n_years = ((m_y + v_y) > 0).sum(axis=0)
        frames.append(
            pd.DataFrame(
                {
                    "region": region,
                    "month_of_year": MONTHS,
                    "k": k,
                    "k_lo": lo,
                    "k_hi": hi,
                    "n_years": n_years.astype(int),
                }
            )
        )

    if not frames:
        return pd.DataFrame(columns=OUTPUT_COLUMNS)
    out = pd.concat(frames, ignore_index=True)
    out["month_of_year"] = out["month_of_year"].astype(int)
    return out[OUTPUT_COLUMNS]


def apply_k(viirs, k):
    """Scale VIIRS cell-days to MODIS units: k * viirs, with zero VIIRS always giving zero.

    Works on scalars, numpy arrays and pandas Series (broadcasting as usual). Zero VIIRS maps to
    zero even when k is NaN, so missing calibration never invents fire.
    """
    viirs_arr = np.asarray(viirs, dtype=float)
    with np.errstate(invalid="ignore"):
        out = np.where(viirs_arr == 0, 0.0, np.asarray(k, dtype=float) * viirs_arr)
    if isinstance(viirs, pd.Series):
        return pd.Series(out, index=viirs.index, name=viirs.name)
    return out if out.ndim else float(out)


def log_calibration(calib: pd.DataFrame, expected=K_EXPECTED_RANGE) -> None:
    lo_ok, hi_ok = expected
    for row in calib.itertuples(index=False):
        msg = (
            f"{row.region} month {row.month_of_year:02d}: k={row.k:.3f} "
            f"[{row.k_lo:.3f}, {row.k_hi:.3f}] n_years={row.n_years}"
        )
        if not np.isfinite(row.k) or not (lo_ok <= row.k <= hi_ok):
            log.warning("%s (outside expected %.2f-%.2f)", msg, lo_ok, hi_ok)
        else:
            log.info(msg)


def main() -> None:
    p = argparse.ArgumentParser(description="Calibrate VIIRS to MODIS on the overlap years.")
    p.add_argument(
        "--input", type=Path, default=common.PROCESSED_DIR / "cell_days_r6_month.parquet"
    )
    p.add_argument("--output", type=Path, default=common.PROCESSED_DIR / "calibration.parquet")
    p.add_argument("--n0", type=float, default=common.SHRINK_N0)
    p.add_argument("--n-boot", type=int, default=common.N_BOOT)
    p.add_argument("--seed", type=int, default=common.BOOT_SEED)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    cell_days = pd.read_parquet(args.input, columns=["region", "month", "modis", "viirs"])
    log.info("read %d rows from %s", len(cell_days), args.input)
    calib = fit_calibration(cell_days, n0=args.n0, n_boot=args.n_boot, seed=args.seed)
    log_calibration(calib)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    calib.to_parquet(args.output, index=False)
    log.info("wrote %d rows to %s", len(calib), args.output)


if __name__ == "__main__":
    main()
