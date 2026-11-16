# Sentinel-3 SLSTR check

We use ESA's Sentinel-3 SLSTR Level-2 Fire Radiative Power product as a third, independent
satellite record for the Pantanal from 2020-08 onward. `pipeline/sentinel3.py` lists the
granules over the Pantanal bbox in the Planetary Computer STAC collection
`sentinel-3-slstr-frp-l2-netcdf`, reads the `frp-in` fire table of each granule, keeps
vegetation fires (`classification` bit 1) inside the region polygon (or the bbox if
`regions.geojson` is missing), drops pixels repeated in overlapping frames, and counts monthly
detections and H3 res-8 fire cell-days per satellite (S3A + S3B summed, the same way Terra and
Aqua are summed). To fit the timebox it reads every second local solar day and scales each
month by days with data / days read. Whole days are sampled, so cell-days stay exact on the
days that were read. We then compare the monthly cell-days with the harmonized monthly totals
(Spearman r, plus whether the peak month agrees each year), using months with data on at
least 80% of days and leaving out provisional months.

Result: over 64 months (2020-09 to 2025-12), Sentinel-3 monthly cell-days and the harmonized
series have a Spearman r of 0.866, and the peak month agrees in 4 of 5 complete years (2024
peaks in October for Sentinel-3 and August for the harmonized series). The Sentinel-3 series
(6,008 of 12,016 granules read, 2020-08 to 2026-11) shows the known fire seasons: peaks in
September 2020 (about 79,000 cell-days), September 2021, November 2023 and August-September
2024, with 2022 and 2025 quiet. Rerun the comparison alone with
`uv run python sentinel3.py --compare-only`. Two caveats. Sentinel-3 passes over at about 10:00 and 22:00
local time, so it misses the afternoon peak that Aqua and VIIRS see. ESA also updated the FRP
processor about once a year (IPF-SL-2-FRP 01.04 in 2020 through 01.13 in 2026; `confidence`
was dropped by 01.09). Use the series for timing and ranking, not absolute levels.

Data: Copernicus Sentinel-3 SLSTR Level-2 FRP (SL_2_FRP), European Space Agency / EUMETSAT,
accessed through Microsoft Planetary Computer. Contains modified Copernicus Sentinel data
(2020-2026), provided free and open under the Copernicus data policy
(https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice). Use of
Planetary Computer is subject to its terms of use (https://planetarycomputer.microsoft.com/terms).
