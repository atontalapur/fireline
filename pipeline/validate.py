"""Validation metrics for the MODIS + VIIRS harmonization (issue #11).

Reads PROCESSED_DIR/cell_days_r6_month.parquet (plus calibration.parquet and monthly.parquet
when present) and writes PROCESSED_DIR/validation.json with, per region:

- overlap bias: mean VIIRS/MODIS (raw) and mean (k x VIIRS)/MODIS (harmonized) over the fit
  years, at region-month level. Harmonized here is k x VIIRS, not the spliced series, because
  the spliced series is observed MODIS in those years and the test would be trivial.
- leave-one-year-out: refit k without year y, predict MODIS for y from VIIRS. Pearson r on
  log1p monthly region counts and NRMSE = RMSE / mean(MODIS).
- forward test: fit on the fit years, predict MODIS from SWITCH_MONTH to FORWARD_END.
- seam test: ratio of the 12-month harmonized means either side of the switch month and a
  Pettitt change-point p-value on the deseasonalized series around it, repeated on placebo dates.
- peak-month match: share of overlap years where k x VIIRS and MODIS peak in the same month.

Every metric function takes the fit function as an argument so it can be tested without
calibrate.py. Nothing is filtered out for looking bad.
"""

from __future__ import annotations

import argparse
import functools
import json
import math
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

import common

FitFn = Callable[..., pd.DataFrame]

# Local validation settings (not method parameters, so they live here, not in common.py).
FORWARD_END = "2025-12"
PLACEBO_MONTHS = ("2008-01", "2015-01", "2023-01")
SEAM_RATIO_WINDOW = 12  # months either side for the mean ratio
SEAM_TEST_WINDOW = 24  # months either side for the change-point test
LOYO_N_BOOT = 50  # refits only need k, not the bootstrap band
PELT_MIN_SIZE = 3

CELL_DAYS_PATH = common.PROCESSED_DIR / "cell_days_r6_month.parquet"
CALIBRATION_PATH = common.PROCESSED_DIR / "calibration.parquet"
MONTHLY_PATH = common.PROCESSED_DIR / "monthly.parquet"
OUTPUT_PATH = common.PROCESSED_DIR / "validation.json"


# ---------------------------------------------------------------------------
# Helpers


def _to_month(values) -> pd.Series:
    """Normalize a date-like column to month-start Timestamps."""
    return pd.to_datetime(pd.Series(values)).dt.to_period("M").dt.to_timestamp()


def _month_str(ts: pd.Timestamp) -> str:
    return pd.Timestamp(ts).strftime("%Y-%m")


def _month_ts(month: str) -> pd.Timestamp:
    return pd.Period(month, freq="M").to_timestamp()


def region_month_totals(
    df: pd.DataFrame,
    cols: Iterable[str],
    start: str | None = None,
    end: str | None = None,
) -> pd.DataFrame:
    """Sum `cols` over cells to region x month, filling months with no rows as 0.

    The month grid per region runs from `start` (or the region's first month) to `end` (or its
    last month). Missing rows mean no detections, so they count as zero.
    """
    cols = list(cols)
    d = df[["region", "month", *cols]].copy()
    d["month"] = _to_month(d["month"]).values
    g = d.groupby(["region", "month"], as_index=False)[cols].sum(min_count=0)
    out = []
    for region, part in g.groupby("region"):
        lo = _month_ts(start) if start else part["month"].min()
        hi = _month_ts(end) if end else part["month"].max()
        grid = pd.date_range(lo, hi, freq="MS")
        part = part.set_index("month").reindex(grid)
        part.index.name = "month"
        part[cols] = part[cols].fillna(0.0)
        part["region"] = region
        out.append(part.reset_index())
    if not out:
        return pd.DataFrame(columns=["region", "month", *cols])
    return pd.concat(out, ignore_index=True)[["region", "month", *cols]]


