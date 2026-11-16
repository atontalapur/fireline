"""A5: splice MODIS and calibrated VIIRS into one harmonized 2000-present series.

Input:  PROCESSED_DIR/cell_days_r6_month.parquet (A3) and PROCESSED_DIR/calibration.parquet (A4).
Output: PROCESSED_DIR/monthly.parquet (contracts/monthly.md) and FIGURES_DIR/seam_{region}.png.

Rules per month (all MODIS-equivalent fire cell-days):
- TERRA_ONLY_START..TERRA_ONLY_END: terra x ratio(region, calendar month), source `terra_scaled`.
  ratio = sum(terra + aqua) / sum(terra) over TERRA_RATIO_FIT. A thin calendar month falls back
  to the region-wide ratio.
- after TERRA_ONLY_END, before the switch month: observed MODIS, source `modis`, lo = hi = value.
- switch month onward: k x viirs, lo/hi = k_lo/k_hi x viirs, source `viirs_scaled`. Nothing here
  needs MODIS, so the series keeps going after MODIS ends.

Row policy: only cells with fire are stored. A row is kept when harmonized, modis_raw or
viirs_raw is > 0, so raw-sensor totals stay complete (e.g. a 2015 cell seen only by VIIRS keeps
its viirs_raw with harmonized = 0). A missing row means zero fire. Months before
TERRA_ONLY_START are dropped.
"""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Iterable
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

import common

log = logging.getLogger("splice")

# Local constants (not in common.py).
VIIRS_START = "2012-01"  # first month with Suomi NPP VIIRS in FIRMS; viirs_raw is null before it
MIN_RATIO_TERRA = 20.0  # min summed Terra cell-days for a calendar-month ratio; else region-wide

KEY = ["region", "h3_r6", "month"]
OUT_COLUMNS = [
    "region",
    "h3_r6",
    "month",
    "modis_raw",
    "viirs_raw",
    "harmonized",
    "harmonized_lo",
    "harmonized_hi",
    "source",
    "provisional",
    "valid_days",
]


def _month_start(values) -> pd.Series:
    """Normalize dates, timestamps or 'YYYY-MM' strings to first-of-month Timestamps."""
    s = pd.Series(values)
    if s.dtype == object or pd.api.types.is_string_dtype(s):
        s = s.astype(str)
    return pd.to_datetime(s).dt.to_period("M").dt.to_timestamp()


def _ts(month) -> pd.Timestamp:
    return pd.Period(month, freq="M").to_timestamp()


def fit_terra_ratio(
    cell_days: pd.DataFrame,
    fit_window: tuple[str, str] = common.TERRA_RATIO_FIT,
    min_terra: float = MIN_RATIO_TERRA,
) -> pd.DataFrame:
    """Terra -> Terra+Aqua ratio per region and calendar month.

    Returns region, month_of_year, ratio, n_terra, fallback. A calendar month whose summed
    Terra cell-days in the fit window is below `min_terra` uses the region-wide ratio. A region
    with no Terra at all in the window gets ratio 1.0 (no scaling) and a warning.
    """
    df = cell_days.copy()
    df["month"] = _month_start(df["month"])
    start, end = _ts(fit_window[0]), _ts(fit_window[1])
    df = df[(df["month"] >= start) & (df["month"] <= end)]
    df["terra"] = df["terra"].fillna(0.0)
    df["both"] = df["terra"] + df["aqua"].fillna(0.0)
    df["month_of_year"] = df["month"].dt.month

    rows = []
    for region in sorted(cell_days["region"].unique()):
        sub = df[df["region"] == region]
        total_terra = float(sub["terra"].sum())
        if total_terra > 0:
            region_ratio = float(sub["both"].sum()) / total_terra
        else:
            log.warning("%s: no Terra cell-days in %s..%s, ratio = 1.0", region, *fit_window)
            region_ratio = 1.0
        by_moy = sub.groupby("month_of_year")[["terra", "both"]].sum()
        for moy in range(1, 13):
            n_terra = float(by_moy["terra"].get(moy, 0.0))
            if n_terra >= min_terra and n_terra > 0:
                ratio, fallback = float(by_moy["both"][moy]) / n_terra, False
            else:
                ratio, fallback = region_ratio, True
            rows.append(
                {
                    "region": region,
                    "month_of_year": moy,
                    "ratio": ratio,
                    "n_terra": n_terra,
                    "fallback": fallback,
                }
            )
    return pd.DataFrame(rows, columns=["region", "month_of_year", "ratio", "n_terra", "fallback"])


