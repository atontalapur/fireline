"""Shared constants and paths for the Fireline pipeline.

Every stage imports from here so paths, regions and method parameters stay in one place.
Do not duplicate these values in stage modules.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("FIRELINE_DATA_DIR", REPO_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
PUBLIC_DIR = DATA_DIR / "public" / "v1"
FIGURES_DIR = PROCESSED_DIR / "figures"
REGIONS_GEOJSON = Path(__file__).resolve().parent / "regions.geojson"

DATA_BUCKET = os.environ.get("DATA_BUCKET", "")
FIRMS_MAP_KEY = os.environ.get("FIRMS_MAP_KEY", "")

# Demo regions. bbox = (west, south, east, north), used for NRT area API and quick filters.
# Exact polygons live in regions.geojson (written by A2).
REGIONS: dict[str, dict] = {
    "pantanal": {
        "name": "Brazilian Pantanal",
        "country": "Brazil",
        "bbox": (-59.2, -22.2, -54.8, -15.4),
    },
    "w_canada": {
        "name": "Western Canada (BC + Alberta)",
        "country": "Canada",
        "bbox": (-139.1, 48.2, -109.9, 60.0),
    },
    "punjab": {"name": "Indian Punjab", "country": "India", "bbox": (73.8, 29.5, 77.0, 32.6)},
}

# Contract sensor codes (contracts/hotspots).
MODIS_SENSORS = ("MODIS_TERRA", "MODIS_AQUA")
VIIRS_SENSORS = ("VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21")
SENSORS = MODIS_SENSORS + VIIRS_SENSORS

# Method parameters (see issue #1 and docs/METHOD.md).
MODIS_MIN_CONFIDENCE = 30
VIIRS_KEEP_CONFIDENCE = ("n", "h")
H3_FINE_RES = 8
H3_STORE_RES = 6
FIT_START, FIT_END = "2012-01", "2019-12"
FIT_YEARS = tuple(range(2012, 2020))
SWITCH_MONTH = "2020-01"
TERRA_ONLY_START, TERRA_ONLY_END = "2000-11", "2002-06"
TERRA_RATIO_FIT = ("2002-07", "2007-12")
SHRINK_N0 = 50.0
N_BOOT = 1000
BOOT_SEED = 42
BASELINE_YEARS = (2003, 2022)
METHOD_VERSION = "1.0"


def ensure_dirs() -> None:
    for d in (RAW_DIR, PROCESSED_DIR, PUBLIC_DIR, FIGURES_DIR):
        d.mkdir(parents=True, exist_ok=True)


def upload_to_gcs(local: Path, dest: str, bucket: str | None = None) -> str:
    """Upload a file to gs://{bucket}/{dest} and return the gs:// URI.

    Uses the google-cloud-storage client (Application Default Credentials).
    """
    from google.cloud import storage

    bucket_name = bucket or DATA_BUCKET
    if not bucket_name:
        raise RuntimeError("DATA_BUCKET is not set")
    blob = storage.Client().bucket(bucket_name).blob(dest)
    blob.upload_from_filename(str(local))
    return f"gs://{bucket_name}/{dest}"


def public_url(dest: str, bucket: str | None = None) -> str:
    return f"https://storage.googleapis.com/{bucket or DATA_BUCKET}/{dest}"