def apply_k(rm: pd.DataFrame, calibration: pd.DataFrame) -> pd.DataFrame:
    """Add month_of_year, k and pred = k x viirs to a region-month table."""
    out = rm.copy()
    out["month_of_year"] = pd.to_datetime(out["month"]).dt.month
    cal = calibration[["region", "month_of_year", "k"]].copy()
    cal["month_of_year"] = cal["month_of_year"].astype(int)
    out = out.merge(cal, on=["region", "month_of_year"], how="left")
    out["pred"] = out["k"] * out["viirs"]
    return out


def _year_range(years: Iterable[int]) -> tuple[str, str]:
    years = sorted(years)
    return f"{years[0]}-01", f"{years[-1]}-12"


def _filter_years(df: pd.DataFrame, years: Iterable[int]) -> pd.DataFrame:
    yrs = set(int(y) for y in years)
    return df[pd.to_datetime(df["month"]).dt.year.isin(yrs)]


def pearson_r(x, y) -> float:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 3 or np.std(x) == 0 or np.std(y) == 0:
        return float("nan")
    return float(np.corrcoef(x, y)[0, 1])


def nrmse(pred, obs) -> float:
    pred = np.asarray(pred, dtype=float)
    obs = np.asarray(obs, dtype=float)
    if len(obs) == 0 or obs.mean() == 0:
        return float("nan")
    return float(np.sqrt(np.mean((pred - obs) ** 2)) / obs.mean())


def _fit_scores(pred: pd.DataFrame) -> dict:
    """r on log1p, NRMSE and pooled bias for rows with a prediction."""
    ok = pred.dropna(subset=["pred", "modis"])
    pooled = ok["modis"].sum()
    return {
        "r": pearson_r(np.log1p(ok["pred"]), np.log1p(ok["modis"])),
        "nrmse": nrmse(ok["pred"], ok["modis"]),
        "bias_pooled": float(ok["pred"].sum() / pooled) if pooled > 0 else float("nan"),
        "n_months": int(len(ok)),
        "n_missing_k": int(len(pred) - len(ok)),
    }


# ---------------------------------------------------------------------------
# Metrics


def overlap_bias(
    cell_days: pd.DataFrame, calibration: pd.DataFrame, years: Iterable[int] = common.FIT_YEARS
) -> dict[str, dict]:
    """Raw VIIRS/MODIS vs harmonized (k x VIIRS)/MODIS at region-month level.

    Means are over region-months with MODIS > 0 (the ratio is undefined otherwise). Pooled
    ratios (sum over sum) are reported alongside because the mean is sensitive to small months.
    """
    years = tuple(years)
    start, end = _year_range(years)
    rm = region_month_totals(_filter_years(cell_days, years), ["modis", "viirs"], start, end)
    rm = apply_k(rm, calibration)
    out = {}
    for region, part in rm.groupby("region"):
        pos = part[part["modis"] > 0]
        harm = pos.dropna(subset=["pred"])
        modis_sum = pos["modis"].sum()
        out[region] = {
            "raw_bias": float((pos["viirs"] / pos["modis"]).mean()) if len(pos) else float("nan"),
            "harmonized_bias": float((harm["pred"] / harm["modis"]).mean())
            if len(harm)
            else float("nan"),
            "raw_bias_pooled": float(pos["viirs"].sum() / modis_sum)
            if modis_sum > 0
            else float("nan"),
            "harmonized_bias_pooled": float(harm["pred"].sum() / harm["modis"].sum())
            if harm["modis"].sum() > 0
            else float("nan"),
            "bias_n_months": int(len(pos)),
            "bias_period": [start, end],
        }
    return out


def loyo_predictions(
    cell_days: pd.DataFrame, fit_fn: FitFn, years: Iterable[int] = common.FIT_YEARS
) -> pd.DataFrame:
    """For each year y, refit on the other years and predict MODIS for y from VIIRS.

    fit_fn is called as fit_fn(cell_days_without_y, fit_years=other_years). Year y is removed
    from both the data and fit_years so it cannot leak into the fit.
    """
    years = tuple(int(y) for y in years)
    cd_years = pd.to_datetime(cell_days["month"]).dt.year
    preds = []
    for y in years:
        others = tuple(t for t in years if t != y)
        train = cell_days[cd_years.isin(others)]
        cal = fit_fn(train, fit_years=others)
        test = region_month_totals(cell_days[cd_years == y], ["modis", "viirs"], *_year_range([y]))
        test = apply_k(test, cal)
        test["held_out_year"] = y
        preds.append(test)
    return pd.concat(preds, ignore_index=True)


