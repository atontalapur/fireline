# validation.json

Harmonization metrics per region. Written by `pipeline/validate.py` (#11) to
`processed/validation.json`, published as `public/v1/validation.json`. Read by the method page
(#22).

```json
{
  "method_version": "1.0",
  "regions": {
    "pantanal": {
      "raw_bias": 3.9,
      "harmonized_bias": 1.02,
      "loyo_r": 0.94,
      "loyo_nrmse": 0.21,
      "forward_r": 0.88,
      "seam_ratio": 1.05,
      "changepoint_p": 0.41,
      "placebo": [
        {"date": "2015-01", "seam_ratio": 0.97, "changepoint_p": 0.55}
      ],
      "peak_month_match": 0.875,
      "figures": {
        "seam": "figures/seam_pantanal.png",
        "scatter": "figures/scatter_pantanal.png"
      }
    }
  }
}
```

The numbers above are illustrative only.

## Fields

`method_version` (string): `common.METHOD_VERSION`.

`regions` (object): one entry per key of `common.REGIONS`, including regions whose metrics look
bad. Each entry:

| field | type | null | meaning |
|---|---|---|---|
| raw_bias | number | yes | mean monthly VIIRS / MODIS ratio, region level, over the fit years (months with MODIS > 0). Expect about 3-6 |
| harmonized_bias | number | yes | same, with k x VIIRS in place of VIIRS. Expect about 1 |
| loyo_r | number | yes | leave-one-year-out over the fit years: Pearson r of log1p(predicted) vs log1p(MODIS), monthly |
| loyo_nrmse | number | yes | leave-one-year-out RMSE divided by the mean observed monthly MODIS |
| forward_r | number | yes | fit on 2012-2019, predict 2020-2025 MODIS; Pearson r on log1p monthly counts. Lower values reflect Terra/Aqua orbit drift |
| seam_ratio | number | yes | mean harmonized in the 12 months from the switch month / mean in the 12 months before. 1 = no step |
| changepoint_p | number | yes | p-value of the change-point test at the switch month. High = no detected step |
| placebo | array | no | same seam test at 2-3 dates with no sensor change; may be empty |
| peak_month_match | number | yes | share (0-1) of fit years where the peak calendar month of k x VIIRS equals that of MODIS |
| figures | object | no | figure name -> path relative to `public/v1/` |

`placebo` items: `{"date": "YYYY-MM", "seam_ratio": number | null, "changepoint_p": number | null}`.

`figures` keys: `seam` (from #10) and `scatter` (from #11). Values are relative paths such as
`figures/seam_pantanal.png`; the app resolves them against the public data base URL
(`https://storage.googleapis.com/$DATA_BUCKET/public/v1/`). A missing figure is left out of the
object, not set to null.

All ratios are dimensionless. A metric is null when it cannot be computed (for example too few
months with MODIS > 0); it is never `NaN` (not valid JSON).
