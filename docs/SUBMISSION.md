# Fireline: Space Apps 2026 submission text

Paste-ready text for each field on the project page (Profile > My Team > Project > Edit).
Challenge: [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/).

How to use this file:

- Text under **Paste** goes into the form as written. Lines starting with `>` are notes for us; don't paste them.
- Search for `TODO:` before submitting. Every one must be resolved or deleted.
- The [Project Submission Guide](https://www.spaceappschallenge.org/resources/project-submission-guide/) (checked Nov 15, 2026) gives no character limits for any field. To be safe the summary is kept under 1,000 characters. If the form rejects a field as too long, trim the last paragraph first.
- Optional paragraphs are tagged with the issue they depend on. Delete them if that issue did not ship.

---

## 1. Project Name

**Paste**

Fireline

---

## 2. High-Level Project Summary

> About 970 characters. Recount after edits.

**Paste**

Fireline is a web app that turns NASA's MODIS (2000 onward) and VIIRS (2012 onward) FIRMS hotspots into one consistent monthly fire record. Pick any area by drawing it, typing coordinates or searching a place. Fireline shows how much it burned each month since November 2000, whether the latest month is abnormal against the historical median, and lets you download the numbers as CSV.

VIIRS detects several times more hotspots than MODIS for the same fires, so the two records can't be joined directly. We count fire cell-days on a common H3 grid, fit a VIIRS-to-MODIS ratio per region and month over 2012-2019 with bootstrap error bands, and splice the series in January 2020. Harmonization cuts the VIIRS/MODIS ratio from 2.2-4.4x to 1.06-1.18x.

This matters now. Terra and Aqua MODIS are ending in 2027 and FIRMS stopped new Suomi NPP data in November 2026. Fireline keeps the 26-year reference record going on NOAA-20 and NOAA-21 VIIRS, in MODIS-equivalent units.

---

## 3. Link to Project Demo

> Video must be 30 seconds or less, English or English subtitles, public or unlisted, opens in a private window with no login (#29).

**Paste**

TODO: YouTube link to the 30-second demo video

---

## 4. Link to Final Project

> Custom domain here. The run.app URL goes in the Detailed Description as a backup. Test both logged out.

**Paste**

TODO: https://<custom domain>

---

## 5. Detailed Project Description

**Paste**

**What it does**

Fireline answers one question for any area: how much has it burned each month since 2000, on one consistent scale, and is this month unusual?

- Pick an area four ways: draw a polygon or rectangle, enter a point and radius, search a place name, or click a preset (Brazilian Pantanal, Western Canada, Indian Punjab).
- Burning calendar: a heatmap with one row per year and one column per month. Switch between counts and anomalies. Every cell shows the harmonized value with its 90% band, the baseline median, a robust z-score, the percentile rank and the raw MODIS and VIIRS counts. A table view carries the same numbers for screen readers and keyboard users.
- Summary cards in plain sentences: this month against normal, the worst months and years, and a trend only when the data supports one.
- A sensor seam chart that puts raw MODIS, raw VIIRS and the harmonized line side by side, so you can see the jump in raw counts when VIIRS starts and how the harmonized line removes it.
- CSV downloads: one row per month with all the statistics, plus every cleaned hotspot in the area with the calibration factor applied to it.
- A method page with the validation results for each region.
- [B9] An AI analyst. Ask "Was August 2024 unusual for the Pantanal?" and get a short answer. Every number in it comes from a tool call that queries the same data, and a "How I got this" list shows each call.
- [B10] An MCP server, so Claude and other assistants can query the same fire history without opening the site.
- [B11] A hexagon map of where the fires were in a selected month.
- [B12] Weather context for presets: temperature, humidity, wind and precipitation anomalies for the selected month.

**How it works**

1. Data: FIRMS MODIS Collection 6.1 and VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21) hotspots, standard (science-quality) files for the archive and near-real-time data for recent months.
2. Cleaning: keep vegetation fires (type 0), MODIS confidence 30 or higher, VIIRS nominal or high confidence. Each detection gets a local solar date.
3. Common unit: a fire cell-day is one H3 resolution-8 cell (about 0.74 km², close to one MODIS pixel) with at least one detection from one satellite on one local day. Several VIIRS points in one cell count once, so the smaller VIIRS pixel no longer inflates the count. MODIS = Terra + Aqua. VIIRS = the mean over the VIIRS satellites flying that day, so a new satellite does not add fire.
4. Calibration: for each region and calendar month, k = total MODIS cell-days / total VIIRS cell-days over 2012-2019, when both sensors flew. Thin strata are shrunk toward the region-wide k. 90% bands come from resampling whole years 1,000 times.
5. Splice: observed MODIS through December 2019, k x VIIRS from January 2020. The Terra-only months (November 2000 to June 2002) are scaled to Terra + Aqua. The series keeps running after MODIS ends with no code change. Months built from near-real-time data are marked provisional.
6. Storage: H3 resolution-6 cells by month in Parquet. Baselines (2003-2022 by default) and anomalies are computed at query time for whatever area you pick.
7. Validation: overlap bias before and after harmonization, leave-one-year-out error, a forward test on 2020 onward, and change-point tests at the seam and at placebo dates. Over 2012-2019 the raw VIIRS/MODIS ratio is 2.18x in the Pantanal, 2.98x in Western Canada and 4.44x in Punjab; after harmonization it is 1.06x, 1.18x and 1.14x. Leave-one-year-out r (log monthly counts) is 0.98, 0.98 and 0.97, and the forward test on 2020-2025 gives 0.99, 0.99 and 0.98. The seam test turned out to be uninformative: placebo dates give before/after ratios from 0.50x to 11.2x, so it mostly measures real year-to-year swings in fire, and we do not rely on it.
8. Independent check against ESA Sentinel-3 SLSTR fire radiative power detections for the Pantanal, September 2020 to December 2025 (64 months). Spearman r with the harmonized series is 0.866, and the peak fire month matches in 4 of 5 years.

**Benefits**

Fire agencies, land managers and researchers can compare 2024 with 2005 without worrying about which satellite saw the fire. The method is simple enough to audit, every number has an error band, and the record carries on after MODIS is gone. Anyone can check a custom area in a browser with no GIS skills, then take the CSV into their own tools.

**Limitations**

MODIS and VIIRS cross at different times of day, Terra and Aqua orbits have drifted since about 2020, near-real-time months are provisional, small areas are noisy, and a before/after test at the 2020 seam cannot separate a sensor artifact from a real change in fire. The current release covers data through December 2025 and does not yet include NOAA-21. The method page covers each of these.

> Update the last sentence if the NRT top-up (needs a FIRMS MAP_KEY) or the NOAA-21 archive request lands before submission.

**Tools and languages**

Python (pandas, DuckDB with the spatial and H3 extensions, NumPy, SciPy, ruptures, matplotlib) for the data pipeline. TypeScript, Next.js, Tailwind CSS and shadcn/ui for the app, with Google Maps Platform, Terra Draw, deck.gl, Observable Plot, h3-js and Zod. DuckDB queries Parquet inside the app's container. Hosted on Google Cloud Run, data in Google Cloud Storage. [B9] Gemini on Vertex AI through the Vercel AI SDK for the analyst. [B10] MCP TypeScript SDK for the MCP server. Microsoft Planetary Computer for Sentinel-3 data. Open-Meteo Historical Weather API (ERA5) for weather. Docker for packaging.

Backup link: TODO: https://<service>.run.app

Source code: TODO: https://github.com/atontalapur/fireline (confirm the repo is public)

---

## 6. Use of Super Intelligence (SI)

> The guide says this field is not shown to judges, but judges will see any SI labels inside the project. Rules: SI images and video need a visible watermark; SI audio, code and data need an acknowledgment in descriptive text and metadata; no NASA logos, flags or mission identifiers in generated content; SI must not be used to come up with the idea itself. The demo video should contain no AI-generated imagery or voice. If any is used, it must carry a visible watermark.

**Paste**

Yes.

- Claude Code (Anthropic) was used as a coding assistant to write and test parts of the Python data pipeline, the Next.js app and the project documentation. We chose the challenge approach and the harmonization method ourselves and reviewed every change it produced. The repository README states that AI-assisted code is present.
- [B9] Gemini on Vertex AI (Google) runs inside the product as the AI analyst. It does not produce data. It calls our own query tools and writes a 2-3 sentence answer from their outputs. Each answer is labeled "AI-generated text" and lists the tool calls it made, so users can check every number.
- TODO: list any other SI tools the team used (name, what for).
- We did not use AI-generated images, video or audio. TODO: if any are added, list them here and confirm each has a visible SI watermark.

---

## 7. NASA Data

**Paste**

NASA FIRMS (Fire Information for Resource Management System) active fire hotspots are the core of Fireline. Every number in the app comes from them.

- MODIS Collection 6.1 active fires, Terra and Aqua, 1 km, November 2000 to present.
  - Standard (science-quality) monthly locations, MCD14ML, built from MOD14 (https://doi.org/10.5067/MODIS/MOD14.061) and MYD14 (https://doi.org/10.5067/MODIS/MYD14.061)
  - Near-real-time, MCD14DL: https://doi.org/10.5067/FIRMS/MODIS/MCD14DL.NRT.0061
- VIIRS 375 m I-band active fires, Collection 2.
  - Suomi NPP (2012 to November 2026), standard monthly locations VNP14IMGML (from VNP14IMG, https://doi.org/10.5067/VIIRS/VNP14IMG.002) and near-real-time VNP14IMGTDL_NRT (https://doi.org/10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002)
  - NOAA-20, standard VJ114IMGML (from VJ114IMG, https://doi.org/10.5067/VIIRS/VJ114IMG.002) and near-real-time VJ114IMGTDL_NRT (https://doi.org/10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002)
  - NOAA-21, standard VJ214IMGML (from VJ214IMG, https://doi.org/10.5067/VIIRS/VJ214IMG.002) and near-real-time VJ214IMGTDL_NRT (https://doi.org/10.5067/VIIRS/VJ214IMG_NRT.002)

We use both sensors over their 2012-2019 overlap to calibrate VIIRS to MODIS, then extend the MODIS-equivalent record on VIIRS. Standard files cover the archive. Near-real-time data fills recent months, which the app marks as provisional.

We acknowledge the use of data from the NASA LANCE FIRMS (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and Information System (ESDIS).

Algorithm references: Giglio, Schroeder and Justice (2016), Remote Sensing of Environment 178:31-41; Schroeder et al. (2014), Remote Sensing of Environment 143:85-96, https://doi.org/10.1016/j.rse.2013.12.008.

> The FIRMS standard "ML" files (MCD14ML, VNP14IMGML, VJ114IMGML, VJ214IMGML) have no DOI of their own that resolves (checked Nov 15, 2026), so the parent Level-2 DOIs are cited. NRT DOIs are from the FIRMS product pages on earthdata.nasa.gov.
>
> The current data run uses standard files through 31 Dec 2025 for Terra, Aqua, Suomi NPP and NOAA-20 only. NOAA-21 is not on the FIRMS country archive (needs an archive request) and the NRT top-up needs a FIRMS MAP_KEY. If either is still missing at submission, drop the NOAA-21 line and the near-real-time sentence above.
>
> No Planetary Computer MODIS product is used. If one is added (for example `modis-14A1-061`), list it here with its DOI.

---

## 8. Space Agency Partner Data and Other References

> One form field covers both. Paste the partner data paragraph, then the references list below it.

**Paste: partner data**

ESA (European Space Agency) Copernicus Sentinel-3 SLSTR Level-2 Fire Radiative Power (FRP), accessed through the Microsoft Planetary Computer STAC collection `sentinel-3-slstr-frp-l2-netcdf`. We used it as an independent third-satellite check on the harmonized Pantanal series: over 64 months (September 2020 to December 2025) the Spearman rank correlation is 0.866, and the peak fire month matches in 4 of 5 years. Contains modified Copernicus Sentinel data (2020-2025), processed by ESA. Terms: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice

**Paste: references**

Data

| Name | Use | License or terms |
|---|---|---|
| NASA FIRMS MODIS C6.1 and VIIRS 375 m hotspots | Core input for all numbers | NASA data, no use restrictions (CC0), citation requested: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance and https://www.earthdata.nasa.gov/data/tools/firms/faq |
| ESA Copernicus Sentinel-3 SLSTR FRP | Independent validation, Pantanal | https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice |
| Microsoft Planetary Computer | Access to Sentinel-3 data | https://planetarycomputer.microsoft.com/terms |
| Open-Meteo Historical Weather API (Zippenfenig, 2023; https://open-meteo.com), ERA5 reanalysis | Monthly weather context for presets | CC BY 4.0. Contains modified Copernicus Climate Change Service information |
| IBGE, Biomas e Sistema Costeiro-Marinho do Brasil, 1:250.000 (2019) | Pantanal preset boundary | Free use with attribution to IBGE (Instituto Brasileiro de Geografia e Estatística) |
| Natural Earth 1:10m Admin 1 (states and provinces), v5.1.1 | British Columbia, Alberta and Punjab preset boundaries | Public domain: https://www.naturalearthdata.com/about/terms-of-use/ |

> TODO: confirm the IBGE terms from the dataset's metadata record; the attribution terms above are not yet checked against it.
>
> Meteomatics was not used (no credentials). The weather code also supports the Meteomatics API; list it here only if a run uses it.

Services

| Name | Use | License or terms |
|---|---|---|
| Google Maps Platform (Maps JavaScript API, Places API, Geocoding API) | Base map, place search, geocoding | https://cloud.google.com/maps-platform/terms |
| Google Cloud Run and Cloud Storage | Hosting and data storage | https://cloud.google.com/terms |
| [B9] Vertex AI (Gemini) | AI analyst | https://cloud.google.com/terms and https://cloud.google.com/terms/service-terms |

App libraries (TypeScript)

| Name | Use | License or terms |
|---|---|---|
| Next.js | Web framework | MIT: https://github.com/vercel/next.js/blob/canary/license.md |
| React | UI library | MIT: https://github.com/facebook/react/blob/main/LICENSE |
| TypeScript | Language | Apache-2.0: https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt |
| Tailwind CSS | Styling | MIT: https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE |
| shadcn/ui | UI components | MIT: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md |
| Terra Draw and terra-draw-google-maps-adapter | Drawing areas on the map | MIT: https://github.com/JamesLMilner/terra-draw/blob/main/LICENSE |
| @googlemaps/js-api-loader | Loading Google Maps | Apache-2.0: https://github.com/googlemaps/js-api-loader/blob/main/LICENSE |
| deck.gl | Hexagon map layer | MIT: https://github.com/visgl/deck.gl/blob/master/LICENSE |
| Observable Plot | Charts and calendar | ISC: https://github.com/observablehq/plot/blob/main/LICENSE |
| h3-js | Area to H3 cells | Apache-2.0: https://github.com/uber/h3-js/blob/master/LICENSE |
| Zod | Input validation | MIT: https://github.com/colinhacks/zod/blob/main/LICENSE |
| @duckdb/node-api | Querying Parquet in the API | MIT: https://github.com/duckdb/duckdb-node-neo/blob/main/LICENSE |
| [B9] Vercel AI SDK (ai, @ai-sdk/google-vertex) | AI analyst tool loop | Apache-2.0: https://github.com/vercel/ai/blob/main/LICENSE |
| [B10] MCP TypeScript SDK | MCP server | MIT, moving to Apache-2.0: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE |
| ColorBrewer schemes (PuOr, BrBG) | Anomaly color ramps | Apache-2.0: https://github.com/axismaps/colorbrewer/blob/master/LICENCE.txt |

Pipeline libraries (Python)

| Name | Use | License or terms |
|---|---|---|
| Python | Language | PSF License: https://docs.python.org/3/license.html |
| DuckDB | SQL over Parquet | MIT: https://github.com/duckdb/duckdb/blob/main/LICENSE |
| DuckDB spatial extension | Geometry functions | MIT: https://github.com/duckdb/duckdb-spatial/blob/main/LICENSE |
| DuckDB h3 extension | H3 functions in SQL | Apache-2.0: https://github.com/isaacbrodsky/h3-duckdb/blob/main/LICENSE |
| H3 and h3-py | Hexagonal grid | Apache-2.0: https://github.com/uber/h3/blob/master/LICENSE and https://github.com/uber/h3-py/blob/master/LICENSE |
| pandas | Data frames | BSD-3-Clause: https://github.com/pandas-dev/pandas/blob/main/LICENSE |
| NumPy | Numerics | BSD-3-Clause: https://github.com/numpy/numpy/blob/main/LICENSE.txt |
| SciPy | Statistics | BSD-3-Clause: https://github.com/scipy/scipy/blob/main/LICENSE.txt |
| PyArrow / Apache Parquet | Parquet files | Apache-2.0: https://github.com/apache/arrow/blob/main/LICENSE.txt |
| ruptures | Change-point test at the seam | BSD-2-Clause: https://github.com/deepcharles/ruptures/blob/master/LICENSE |
| matplotlib | Validation figures | Matplotlib License (PSF-based): https://matplotlib.org/stable/project/license.html |
| Requests | Downloading FIRMS data | Apache-2.0: https://github.com/psf/requests/blob/main/LICENSE |
| google-cloud-storage | Uploading outputs | Apache-2.0: https://github.com/googleapis/python-storage/blob/main/LICENSE |
| pystac-client | STAC search | Apache-2.0: https://github.com/stac-utils/pystac-client/blob/main/LICENSE |
| planetary-computer | Signing Planetary Computer URLs | MIT: https://github.com/microsoft/planetary-computer-sdk-for-python/blob/main/LICENSE |
| xarray | Reading NetCDF | Apache-2.0: https://github.com/pydata/xarray/blob/main/LICENSE |
| h5netcdf | NetCDF backend | BSD-3-Clause: https://github.com/h5netcdf/h5netcdf/blob/main/LICENSE |
| pytest | Tests | MIT: https://github.com/pytest-dev/pytest/blob/main/LICENSE |
| Ruff | Lint and format | MIT: https://github.com/astral-sh/ruff/blob/main/LICENSE |
| Docker | Container build | Apache-2.0: https://github.com/moby/moby/blob/master/LICENSE |

Method references

- Chen, Y., van der Werf, G. R., Mu, M., van Wees, D., Hall, J. V., Giglio, L., Vernooij, R., Morton, D. C., Xu, L., Liu, T., Scholten, R. C., Coffield, S. R., Follette-Cook, M. B., Ott, L., and Randerson, J. T. (2026). Tracking recent extremes and interannual variability of global fire emissions using a near-real-time extension to the Global Fire Emissions Database. Earth System Science Data, 18, 7535-7555. https://doi.org/10.5194/essd-18-7535-2026
- Giglio, L., Schroeder, W., and Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31-41.
- Giglio, L., Schroeder, W., Hall, J. V., and Justice, C. O. (2021). MODIS Collection 6 and Collection 6.1 Active Fire Product User's Guide, Version 1.0. NASA. https://www.earthdata.nasa.gov/s3fs-public/2023-09/MODIS_C6_C6.1_Fire_User_Guide_1.0.pdf
- Li, F., Zhang, X., Kondragunta, S., and Csiszar, I. (2018). Comparison of fire radiative power estimates from VIIRS and MODIS observations. Journal of Geophysical Research: Atmospheres, 123, 4545-4563. https://doi.org/10.1029/2017JD027823
- Pettitt, A. N. (1979). A non-parametric approach to the change-point problem. Journal of the Royal Statistical Society, Series C (Applied Statistics), 28(2), 126-135. https://doi.org/10.2307/2346729
- Schroeder, W., Giglio, L., and Hall, J. (2025). Collection 2 Visible Infrared Imaging Radiometer Suite (VIIRS) 375-m Active Fire Product User's Guide, Version 1.2. NASA. https://www.earthdata.nasa.gov/s3fs-public/2025-06/VIIRS_C2_AF-375m_User_Guide_1.2.pdf
- Schroeder, W., Oliva, P., Giglio, L., and Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85-96. https://doi.org/10.1016/j.rse.2013.12.008
- Vadrevu, K., and Lasko, K. (2018). Intercomparison of MODIS AQUA and VIIRS I-band fires and emissions in an agricultural landscape: Implications for air pollution research. Remote Sensing, 10(7), 978. https://doi.org/10.3390/rs10070978
- Wooster, M. J., Xu, W., and Nightingale, T. (2012). Sentinel-3 SLSTR active fire detection and FRP product: Pre-launch algorithm development and performance evaluation using MODIS and ASTER datasets. Remote Sensing of Environment, 120, 236-254. https://doi.org/10.1016/j.rse.2011.09.033
- Zippenfenig, P. (2023). Open-Meteo.com Weather API. https://open-meteo.com

Code and ideas from other projects

- TODO: list any public repo we took code or ideas from, with its license. Write "None" if there are none.

> Licenses above were checked on Nov 15, 2026 against each project's repo or package metadata. The MCP TypeScript SDK repo states it is moving from MIT to Apache-2.0; the npm package still declares MIT. If the form strips tables, paste each row as "Name: use. License: link".