def loyo(
    cell_days: pd.DataFrame,
    fit_fn: FitFn,
    years: Iterable[int] = common.FIT_YEARS,
    pred: pd.DataFrame | None = None,
) -> dict[str, dict]:
    """Leave-one-year-out scores per region. Pass `pred` to reuse loyo_predictions output."""
    years = tuple(int(y) for y in years)
    if pred is None:
        pred = loyo_predictions(cell_days, fit_fn, years)
    out = {}
    for region, part in pred.groupby("region"):
        s = _fit_scores(part)
        out[region] = {
            "loyo_r": s["r"],
            "loyo_nrmse": s["nrmse"],
            "loyo_bias_pooled": s["bias_pooled"],
            "loyo_n_months": s["n_months"],
            "loyo_n_missing_k": s["n_missing_k"],
            "loyo_years": list(years),
        }
    return out


def forward_predictions(
    cell_days: pd.DataFrame,
    calibration: pd.DataFrame,
    start: str = common.SWITCH_MONTH,
    end: str = FORWARD_END,
) -> pd.DataFrame:
    """Predict MODIS from VIIRS for months start..end with a calibration fit before start."""
    month = _to_month(cell_days["month"])
    sel = cell_days[((month >= _month_ts(start)) & (month <= _month_ts(end))).values]
    rm = region_month_totals(sel, ["modis", "viirs"], start, end)
    return apply_k(rm, calibration)


def forward_test(
    cell_days: pd.DataFrame,
    fit_fn: FitFn,
    fit_years: Iterable[int] = common.FIT_YEARS,
    start: str = common.SWITCH_MONTH,
    end: str = FORWARD_END,
    calibration: pd.DataFrame | None = None,
) -> dict[str, dict]:
    """Fit on fit_years (or reuse `calibration`), predict MODIS after the switch month.

    MODIS orbit drift after 2020 shows up here as a bias; it is reported, not corrected.
    """
    fit_years = tuple(int(y) for y in fit_years)
    if calibration is None:
        calibration = fit_fn(_filter_years(cell_days, fit_years), fit_years=fit_years)
    pred = forward_predictions(cell_days, calibration, start, end)
    out = {}
    for region, part in pred.groupby("region"):
        s = _fit_scores(part)
        out[region] = {
            "forward_r": s["r"],
            "forward_nrmse": s["nrmse"],
            "forward_bias_pooled": s["bias_pooled"],
            "forward_n_months": s["n_months"],
            "forward_fit_years": list(fit_years),
            "forward_period": [start, end],
        }
    return out


def pettitt_test(x) -> tuple[float, int | None]:
    """Pettitt (1979) non-parametric change-point test.

    Returns (p, t) where t is the index of the first element after the most likely change
    point, or None when the series has fewer than 3 values. p uses the usual approximation
    2 exp(-6 K^2 / (n^3 + n^2)), capped at 1.
    """
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    n = len(x)
    if n < 3:
        return float("nan"), None
    v = np.sign(x[:, None] - x[None, :]).sum(axis=1)
    u = np.cumsum(v)[:-1]
    t = int(np.argmax(np.abs(u)))
    k = float(np.abs(u[t]))
    p = min(1.0, 2.0 * math.exp(-6.0 * k**2 / (n**3 + n**2)))
    return p, t + 1


def pelt_breaks(x, pen: float | None = None) -> list[int]:
    """PELT change points (indices of the first element of each new segment), l2 cost."""
    x = np.asarray(x, dtype=float)
    if len(x) < 2 * PELT_MIN_SIZE or np.std(x) == 0:
        return []
    import ruptures as rpt

    if pen is None:
        pen = 3.0 * math.log(len(x)) * float(np.var(x))
    bkps = rpt.Pelt(model="l2", min_size=PELT_MIN_SIZE).fit(x.reshape(-1, 1)).predict(pen=pen)
    return [int(b) for b in bkps if b < len(x)]


