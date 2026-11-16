# calibration.parquet

VIIRS-to-MODIS scale factors. Written by `pipeline/calibrate.py` (#9) to
`processed/calibration.parquet`, published as `public/v1/calibration.parquet`. Mock:
`contracts/mock/calibration.parquet`.

| column | type | null | notes |
|---|---|---|---|
| region | VARCHAR | no | key of `common.REGIONS` |
| month_of_year | INTEGER | no | calendar month, 1-12 |
| k | DOUBLE | no | MODIS cell-days per VIIRS cell-day, shrunk toward the region-wide k |
| k_lo | DOUBLE | no | 5th percentile of the year bootstrap |
| k_hi | DOUBLE | no | 95th percentile of the year bootstrap |
| n_years | INTEGER | no | fit years with data for this calendar month |

One row per (region, month_of_year): 12 rows per region. `k_lo <= k <= k_hi`. `month_of_year`
and `n_years` are `int32` in Parquet.

## Method

- Fit window: `common.FIT_START` to `common.FIT_END` (2012-01 to 2019-12).
- Raw ratio: k_s = sum(MODIS cell-days) / sum(VIIRS cell-days) over the stratum. No intercept, so
  zero VIIRS gives zero harmonized.
- Shrinkage: k = (n x k_s + n0 x k_region) / (n + n0), n = MODIS cell-days in the stratum,
  n0 = `common.SHRINK_N0`.
- Band: resample whole fit years `common.N_BOOT` times with seed `common.BOOT_SEED`.

Expected values are roughly 0.15-0.5 (raw VIIRS sees 2-6x more fire cell-days than MODIS).

Because k is one value per region-month, a sum of `k_lo x viirs_raw` over many cells equals
`k_lo x sum(viirs_raw)`, so the API can sum `harmonized_lo` / `harmonized_hi` across cells and
keep a valid 90% band.
