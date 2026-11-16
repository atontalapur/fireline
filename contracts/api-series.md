# POST /api/series

Turns a set of cells (or a preset region) and a date range into the monthly harmonized series,
baselines, anomalies and a summary. Implemented in the app (#18) with DuckDB over
`monthly.parquet` and `coverage_month.parquet` (see `coverage.md`). The reference implementation is `build_series()` in
`contracts/make_mock.py`; `contracts/mock/series-pantanal.json` is its output for the request
below.

## Request

```json
{ "cells": null, "region": "pantanal", "start": "2000-11", "end": "2026-10", "baseline": [2003, 2022] }
```

| field | type | rules |
|---|---|---|
| cells | string[] \| null | H3 res-6 cells, hex strings. Capped (for example 50,000). All in one region |
| region | string \| null | key of `common.REGIONS` |
| start | string | `YYYY-MM`, inclusive |
| end | string | `YYYY-MM`, inclusive, `>= start` |
| baseline | [int, int] | first and last baseline year, inclusive. Default `[2003, 2022]` |

Exactly one of `cells` and `region` is non-null; otherwise 400. Cells outside every region in
`regions.geojson` also return 400.

## Response

```json
{
  "months": [
    {"month": "2024-08", "harmonized": 461.367, "lo": 437.134, "hi": 480.148,
     "modis_raw": 406.0, "viirs_raw": 1372.667, "source": "viirs_scaled", "provisional": false,
     "valid_days": 31, "baseline_median": 181.5, "baseline_mean": 215.736, "z": 3.738,
     "percentile": 95.0}
  ],
  "summary": {
    "current": {"month": "2026-10", "harmonized": 99.253, "baseline_median": 127.0,
                "ratio_to_median": 0.78, "z": -0.814, "percentile": 20.0,
                "provisional": true, "partial": true},
    "peak_month_of_year": 9,
    "peak_year": 2020,
    "annual": [{"year": 2020, "total": 2645.455, "rank": 1, "complete": true}]
  },
  "meta": {"method_version": "1.0", "area_km2": 350116.2, "cell_count": 9788,
           "warnings": ["2001-07: no satellite data (valid_days = 0)."]}
}
```

Values are from the mock. `valid_days` (per month) and `annual[].complete` are additions to the
shape in #5; every field listed there is unchanged.

### months[]

One entry per month from `start` to `end`, in order. The month axis comes from
`coverage_month.parquet`, so months with no fire rows are still listed. The range is clipped to
the region's record (first to last month of the region in `coverage_month.parquet`) with a
warning.

| field | type | null | rule |
|---|---|---|---|
| month | string | no | `YYYY-MM` |
| harmonized | number | when `valid_days = 0` | sum of `harmonized` over the selected cells; missing rows count as 0 |
| lo | number | when `valid_days = 0` | sum of `harmonized_lo` |
| hi | number | when `valid_days = 0` | sum of `harmonized_hi` |
| modis_raw | number | when `valid_days = 0` or no MODIS that month | sum of `modis_raw` |
| viirs_raw | number | when `valid_days = 0` or no VIIRS that month (before 2012) | sum of `viirs_raw` |
| source | string | no | region-level `source`; for a month with no rows, the splice table value for that month |
| provisional | boolean | no | region-level `provisional`; false for a month with no rows |
| valid_days | integer | no | `coverage_month.valid_days` |
| baseline_median | number | when no baseline months | median of `harmonized` for this calendar month over the baseline years |
| baseline_mean | number | when no baseline months | mean of the same values |
| z | number | when `harmonized` is null or MAD = 0 | robust z = (x - median) / (1.4826 x MAD) |
| percentile | number | when `harmonized` is null or no baseline months | 0-100, see below |

Units: MODIS-equivalent fire cell-days summed over the area (`modis_raw` and `viirs_raw` are raw
cell-days of their sensor).

Zero versus missing: a month with `coverage_month.valid_days = 0` is missing (all counts null).
Any other month with no rows for the selected cells is zero. Sensor availability (`modis_raw` /
`viirs_raw` null versus 0) also comes from `coverage_month`: `modis_raw` is null when
`modis_valid_days = 0`, `viirs_raw` when `viirs_valid_days = 0`.

### Baseline

- Baseline values: the area's monthly `harmonized` for the same calendar month in each baseline
  year, taken from the full record (not limited to `start`/`end`). Months with `valid_days = 0`
  are left out, so n can be below 20.
- Median: the usual median (mean of the two middle values when n is even).
- MAD: median of |b - median| over the baseline values.
- If MAD = 0 for a calendar month, `z` is null for that month and a warning is added.
- Percentile: `100 x (count(b < x) + 0.5 x count(b == x)) / n`, where b are the baseline values
  (including x itself when the month is in the baseline years).

### summary

- `current`: the last month in the range.
  - `ratio_to_median` = harmonized / baseline_median, rounded to 2 decimals; null if either is
    null or the median is 0.
  - `partial` = `valid_days` < days in that month.
  - Other fields are copied from that month's entry.
- `peak_month_of_year`: calendar month (1-12) with the highest baseline mean. Ties go to the
  earlier month.
- `peak_year`: the year with `rank = 1`, or null if no year is complete.
- `annual`: one entry per calendar year that has any month in the range.
  - `total` = sum of non-null `harmonized` over that year's months in the range.
  - `complete` = all 12 months are in the range and none has `valid_days = 0`.
  - `rank` = 1 + number of complete years with a larger total (ties share a rank); null for
    incomplete years.

### meta

| field | type | rule |
|---|---|---|
| method_version | string | `common.METHOD_VERSION` |
| area_km2 | number | sum of H3 cell areas (km²) of the area, 1 decimal |
| cell_count | integer | number of cells in the area |
| warnings | string[] | human-readable notes: no-data months, MAD = 0, clipped range, provisional months |

For a `cells` request the area is the given cells. For a `region` request it is every res-6 cell
whose center falls in the region polygon (the mock uses the bbox from `common.REGIONS`).

### Numbers

Floats are rounded to 3 decimals (`percentile` to 1, `ratio_to_median` to 2, `area_km2` to 1).
JSON never contains `NaN`; missing values are `null`. A route test against the mock should
compare numbers with an absolute tolerance of 1e-3.