def seam_test(
    series: pd.Series,
    at: str,
    ratio_window: int = SEAM_RATIO_WINDOW,
    test_window: int = SEAM_TEST_WINDOW,
) -> dict:
    """Seam diagnostics for a monthly series (index = month-start Timestamps) at month `at`.

    seam_ratio = mean of the `ratio_window` months from `at` / mean of the `ratio_window`
    months before it. The change-point tests run on log1p values within +-`test_window`
    months, with the calendar-month mean removed so the fire season is not read as a step.
    A low p says the window has a step somewhere; changepoint_month says where.
    """
    s = series.sort_index().astype(float)
    t0 = _month_ts(at)
    before = s[(s.index >= t0 - pd.DateOffset(months=ratio_window)) & (s.index < t0)]
    after = s[(s.index >= t0) & (s.index < t0 + pd.DateOffset(months=ratio_window))]
    res = {
        "month": at,
        "seam_ratio": float("nan"),
        "changepoint_p": float("nan"),
        "changepoint_month": None,
        "pelt_breaks": [],
        "n_before": int(len(before)),
        "n_after": int(len(after)),
        "ratio_window_months": ratio_window,
        "test_window_months": test_window,
    }
    if len(before) == ratio_window and len(after) == ratio_window and before.mean() > 0:
        res["seam_ratio"] = float(after.mean() / before.mean())

    win = s[
        (s.index >= t0 - pd.DateOffset(months=test_window))
        & (s.index < t0 + pd.DateOffset(months=test_window))
    ]
    res["test_n_months"] = int(len(win))
    has_both_sides = (win.index < t0).sum() >= 12 and (win.index >= t0).sum() >= 12
    if not has_both_sides:
        return res
    logv = np.log1p(win)
    resid = logv - logv.groupby(win.index.month).transform("mean")
    p, idx = pettitt_test(resid.values)
    res["changepoint_p"] = p
    if idx is not None:
        res["changepoint_month"] = _month_str(win.index[idx])
    try:
        res["pelt_breaks"] = [_month_str(win.index[b]) for b in pelt_breaks(resid.values)]
    except ImportError:
        res["pelt_breaks"] = None
    return res


def harmonized_series(monthly: pd.DataFrame) -> dict[str, pd.Series]:
    """Region-total harmonized monthly series from monthly.parquet rows."""
    rm = region_month_totals(monthly, ["harmonized"])
    return {r: p.set_index("month")["harmonized"] for r, p in rm.groupby("region")}


def seam_metrics(
    monthly: pd.DataFrame,
    switch_month: str = common.SWITCH_MONTH,
    placebos: Iterable[str] = PLACEBO_MONTHS,
) -> dict[str, dict]:
    out = {}
    for region, s in harmonized_series(monthly).items():
        main = seam_test(s, switch_month)
        out[region] = {
            "seam_ratio": main["seam_ratio"],
            "changepoint_p": main["changepoint_p"],
            "changepoint_month": main["changepoint_month"],
            "seam": main,
            "placebo": [seam_test(s, m) for m in placebos],
        }
    return out


def peak_month_match(
    pred: pd.DataFrame, years: Iterable[int] = common.FIT_YEARS
) -> dict[str, dict]:
    """Share of years where pred (k x VIIRS) and MODIS peak in the same calendar month.

    Years with no MODIS detections or no prediction are skipped and not counted.
    """
    years = set(int(y) for y in years)
    p = pred.copy()
    p["year"] = pd.to_datetime(p["month"]).dt.year
    p = p[p["year"].isin(years)]
    out = {}
    for region, part in p.groupby("region"):
        rows = []
        for year, yr in part.groupby("year"):
            if yr["modis"].sum() <= 0 or yr["pred"].isna().all():
                continue
            m_peak = int(pd.to_datetime(yr.loc[yr["modis"].idxmax(), "month"]).month)
            h_peak = int(pd.to_datetime(yr.loc[yr["pred"].idxmax(), "month"]).month)
            rows.append(
                {
                    "year": int(year),
                    "modis_peak": m_peak,
                    "harmonized_peak": h_peak,
                    "match": m_peak == h_peak,
                }
            )
        n = len(rows)
        out[region] = {
            "peak_month_match": float(sum(r["match"] for r in rows) / n) if n else float("nan"),
            "peak_month_n_years": n,
            "peak_month_years": rows,
        }
    return out