def _prepare_calibration(calibration: pd.DataFrame, regions: Iterable[str]) -> pd.DataFrame:
    cal = calibration[["region", "month_of_year", "k", "k_lo", "k_hi"]].copy()
    cal["month_of_year"] = cal["month_of_year"].astype(int)
    out = []
    for region in regions:
        sub = cal[cal["region"] == region].set_index("month_of_year")
        if sub.empty:
            raise ValueError(f"calibration has no rows for region {region!r}")
        missing = [m for m in range(1, 13) if m not in sub.index]
        if missing:
            log.warning("%s: no calibration for months %s, using region median k", region, missing)
        sub = sub.reindex(range(1, 13))
        for col in ("k", "k_lo", "k_hi"):
            sub[col] = sub[col].fillna(sub[col].median())
        sub["region"] = region
        out.append(sub.reset_index())
    cal = pd.concat(out, ignore_index=True)
    # Guard against a band that does not bracket k.
    cal["k_lo"] = np.minimum(cal["k_lo"], cal["k"])
    cal["k_hi"] = np.maximum(cal["k_hi"], cal["k"])
    return cal


def _normalize_provisional(provisional_months) -> set[tuple[str, pd.Timestamp]]:
    out = set()
    for region, month in provisional_months or ():
        out.add((region, _ts(month)))
    return out


def provisional_from_manifest(manifest: dict | Path) -> set[tuple[str, pd.Timestamp]]:
    """(region, month) pairs that rely on NRT data, from A1's RAW_DIR/manifest.json.

    For each NRT entry, months from the day after the matching SP entry (same sensor and
    country) ends through the NRT last_date are provisional. Countries map to regions via
    common.REGIONS.
    """
    if isinstance(manifest, Path):
        if not manifest.exists():
            return set()
        manifest = json.loads(manifest.read_text())
    entries = manifest.get("entries", [])
    by_country: dict[str, list[str]] = {}
    for region, meta in common.REGIONS.items():
        by_country.setdefault(meta["country"].lower(), []).append(region)

    sp_last: dict[tuple[str, str], pd.Timestamp] = {}
    for e in entries:
        if str(e.get("product", "")).upper() == "SP" and e.get("last_date"):
            k = (str(e.get("sensor")), str(e.get("country", "")).lower())
            last = pd.Timestamp(e["last_date"])
            sp_last[k] = max(sp_last.get(k, last), last)

    out: set[tuple[str, pd.Timestamp]] = set()
    for e in entries:
        if str(e.get("product", "")).upper() != "NRT":
            continue
        if not e.get("first_date") or not e.get("last_date"):
            continue
        country = str(e.get("country", "")).lower()
        first = pd.Timestamp(e["first_date"])
        sp_end = sp_last.get((str(e.get("sensor")), country))
        if sp_end is not None:
            first = max(first, sp_end + pd.Timedelta(days=1))
        last = pd.Timestamp(e["last_date"])
        if first > last:
            continue
        months = pd.period_range(first, last, freq="M").to_timestamp()
        for region in by_country.get(country, []):
            out.update((region, m) for m in months)
    return out


