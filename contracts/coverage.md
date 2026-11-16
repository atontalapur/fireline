# coverage_month.parquet

Region-month data availability. Written by `pipeline/cell_days.py` (#8) to
`processed/coverage_month.parquet`, published as `public/v1/coverage_month.parquet`. Mock:
`contracts/mock/coverage_month.parquet`.

`monthly.parquet` stores only cells with fire, so it cannot say whether a month without rows had
no fire or no data. This table answers that.

| column | type | null | notes |
|---|---|---|---|
| region | VARCHAR | no | key of `common.REGIONS` |
| month | DATE | no | first day of month |
| valid_days | INTEGER | no | days in the month with any satellite operating in the region |
| modis_valid_days | INTEGER | no | days with Terra or Aqua operating |
| viirs_valid_days | INTEGER | no | days with at least one VIIRS satellite operating |

One row for every region and every month from 2000-11 (`common.TERRA_ONLY_START`) through the
last month with data, including months with zero fire. Primary key: (region, month). Sort order:
region, month. All counts are 0 to days in month, and `modis_valid_days` and `viirs_valid_days`
are each `<= valid_days`.

Parquet physical types: `month` is `date32`, the three counts are `int32`.

The counts are rolled up from `coverage_day.parquet` (region, local_date, sensor, operating) with
the same definitions as the `valid_days`, `modis_valid_days` and `viirs_valid_days` columns of
`cell_days_r6_month.parquet`. `monthly.valid_days` repeats `valid_days` for every row of the
region-month.

## Reading rule

For a region-month:

- `valid_days = 0`: no data. Show it as missing, not zero.
- `valid_days > 0` and no `monthly` row for a cell: zero fire in that cell.
- `modis_valid_days = 0` (or `viirs_valid_days = 0`): that sensor family had no data, so its raw
  series is null, not zero.
- `valid_days` below the days in the month: partial month (NRT gaps or the current month).

## Example (DuckDB)

```sql
SELECT month, valid_days
FROM read_parquet('contracts/mock/coverage_month.parquet')
WHERE region = 'pantanal' AND valid_days < day(last_day(month))
ORDER BY month;
```

## Mock

`contracts/make_mock.py` writes 312 rows for `pantanal`, 2000-11 to 2026-10: full months
everywhere except 2001-07 (`valid_days = 0`) and 2026-10 (`valid_days = 28`).
`viirs_valid_days` is 0 before 2012-01.