# ---------------------------------------------------------------------------
# Figures


def scatter_figure(insample: pd.DataFrame, forward: pd.DataFrame, region: str, path: Path) -> Path:
    """Log-log scatter of k x VIIRS vs MODIS monthly totals with a 1:1 line.

    Months where either value is 0 cannot sit on log axes; their count is shown in the legend.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(5.5, 5.5), dpi=150)
    lims = []
    series = [
        (insample, "Overlap (in-sample)", "#2a78d6", "o"),
        (forward, "Forward test", "#eb6834", "^"),
    ]
    for df, label, color, marker in series:
        d = df[df["region"] == region].dropna(subset=["pred"])
        pos = d[(d["pred"] > 0) & (d["modis"] > 0)]
        dropped = len(d) - len(pos)
        if pos.empty:
            continue
        r = pearson_r(np.log1p(d["pred"]), np.log1p(d["modis"]))
        span = f"{_month_str(d['month'].min())} to {_month_str(d['month'].max())}"
        text = f"{label}, {span}: n={len(pos)}, r(log1p)={r:.2f}"
        if dropped:
            text += f", {dropped} zero months not shown"
        ax.scatter(
            pos["modis"],
            pos["pred"],
            s=22,
            c=color,
            marker=marker,
            alpha=0.75,
            edgecolors="white",
            linewidths=0.6,
            label=text,
        )
        lims += [pos["modis"].min(), pos["modis"].max(), pos["pred"].min(), pos["pred"].max()]
    if lims:
        lo, hi = min(lims) / 1.5, max(lims) * 1.5
        ax.plot([lo, hi], [lo, hi], color="#6b6a63", lw=1.2, ls="--", label="1:1")
        ax.set_xlim(lo, hi)
        ax.set_ylim(lo, hi)
        ax.set_xscale("log")
        ax.set_yscale("log")
    name = common.REGIONS.get(region, {}).get("name", region)
    ax.set_title(f"{name}: harmonized VIIRS vs MODIS", fontsize=11)
    ax.set_xlabel("MODIS fire cell-days per month")
    ax.set_ylabel("k x VIIRS fire cell-days per month")
    ax.grid(True, which="major", color="#e4e3dd", lw=0.6)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.legend(fontsize=7, loc="upper left", frameon=False)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# Assembly and output


def to_jsonable(obj):
    """Convert numpy/pandas scalars to Python types and NaN/inf to None."""
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, (pd.Timestamp, datetime)):
        return obj.isoformat()
    if obj is None or isinstance(obj, str):
        return obj
    if pd.isna(obj):
        return None
    return obj


def validate(
    cell_days: pd.DataFrame,
    fit_fn: FitFn,
    calibration: pd.DataFrame,
    monthly: pd.DataFrame,
    fit_years: Iterable[int] = common.FIT_YEARS,
    switch_month: str = common.SWITCH_MONTH,
    forward_end: str = FORWARD_END,
    placebos: Iterable[str] = PLACEBO_MONTHS,
    figures_dir: Path | None = None,
) -> dict:
    """Compute every metric and return the validation.json payload (before NaN -> null)."""
    fit_years = tuple(int(y) for y in fit_years)
    placebos = tuple(placebos)
    start, end = _year_range(fit_years)

    bias = overlap_bias(cell_days, calibration, fit_years)
    loyo_pred = loyo_predictions(cell_days, fit_fn, fit_years)
    lo = loyo(cell_days, fit_fn, fit_years, pred=loyo_pred)
    fwd = forward_test(cell_days, fit_fn, fit_years, switch_month, forward_end, calibration)
    seam = seam_metrics(monthly, switch_month, placebos)

    insample = apply_k(
        region_month_totals(_filter_years(cell_days, fit_years), ["modis", "viirs"], start, end),
        calibration,
    )
    peaks = peak_month_match(insample, fit_years)
    loyo_peaks = peak_month_match(loyo_pred, fit_years)
    forward = forward_predictions(cell_days, calibration, switch_month, forward_end)

    regions = sorted(set(cell_days["region"].unique()) | set(monthly["region"].unique()))
    out_regions = {}
    for region in regions:
        entry: dict = {}
        for part in (bias, lo, fwd, seam, peaks):
            entry.update(part.get(region, {}))
        entry.setdefault("placebo", [])
        entry["peak_month_match_loyo"] = loyo_peaks.get(region, {}).get(
            "peak_month_match", float("nan")
        )
        figures: dict = {"scatter": None, "seam": None}
        if figures_dir is not None:
            scatter_path = figures_dir / f"scatter_{region}.png"
            scatter_figure(insample, forward, region, scatter_path)
            figures["scatter"] = f"figures/{scatter_path.name}"
            seam_path = figures_dir / f"seam_{region}.png"
            if seam_path.exists():
                figures["seam"] = f"figures/{seam_path.name}"
        entry["figures"] = figures
        out_regions[region] = entry

    return {
        "method_version": common.METHOD_VERSION,
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fit_years": list(fit_years),
        "fit_period": [start, end],
        "switch_month": switch_month,
        "forward_period": [switch_month, forward_end],
        "placebo_months": list(placebos),
        "notes": {
            "unit": "fire cell-days summed to region x month",
            "harmonized_bias": "in the overlap, harmonized = k x VIIRS, not the spliced series",
            "loyo": "r is Pearson on log1p monthly counts; nrmse = RMSE / mean(MODIS)",
            "changepoint_p": "Pettitt test on deseasonalized log1p harmonized, "
            f"+-{SEAM_TEST_WINDOW} months around the date",
        },
        "regions": out_regions,
    }


def write_json(payload: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(to_jsonable(payload), indent=2, allow_nan=False) + "\n")
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cell-days", type=Path, default=CELL_DAYS_PATH)
    ap.add_argument(
        "--calibration",
        type=Path,
        default=CALIBRATION_PATH,
        help="read if it exists, else fit from cell days",
    )
    ap.add_argument(
        "--monthly",
        type=Path,
        default=MONTHLY_PATH,
        help="read if it exists, else spliced from cell days",
    )
    ap.add_argument("--out", type=Path, default=OUTPUT_PATH)
    ap.add_argument("--figures-dir", type=Path, default=common.FIGURES_DIR)
    ap.add_argument("--no-figures", action="store_true")
    ap.add_argument(
        "--loyo-n-boot",
        type=int,
        default=LOYO_N_BOOT,
        help="bootstrap draws per refit; refits only use k",
    )
    args = ap.parse_args()

    from calibrate import fit_calibration

    common.ensure_dirs()
    cell_days = pd.read_parquet(args.cell_days)
    fit_fn = functools.partial(fit_calibration, n_boot=args.loyo_n_boot)

    if args.calibration.exists():
        calibration = pd.read_parquet(args.calibration)
    else:
        calibration = fit_calibration(cell_days)
    if args.monthly.exists():
        monthly = pd.read_parquet(args.monthly)
    else:
        from splice import splice

        monthly = splice(cell_days, calibration)

    payload = validate(
        cell_days,
        fit_fn,
        calibration,
        monthly,
        figures_dir=None if args.no_figures else args.figures_dir,
    )
    write_json(payload, args.out)
    for region, m in payload["regions"].items():
        print(
            f"{region}: raw_bias={m.get('raw_bias')} harmonized_bias={m.get('harmonized_bias')} "
            f"loyo_r={m.get('loyo_r')} loyo_nrmse={m.get('loyo_nrmse')} "
            f"forward_r={m.get('forward_r')} seam_ratio={m.get('seam_ratio')} "
            f"changepoint_p={m.get('changepoint_p')} peak_match={m.get('peak_month_match')}"
        )
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
