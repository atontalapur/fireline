# monthly.parquet

The harmonized series at H3 res-6 x month. Written by `pipeline/splice.py` (#10) to
`processed/monthly.parquet`, published as `public/v1/monthly.parquet`. Mock:
`contracts/mock/monthly.parquet`.

Unit: **fire cell-days**. One fire cell-day is one H3 res-8 cell (~0.74 km²) with at least one
detection from one satellite on one local solar day. Monthly values are sums of cell-days over
the res-8 children of the res-6 cell.

| column | type | null | notes |
|---|---|---|---|
| region | VARCHAR | no | `pantanal`, `w_canada`, `punjab` (keys of `common.REGIONS`) |
| h3_r6 | VARCHAR | no | H3 res-6 cell, lowercase hex string |
| month | DATE | no | first day of month |
| modis_raw | DOUBLE | yes | Terra + Aqua fire cell-days. Null when no MODIS satellite had data that month |
| viirs_raw | DOUBLE | yes | mean VIIRS fire cell-days across the VIIRS satellites operating each day. Null before 2012-01 |
| harmonized | DOUBLE | no | MODIS-equivalent fire cell-days |
| harmonized_lo | DOUBLE | no | lower end of the 90% band (k_lo x viirs_raw) |
| harmonized_hi | DOUBLE | no | upper end of the 90% band (k_hi x viirs_raw) |
| source | VARCHAR | no | `terra_scaled`, `modis`, `viirs_scaled` (see splice table) |
| provisional | BOOLEAN | no | NRT-sourced month, or the current incomplete month |
| valid_days | INTEGER | no | region-level days with satellite data that month; same value as `coverage_month.valid_days` |

Parquet physical types: `month` is `date32` (not a timestamp), `valid_days` is `int32`. A pandas
`datetime64` or `int64` column must be cast before writing, or DuckDB reads it as `TIMESTAMP` /
`BIGINT`.

Primary key: (region, h3_r6, month). Sort order: region, month, h3_r6.

## Splice table

| period | harmonized | lo / hi | source |
|---|---|---|---|
| 2000-11 to 2002-06 | Terra x (Terra+Aqua)/Terra ratio by calendar month, fitted 2002-07 to 2007-12 | = harmonized | `terra_scaled` |
| 2002-07 to 2019-12 | observed MODIS (= modis_raw) | = harmonized | `modis` |
| 2020-01 onward | k x viirs_raw, k from `calibration.parquet` for (region, calendar month) | k_lo x viirs_raw, k_hi x viirs_raw | `viirs_scaled` |

The switch month is `common.SWITCH_MONTH` (default 2020-01). In `terra_scaled` months
`modis_raw` holds Terra only. After MODIS ends in 2027 `modis_raw` becomes null and the series
continues on VIIRS with no code change.

Invariant: `harmonized_lo <= harmonized <= harmonized_hi`. Outside `viirs_scaled` all three are
equal.

## Sparse storage and zero

Only cells with any fire (modis_raw > 0 or viirs_raw > 0) are stored. A region-month with no
fire cell, or with no satellite data, has no rows here. Its valid days are in
`coverage_month.parquet` (see `coverage.md`), which has one row for every region-month.

**A missing row means zero fire, unless `coverage_month.valid_days = 0` for that region-month.**
In that case the month has no data and must be shown as missing, not zero.

`valid_days`, `source` and `provisional` are region-level: every row of a region-month carries
the same values. Use `coverage_month` for the month axis and for valid days, not
`GROUP BY month` over this file, which skips months without fire.

## Example (DuckDB)

```sql
SELECT c.month,
       CASE WHEN c.valid_days = 0 THEN NULL ELSE coalesce(sum(m.harmonized), 0) END
           AS harmonized,
       c.valid_days
FROM read_parquet('contracts/mock/coverage_month.parquet') c
LEFT JOIN read_parquet('contracts/mock/monthly.parquet') m USING (region, month)
WHERE c.region = 'pantanal'
GROUP BY c.month, c.valid_days
ORDER BY c.month;
```

## Mock

`contracts/make_mock.py` writes a seeded synthetic file for `pantanal`: 60 real res-6 cells in
the region bbox, 2000-11 to 2026-10, dry-season peak in Aug-Sep, raw VIIRS from 2012-01 at about
3-5x MODIS, a 2020 record year, one month with data but no fire (2005-02, no rows,
`valid_days = 28`), one no-data month (2001-07, no rows, `valid_days = 0`) and a provisional last
month (2026-10, `valid_days = 28`). The matching coverage is `contracts/mock/coverage_month.parquet`.
The numbers are not real fire data.