def splice(
    cell_days: pd.DataFrame,
    calibration: pd.DataFrame,
    switch_month: str = common.SWITCH_MONTH,
    provisional_months: set | None = None,
    *,
    today: date | None = None,
) -> pd.DataFrame:
    """Build the harmonized monthly series (contracts/monthly.md).

    cell_days: region, h3_r6, month, terra, aqua, modis, viirs, valid_days (+ optional product).
    calibration: region, month_of_year, k, k_lo, k_hi.
    provisional_months: (region, month) pairs sourced from NRT; month may be a date, Timestamp or
      'YYYY-MM'. If cell_days has a `product` column, region-months containing NRT rows are added.
    today: reference date for the current partial month (default: today). That month and any
      later month are provisional.
    """
    switch = _ts(switch_month)
    viirs_start = _ts(VIIRS_START)
    terra_start, terra_end = _ts(common.TERRA_ONLY_START), _ts(common.TERRA_ONLY_END)
    if switch < viirs_start:
        raise ValueError(f"switch_month {switch_month} is before VIIRS starts ({VIIRS_START})")

    df = cell_days.copy()
    df["month"] = _month_start(df["month"])
    for col in ("terra", "aqua", "modis", "viirs"):
        if col not in df.columns:
            df[col] = np.nan
        df[col] = df[col].astype(float)
    # modis = terra + aqua per contract; fill it where only the parts are given.
    parts = df["terra"].fillna(0.0) + df["aqua"].fillna(0.0)
    has_parts = df["terra"].notna() | df["aqua"].notna()
    df["modis"] = df["modis"].where(df["modis"].notna() | ~has_parts, parts)

    has_product = "product" in df.columns
    if df.duplicated(KEY).any():
        log.warning("cell_days has duplicate %s rows; summing counts", KEY)
        agg = {c: "sum" for c in ("terra", "aqua", "modis", "viirs")}
        agg["valid_days"] = "max"
        if has_product:
            agg["product"] = lambda s: ",".join(sorted(set(map(str, s))))
        df = df.groupby(KEY, as_index=False).agg(agg)

    provisional = _normalize_provisional(provisional_months)
    if has_product:
        nrt = df[df["product"].astype(str).str.upper().str.contains("NRT", na=False)]
        provisional.update(zip(nrt["region"], nrt["month"], strict=True))

    df = df[df["month"] >= terra_start].reset_index(drop=True)

    ratio = fit_terra_ratio(cell_days)
    cal = _prepare_calibration(calibration, df["region"].unique())
    df["month_of_year"] = df["month"].dt.month
    df = df.merge(ratio[["region", "month_of_year", "ratio"]], on=["region", "month_of_year"])
    df = df.merge(cal, on=["region", "month_of_year"], how="left")

    is_terra = (df["month"] <= terra_end) & (df["month"] < switch)
    is_viirs = df["month"] >= switch
    is_modis = ~is_terra & ~is_viirs

    # Raw columns: null outside each sensor's record.
    modis_raw = df["modis"].copy()
    record = df[df["modis"] > 0].groupby("region")["month"].agg(["min", "max"])
    lo_m = df["region"].map(record["min"])
    hi_m = df["region"].map(record["max"])
    modis_raw[~((df["month"] >= lo_m) & (df["month"] <= hi_m))] = np.nan
    viirs_raw = df["viirs"].where(df["month"] >= viirs_start)

    terra_val = df["terra"].fillna(0.0) * df["ratio"]
    modis_val = df["modis"].fillna(0.0)
    viirs_val = df["viirs"].fillna(0.0)

    harmonized = np.select([is_terra, is_modis], [terra_val, modis_val], viirs_val * df["k"])
    lo = np.select([is_terra, is_modis], [terra_val, modis_val], viirs_val * df["k_lo"])
    hi = np.select([is_terra, is_modis], [terra_val, modis_val], viirs_val * df["k_hi"])
    source = np.select([is_terra, is_modis], ["terra_scaled", "modis"], "viirs_scaled")

    current = _ts(pd.Timestamp(today or date.today()))
    prov = [
        (r, m) in provisional or m >= current
        for r, m in zip(df["region"], df["month"], strict=True)
    ]

    out = pd.DataFrame(
        {
            "region": df["region"].astype(str),
            "h3_r6": df["h3_r6"].astype(str),
            "month": df["month"],
            "modis_raw": modis_raw.astype(float),
            "viirs_raw": viirs_raw.astype(float),
            "harmonized": harmonized.astype(float),
            "harmonized_lo": lo.astype(float),
            "harmonized_hi": hi.astype(float),
            "source": source.astype(str),
            "provisional": np.asarray(prov, dtype=bool),
            "valid_days": df["valid_days"].fillna(0).astype("int32"),
        }
    )
    keep = (
        (out["harmonized"] > 0)
        | (out["modis_raw"].fillna(0) > 0)
        | (out["viirs_raw"].fillna(0) > 0)
    )
    out = out[keep].sort_values(KEY).reset_index(drop=True)
    return out[OUT_COLUMNS]


def region_totals(monthly: pd.DataFrame, region: str) -> pd.DataFrame:
    """Monthly region totals on a complete month index.

    harmonized/lo/hi missing months are 0. modis_raw/viirs_raw are 0 inside each sensor's record
    and NaN outside it.
    """
    sub = monthly[monthly["region"] == region]
    if sub.empty:
        return pd.DataFrame(
            columns=["modis_raw", "viirs_raw", "harmonized", "harmonized_lo", "harmonized_hi"]
        )
    cols = ["harmonized", "harmonized_lo", "harmonized_hi"]
    g = sub.groupby("month")
    tot = g[cols].sum()
    for raw in ("modis_raw", "viirs_raw"):
        tot[raw] = g[raw].sum(min_count=1)
    idx = pd.date_range(sub["month"].min(), sub["month"].max(), freq="MS")
    tot = tot.reindex(idx)
    tot[cols] = tot[cols].fillna(0.0)
    for raw in ("modis_raw", "viirs_raw"):
        valid = tot[raw].dropna().index
        if len(valid):
            inside = (tot.index >= valid.min()) & (tot.index <= valid.max())
            tot.loc[inside, raw] = tot.loc[inside, raw].fillna(0.0)
    tot.index.name = "month"
    return tot


