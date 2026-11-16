"""Build pipeline/regions.geojson from openly published boundary files.

Sources:
- Natural Earth 1:10m admin-1 states/provinces v5.1.1 (public domain) for British Columbia,
  Alberta and the Indian state of Punjab.
- IBGE Biomas e Sistema Costeiro-Marinho do Brasil 1:250,000 (2019), Pantanal biome polygon.
  IBGE terms allow free use with credit to IBGE.

Geometry is simplified with DuckDB spatial and coordinates are rounded so the file stays small.
Run once; the output is committed. Raw downloads go to RAW_DIR/boundaries (gitignored).

    uv run python make_regions.py            # download into RAW_DIR/boundaries and build
    uv run python make_regions.py --ne-shp X.shp --ibge-shp Y.shp
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import zipfile
from pathlib import Path

import duckdb
import requests

import common

log = logging.getLogger("make_regions")

NE_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"
NE_SHP = "ne_10m_admin_1_states_provinces.shp"
IBGE_URL = (
    "https://geoftp.ibge.gov.br/informacoes_ambientais/estudos_ambientais/biomas/vetores/"
    "Biomas_250mil.zip"
)
IBGE_SHP = "lm_bioma_250.shp"

NE_SOURCE = "Natural Earth 1:10m Admin 1 - States, Provinces v5.1.1 (naturalearthdata.com)"
NE_LICENSE = "Public domain (Natural Earth terms of use)"
IBGE_SOURCE = (
    "IBGE, Biomas e Sistema Costeiro-Marinho do Brasil, escala 1:250.000 (2019), "
    "lm_bioma_250 (geoftp.ibge.gov.br)"
)
IBGE_LICENSE = "IBGE terms of use: free use and redistribution with credit to IBGE"

# Simplification tolerance in degrees (about 500 m and 200 m), finer than a MODIS pixel.
TOLERANCE = {"w_canada": 0.005, "pantanal": 0.002, "punjab": 0.002}
COORD_DECIMALS = 4


def _fetch(url: str, dest_dir: Path, shp_name: str) -> Path:
    shp = dest_dir / shp_name
    if shp.exists():
        return shp
    dest_dir.mkdir(parents=True, exist_ok=True)
    log.info("downloading %s", url)
    resp = requests.get(url, timeout=600)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        for member in zf.namelist():
            name = Path(member).name
            if not name or name.startswith("."):
                continue
            (dest_dir / name).write_bytes(zf.read(member))
    return shp


def _round(coords, nd: int):
    if isinstance(coords[0], (int, float)):
        return [round(c, nd) for c in coords]
    return [_round(c, nd) for c in coords]


def build(ne_shp: Path, ibge_shp: Path) -> dict:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    queries = {
        "w_canada": (
            f"SELECT ST_Union_Agg(geom) FROM ST_Read('{ne_shp}') "
            "WHERE iso_3166_2 IN ('CA-BC', 'CA-AB')",
            NE_SOURCE,
            NE_LICENSE,
        ),
        "punjab": (
            f"SELECT ST_Union_Agg(geom) FROM ST_Read('{ne_shp}') WHERE iso_3166_2 = 'IN-PB'",
            NE_SOURCE,
            NE_LICENSE,
        ),
        "pantanal": (
            f"SELECT ST_Union_Agg(geom) FROM ST_Read('{ibge_shp}') WHERE CD_Bioma = 6",
            IBGE_SOURCE,
            IBGE_LICENSE,
        ),
    }
    features = []
    for region, (sql, source, license_) in queries.items():
        tol = TOLERANCE[region]
        row = con.execute(
            f"SELECT ST_AsGeoJSON(ST_MakeValid(ST_SimplifyPreserveTopology(g, {tol}))), "
            f"ST_NPoints(g) FROM ({sql}) t(g)"
        ).fetchall()[0]
        geom = json.loads(row[0])
        geom["coordinates"] = _round(geom["coordinates"], COORD_DECIMALS)
        log.info("%s: %d vertices before simplify", region, row[1])
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "region": region,
                    "name": common.REGIONS[region]["name"],
                    "source": source,
                    "license": license_,
                    "simplify_tolerance_deg": tol,
                },
                "geometry": geom,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ne-shp", type=Path, help="Natural Earth admin-1 10m shapefile")
    parser.add_argument("--ibge-shp", type=Path, help="IBGE lm_bioma_250 shapefile")
    parser.add_argument("--out", type=Path, default=common.REGIONS_GEOJSON)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    boundaries = common.RAW_DIR / "boundaries"
    ne_shp = args.ne_shp or _fetch(NE_URL, boundaries / "natural_earth", NE_SHP)
    ibge_shp = args.ibge_shp or _fetch(IBGE_URL, boundaries / "ibge_biomas", IBGE_SHP)
    fc = build(ne_shp, ibge_shp)
    args.out.write_text(json.dumps(fc, separators=(",", ":")) + "\n")
    log.info("wrote %s (%.0f KB)", args.out, args.out.stat().st_size / 1024)


if __name__ == "__main__":
    main()