def plot_seam(
    monthly: pd.DataFrame,
    region: str,
    out_path: Path,
    switch_month: str = common.SWITCH_MONTH,
) -> Path:
    """Seam chart: region-total raw MODIS, raw VIIRS and harmonized (with 90% band)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    tot = region_totals(monthly, region)
    ink, muted, grid = "#0b0b0b", "#52514e", "#e4e3df"
    fig, ax = plt.subplots(figsize=(12, 4.8), dpi=150)
    fig.patch.set_facecolor("#fcfcfb")
    ax.set_facecolor("#fcfcfb")

    if not tot.empty:
        x = tot.index
        ax.fill_between(
            x,
            tot["harmonized_lo"],
            tot["harmonized_hi"],
            color="#2a78d6",
            alpha=0.22,
            linewidth=0,
            label="Harmonized 90% band",
        )
        # Harmonized first and wider so the raw MODIS line stays visible on top of it.
        ax.plot(x, tot["harmonized"], color="#2a78d6", lw=2.6, label="Harmonized")
        ax.plot(x, tot["modis_raw"], color="#eb6834", lw=1.0, label="Raw MODIS (Terra + Aqua)")
        ax.plot(
            x, tot["viirs_raw"], color="#1baf7a", lw=1.0, label="Raw VIIRS (mean per satellite)"
        )

    ymax = ax.get_ylim()[1]
    for when, text in ((_ts(VIIRS_START), "VIIRS starts"), (_ts(switch_month), "Switch to VIIRS")):
        ax.axvline(when, color=muted, lw=1.0, ls="--")
        ax.text(when, ymax * 0.97, f" {text} ({when:%Y-%m})", color=muted, fontsize=8, va="top")

    name = common.REGIONS.get(region, {}).get("name", region)
    ax.set_title(f"{name}: MODIS / VIIRS seam", color=ink, fontsize=12, loc="left")
    ax.set_xlabel("Month", color=muted)
    ax.set_ylabel("Fire cell-days per month", color=muted)
    ax.set_ylim(bottom=0)
    ax.grid(axis="y", color=grid, lw=0.8)
    ax.tick_params(colors=muted)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(grid)
    ax.legend(loc="upper left", frameon=False, fontsize=9, labelcolor=ink)
    fig.tight_layout()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, facecolor=fig.get_facecolor())
    plt.close(fig)
    return out_path


def write_monthly(monthly: pd.DataFrame, path: Path) -> None:
    """Write monthly.parquet with month as DATE and valid_days as INTEGER."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    schema = pa.schema(
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
    df = monthly.copy()
    df["month"] = pd.to_datetime(df["month"]).dt.date
    table = pa.Table.from_pandas(df[OUT_COLUMNS], schema=schema, preserve_index=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--cell-days", type=Path, default=common.PROCESSED_DIR / "cell_days_r6_month.parquet"
    )
    p.add_argument("--calibration", type=Path, default=common.PROCESSED_DIR / "calibration.parquet")
    p.add_argument("--manifest", type=Path, default=common.RAW_DIR / "manifest.json")
    p.add_argument("--out", type=Path, default=common.PROCESSED_DIR / "monthly.parquet")
    p.add_argument("--figures-dir", type=Path, default=common.FIGURES_DIR)
    p.add_argument("--switch-month", default=common.SWITCH_MONTH)
    p.add_argument("--no-figures", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    cell_days = pd.read_parquet(args.cell_days)
    calibration = pd.read_parquet(args.calibration)
    provisional = provisional_from_manifest(args.manifest)
    monthly = splice(cell_days, calibration, args.switch_month, provisional)
    write_monthly(monthly, args.out)
    log.info("wrote %s (%d rows)", args.out, len(monthly))

    if not args.no_figures:
        for region in sorted(monthly["region"].unique()):
            path = plot_seam(
                monthly, region, args.figures_dir / f"seam_{region}.png", args.switch_month
            )
            log.info("wrote %s", path)


if __name__ == "__main__":
    main()
