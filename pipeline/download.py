"""A1: download FIRMS hotspot archives (SP) and top them up with near-real-time (NRT) data.

SP: yearly country CSVs from https://firms.modaps.eosdis.nasa.gov/data/country/
    {prefix}/{year}/{prefix}_{year}_{Country}.csv, where prefix is modis, viirs-snpp or
    viirs-jpss1 (NOAA-20). The file inventory comes from yearly_summary_files.txt in the same
    folder. FIRMS does not publish viirs-jpss2 (NOAA-21) country files, so those are listed as
    missing and need a manual FIRMS Archive Download request.
NRT: FIRMS area API over each region bbox, 5-day chunks, only for dates after the SP coverage
    of that sensor and country. Skipped when FIRMS_MAP_KEY is empty.

Outputs:
    RAW_DIR/firms/{SP,NRT}/{sensor}/{country}/{name}.csv
    RAW_DIR/manifest.json

Usage:
    uv run python download.py                     # SP + NRT, all countries and sensors
    uv run python download.py --countries India --sensors MODIS --years 2000
    uv run python download.py --dry-run           # print the plan and download volume
    uv run python download.py --upload            # also copy raw files to gs://$DATA_BUCKET/raw/
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import time
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

import common

log = logging.getLogger("download")

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov"
COUNTRY_DATA_URL = f"{FIRMS_BASE}/data/country"
LISTING_URL = f"{COUNTRY_DATA_URL}/yearly_summary_files.txt"
AREA_API_URL = f"{FIRMS_BASE}/api/area/csv"
AVAILABILITY_URL = f"{FIRMS_BASE}/api/data_availability/csv"

# Raw sensor dir -> (FIRMS country-file prefix, first SP year).
SP_SENSORS: dict[str, tuple[str, int]] = {
    "MODIS": ("modis", 2000),
    "VIIRS_SNPP": ("viirs-snpp", 2012),
    "VIIRS_NOAA20": ("viirs-jpss1", 2018),
    "VIIRS_NOAA21": ("viirs-jpss2", 2023),
}
# FIRMS stopped new S-NPP data on 2026-11-02.
SP_LAST_YEAR: dict[str, int] = {"VIIRS_SNPP": 2026}

NRT_SOURCES: dict[str, str] = {
    "MODIS": "MODIS_NRT",
    "VIIRS_NOAA20": "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21": "VIIRS_NOAA21_NRT",
}
# Earliest NRT date to request when a sensor has no SP coverage at all.
NRT_EARLIEST: dict[str, date] = {
    "MODIS": date(2000, 11, 1),
    "VIIRS_NOAA20": date(2018, 4, 1),
    "VIIRS_NOAA21": date(2023, 3, 1),
}
NRT_CHUNK_DAYS = 5  # area API maximum day_range
NRT_SETTLE_DAYS = 2  # chunks ending this close to today are re-fetched on every run
# FIRMS allows 5,000 transactions per 10 minutes. Count each call as day_range transactions
# (conservative) and stay at half the limit.
NRT_TX_BUDGET = 2500
NRT_TX_WINDOW_S = 600.0

MIN_INTERVAL_S = 1.0
MAX_RETRIES = 5
BACKOFF_BASE_S = 2.0
TIMEOUT_S = (30, 300)
RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})
STREAM_ERRORS = (
    requests.ConnectionError,
    requests.Timeout,
    requests.exceptions.ChunkedEncodingError,
)
LISTING_MAX_AGE_DAYS = 7
CHUNK_BYTES = 1 << 20

LISTING_NAME = "yearly_summary_files.txt"
STATS_NAME = ".file_stats.json"


# --------------------------------------------------------------------------- HTTP


class Fetcher:
    """requests wrapper with polite spacing, retries on 5xx/timeouts and resumable downloads."""

    def __init__(
        self,
        session: requests.Session | None = None,
        min_interval: float = MIN_INTERVAL_S,
        max_retries: int = MAX_RETRIES,
        backoff: float = BACKOFF_BASE_S,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.session = session or requests.Session()
        self.min_interval = min_interval
        self.max_retries = max_retries
        self.backoff = backoff
        self.sleep = sleep
        self.clock = clock
        self._last: float | None = None
        self.requests_made = 0

    def _wait_turn(self) -> None:
        if self._last is not None:
            wait = self.min_interval - (self.clock() - self._last)
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()

    def _retry_wait(self, attempt: int, url: str, err: Exception) -> None:
        if attempt >= self.max_retries:
            raise err
        delay = self.backoff * 2**attempt
        log.warning(
            "retry %d/%d in %.0fs for %s: %s", attempt + 1, self.max_retries, delay, url, err
        )
        self.sleep(delay)

    def get(self, url: str, headers: dict | None = None, stream: bool = False) -> requests.Response:
        for attempt in range(self.max_retries + 1):
            self._wait_turn()
            self.requests_made += 1
            try:
                resp = self.session.get(url, headers=headers, stream=stream, timeout=TIMEOUT_S)
            except (requests.ConnectionError, requests.Timeout) as exc:
                self._retry_wait(attempt, url, exc)
                continue
            if resp.status_code in RETRY_STATUS or resp.status_code >= 500:
                resp.close()
                self._retry_wait(
                    attempt, url, requests.HTTPError(f"HTTP {resp.status_code}", response=resp)
                )
                continue
            resp.raise_for_status()
            return resp
        raise AssertionError("unreachable")

    def download(self, url: str, dest: Path, expected_size: int | None = None) -> int:
        """Stream url to dest via dest.part, resuming a partial .part when possible."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        for attempt in range(self.max_retries + 1):
            offset = part.stat().st_size if part.exists() else 0
            if expected_size is not None and offset >= expected_size:
                part.unlink()
                offset = 0
            headers = {"Range": f"bytes={offset}-"} if offset else None
            resp = self.get(url, headers=headers, stream=True)
            mode = "ab" if offset and resp.status_code == 206 else "wb"
            try:
                with resp, open(part, mode) as fh:
                    for chunk in resp.iter_content(CHUNK_BYTES):
                        fh.write(chunk)
            except STREAM_ERRORS as exc:
                # Mid-stream failure: keep the .part and resume from it on the next attempt.
                self._retry_wait(attempt, url, exc)
                continue
            size = part.stat().st_size
            if expected_size is not None and size != expected_size:
                if size > expected_size:
                    part.unlink()
                self._retry_wait(
                    attempt, url, OSError(f"got {size} bytes, expected {expected_size}")
                )
                continue
            os.replace(part, dest)
            return size
        raise AssertionError("unreachable")


class TxBudget:
    """Sliding-window cap on FIRMS API transactions."""

    def __init__(
        self,
        limit: int = NRT_TX_BUDGET,
        window: float = NRT_TX_WINDOW_S,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window = window
        self.sleep = sleep
        self.clock = clock
        self._events: deque[tuple[float, int]] = deque()

    def used(self) -> int:
        now = self.clock()
        while self._events and self._events[0][0] <= now - self.window:
            self._events.popleft()
        return sum(n for _, n in self._events)

    def spend(self, n: int) -> None:
        while self.used() + n > self.limit:
            wait = self._events[0][0] + self.window - self.clock()
            log.info("NRT transaction budget reached, waiting %.0fs", wait)
            self.sleep(max(wait, 0.1))
        self._events.append((self.clock(), n))


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_text(text)
    os.replace(part, path)


# --------------------------------------------------------------------------- SP plan


@dataclass(frozen=True)
class SPFile:
    sensor: str
    country: str
    year: int

    @property
    def prefix(self) -> str:
        return SP_SENSORS[self.sensor][0]

    @property
    def name(self) -> str:
        return f"{self.prefix}_{self.year}_{self.country.replace(' ', '_')}.csv"

    @property
    def url(self) -> str:
        return f"{COUNTRY_DATA_URL}/{self.prefix}/{self.year}/{self.name}"

    @property
    def relpath(self) -> str:
        return f"firms/SP/{self.sensor}/{self.country}/{self.name}"


def countries() -> list[str]:
    return sorted({meta["country"] for meta in common.REGIONS.values()})


def sp_plan(
    country_list: Iterable[str],
    sensors: Iterable[str],
    today: date,
    years: tuple[int, int] | None = None,
) -> list[SPFile]:
    plan = []
    for sensor in sensors:
        first = SP_SENSORS[sensor][1]
        last = min(today.year, SP_LAST_YEAR.get(sensor, today.year))
        for year in range(first, last + 1):
            if years and not years[0] <= year <= years[1]:
                continue
            plan.extend(SPFile(sensor, c, year) for c in country_list)
    return plan


def parse_listing(text: str) -> dict[str, int]:
    """FIRMS yearly_summary_files.txt (filename,size,updated) -> {filename: size}."""
    df = pd.read_csv(io.StringIO(text), dtype={"filename": str})
    return dict(zip(df["filename"], df["size"].astype(int), strict=True))


def load_listing(fetcher: Fetcher, raw_dir: Path, refresh: bool = False) -> dict[str, int]:
    path = raw_dir / "firms" / LISTING_NAME
    fresh = (
        path.exists()
        and time.time() - path.stat().st_mtime < LISTING_MAX_AGE_DAYS * 86400
        and not refresh
    )
    if not fresh:
        log.info("fetching FIRMS file listing %s", LISTING_URL)
        _write_atomic(path, fetcher.get(LISTING_URL).text)
    return parse_listing(path.read_text())


def download_sp(
    plan: list[SPFile], listing: dict[str, int], fetcher: Fetcher, raw_dir: Path
) -> tuple[int, int]:
    """Download listed files that are absent or the wrong size. Returns (downloaded, bytes)."""
    n = nbytes = 0
    todo = [f for f in plan if f.name in listing and not _sp_complete(f, listing, raw_dir)]
    total = sum(listing[f.name] for f in todo)
    log.info("SP: %d files to download (%.2f GB)", len(todo), total / 1e9)
    for f in todo:
        log.info("SP %s (%.1f MB)", f.relpath, listing[f.name] / 1e6)
        nbytes += fetcher.download(f.url, raw_dir / f.relpath, expected_size=listing[f.name])
        n += 1
    return n, nbytes


def _sp_complete(f: SPFile, listing: dict[str, int], raw_dir: Path) -> bool:
    path = raw_dir / f.relpath
    return path.exists() and path.stat().st_size == listing[f.name]


# --------------------------------------------------------------------------- file stats


def csv_stats(path: Path) -> dict:
    """Row count and acq_date range of one FIRMS CSV."""
    dates = pd.read_csv(path, usecols=["acq_date"], dtype=str)["acq_date"].dropna()
    return {
        "rows": int(len(dates)),
        "first_date": dates.min() if len(dates) else None,
        "last_date": dates.max() if len(dates) else None,
    }


class StatsCache:
    """Per-file stats keyed by relpath, invalidated by size and mtime."""

    def __init__(self, raw_dir: Path) -> None:
        self.raw_dir = raw_dir
        self.path = raw_dir / "firms" / STATS_NAME
        self.data: dict = json.loads(self.path.read_text()) if self.path.exists() else {}

    def get(self, relpath: str) -> dict:
        st = (self.raw_dir / relpath).stat()
        key = {"size": st.st_size, "mtime_ns": st.st_mtime_ns}
        hit = self.data.get(relpath)
        if hit and all(hit.get(k) == v for k, v in key.items()):
            return hit
        self.data[relpath] = {**key, **csv_stats(self.raw_dir / relpath)}
        return self.data[relpath]

    def save(self) -> None:
        _write_atomic(self.path, json.dumps(self.data, indent=1, sort_keys=True))


# --------------------------------------------------------------------------- manifest


def summarize(product: str, sensor: str, country: str, files: list[tuple[str, dict]]) -> dict:
    firsts = [s["first_date"] for _, s in files if s["first_date"]]
    lasts = [s["last_date"] for _, s in files if s["last_date"]]
    return {
        "product": product,
        "sensor": sensor,
        "country": country,
        "first_date": min(firsts) if firsts else None,
        "last_date": max(lasts) if lasts else None,
        "rows": sum(s["rows"] for _, s in files),
        "files": sorted(rel for rel, _ in files),
    }


def sp_entries(
    plan: list[SPFile], listing: dict[str, int], raw_dir: Path, stats: StatsCache, today: date
) -> list[dict]:
    """One manifest entry per (sensor, country) with every complete SP file on disk.

    coverage_end is Dec 31 of the last year file (or its last date for the current year), so NRT
    never re-requests days an SP yearly file already covers. complete is False when FIRMS lists
    files for the group that are not on disk yet.
    """
    groups: dict[tuple[str, str], list[SPFile]] = {}
    for f in plan:
        if f.name in listing:
            groups.setdefault((f.sensor, f.country), []).append(f)
    entries = []
    for (sensor, country), files in sorted(groups.items()):
        present = [f for f in files if _sp_complete(f, listing, raw_dir)]
        if not present:
            continue
        entry = summarize(
            "SP", sensor, country, [(f.relpath, stats.get(f.relpath)) for f in present]
        )
        last_year = max(f.year for f in present)
        if last_year < today.year:
            coverage_end = f"{last_year}-12-31"
        else:
            coverage_end = entry["last_date"]
        entry["coverage_start"] = entry["first_date"]
        entry["coverage_end"] = coverage_end
        entry["complete"] = len(present) == len(files)
        entries.append(entry)
    return entries


def missing_sp(plan: list[SPFile], listing: dict[str, int]) -> list[dict]:
    return [
        {"sensor": f.sensor, "country": f.country, "year": f.year, "name": f.name}
        for f in plan
        if f.name not in listing
    ]


def write_manifest(raw_dir: Path, entries: list[dict], missing: list[dict]) -> Path:
    manifest = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "entries": entries,
        "missing_sp": missing,
    }
    path = raw_dir / "manifest.json"
    _write_atomic(path, json.dumps(manifest, indent=2))
    return path


# --------------------------------------------------------------------------- NRT


def nrt_window(
    sensor: str,
    sp_coverage_end: date | None,
    today: date,
    available: tuple[date, date] | None = None,
) -> tuple[date, date] | None:
    """Date range to request from NRT: the day after SP coverage through today."""
    start = sp_coverage_end + timedelta(days=1) if sp_coverage_end else NRT_EARLIEST[sensor]
    end = today
    if available:
        start = max(start, available[0])
        end = min(end, available[1])
    return (start, end) if start <= end else None


def chunk_dates(start: date, end: date, days: int = NRT_CHUNK_DAYS) -> list[tuple[date, date]]:
    """Split [start, end] into consecutive inclusive chunks of at most `days` days."""
    out = []
    cur = start
    while cur <= end:
        stop = min(cur + timedelta(days=days - 1), end)
        out.append((cur, stop))
        cur = stop + timedelta(days=1)
    return out


@dataclass(frozen=True)
class NRTChunk:
    sensor: str
    region: str
    country: str
    start: date
    end: date

    @property
    def source(self) -> str:
        return NRT_SOURCES[self.sensor]

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def relpath(self) -> str:
        name = f"{self.source}_{self.region}_{self.start}_{self.end}.csv"
        return f"firms/NRT/{self.sensor}/{self.country}/{name}"

    def url(self, map_key: str) -> str:
        bbox = ",".join(f"{v:g}" for v in common.REGIONS[self.region]["bbox"])
        return f"{AREA_API_URL}/{map_key}/{self.source}/{bbox}/{self.days}/{self.start}"


def nrt_plan(
    sp: list[dict],
    today: date,
    sensors: Iterable[str],
    country_list: Iterable[str],
    availability: dict[str, tuple[date, date]] | None = None,
) -> tuple[list[NRTChunk], dict[tuple[str, str], tuple[date, date]]]:
    """NRT chunks per region and sensor, starting after that sensor's SP coverage_end.

    A sensor/country whose SP download is incomplete is skipped, so a partial SP cache never
    causes NRT requests for dates SP covers.
    """
    by_key = {(e["sensor"], e["country"]): e for e in sp}
    chunks: list[NRTChunk] = []
    windows = {}
    wanted = set(country_list)
    for region, meta in common.REGIONS.items():
        country = meta["country"]
        if country not in wanted:
            continue
        for sensor in sensors:
            if sensor not in NRT_SOURCES:
                continue
            entry = by_key.get((sensor, country))
            if entry and not entry.get("complete", True):
                log.warning("NRT %s %s skipped: SP download incomplete", sensor, region)
                continue
            sp_end = date.fromisoformat(entry["coverage_end"]) if entry else None
            avail = (availability or {}).get(NRT_SOURCES[sensor])
            win = nrt_window(sensor, sp_end, today, avail)
            if win is None:
                continue
            windows[(sensor, region)] = win
            chunks.extend(NRTChunk(sensor, region, country, s, e) for s, e in chunk_dates(*win))
    return chunks, windows


def fetch_availability(fetcher: Fetcher, map_key: str) -> dict[str, tuple[date, date]]:
    """{source: (min_date, max_date)} from the FIRMS data_availability endpoint."""
    try:
        text = fetcher.get(f"{AVAILABILITY_URL}/{map_key}/all").text
        df = pd.read_csv(io.StringIO(text))
        return {
            r.data_id: (date.fromisoformat(r.min_date), date.fromisoformat(r.max_date))
            for r in df.itertuples()
        }
    except (requests.RequestException, ValueError, KeyError, AttributeError) as exc:
        # Availability only narrows the request window; fall back to NRT_EARLIEST.
        log.warning("could not read FIRMS data availability: %s", exc)
        return {}


def download_nrt(
    chunks: list[NRTChunk],
    fetcher: Fetcher,
    raw_dir: Path,
    map_key: str,
    today: date,
    budget: TxBudget | None = None,
) -> int:
    budget = budget or TxBudget(sleep=fetcher.sleep, clock=fetcher.clock)
    settled = today - timedelta(days=NRT_SETTLE_DAYS)
    n = 0
    for c in chunks:
        path = raw_dir / c.relpath
        if path.exists() and c.end <= settled:
            continue
        budget.spend(c.days)
        text = fetcher.get(c.url(map_key)).text
        if not text.startswith("latitude"):
            raise RuntimeError(f"FIRMS area API error for {c.source} {c.region}: {text[:200]!r}")
        _write_atomic(path, text)
        n += 1
    return n


def prune_stale_nrt(chunks: list[NRTChunk], raw_dir: Path, sensors: Iterable[str]) -> int:
    """Delete cached NRT chunk files that are no longer in the plan (e.g. now covered by SP)."""
    keep = {c.relpath for c in chunks}
    removed = 0
    for sensor in sensors:
        base = raw_dir / "firms" / "NRT" / sensor
        if not base.exists():
            continue
        for path in base.rglob("*.csv"):
            rel = path.relative_to(raw_dir).as_posix()
            if rel not in keep:
                log.info("removing stale NRT chunk %s", rel)
                path.unlink()
                removed += 1
    return removed


def nrt_entries(
    chunks: list[NRTChunk],
    windows: dict[tuple[str, str], tuple[date, date]],
    raw_dir: Path,
    stats: StatsCache,
) -> list[dict]:
    entries = []
    for (sensor, region), (start, end) in sorted(windows.items()):
        mine = [c for c in chunks if (c.sensor, c.region) == (sensor, region)]
        present = [c for c in mine if (raw_dir / c.relpath).exists()]
        if not present:
            continue
        entry = summarize(
            "NRT",
            sensor,
            common.REGIONS[region]["country"],
            [(c.relpath, stats.get(c.relpath)) for c in present],
        )
        entry["region"] = region
        entry["coverage_start"] = str(start)
        entry["coverage_end"] = str(end)
        entry["complete"] = len(present) == len(mine)
        entries.append(entry)
    return entries


# --------------------------------------------------------------------------- upload


def upload_raw(raw_dir: Path, manifest_path: Path) -> int:
    manifest = json.loads(manifest_path.read_text())
    n = 0
    for entry in manifest["entries"]:
        for rel in entry["files"]:
            common.upload_to_gcs(raw_dir / rel, f"raw/{rel}")
            n += 1
    common.upload_to_gcs(manifest_path, "raw/manifest.json")
    return n + 1


# --------------------------------------------------------------------------- main


def _parse_years(text: str | None) -> tuple[int, int] | None:
    if not text:
        return None
    lo, _, hi = text.partition("-")
    return int(lo), int(hi or lo)


def run(
    raw_dir: Path = common.RAW_DIR,
    country_list: list[str] | None = None,
    sensors: list[str] | None = None,
    years: tuple[int, int] | None = None,
    map_key: str = common.FIRMS_MAP_KEY,
    skip_sp: bool = False,
    skip_nrt: bool = False,
    refresh_listing: bool = False,
    dry_run: bool = False,
    fetcher: Fetcher | None = None,
    today: date | None = None,
) -> dict:
    fetcher = fetcher or Fetcher()
    today = today or datetime.now(UTC).date()
    all_countries = countries()
    all_sensors = list(SP_SENSORS)
    country_list = country_list or all_countries
    sensors = sensors or all_sensors

    listing = load_listing(fetcher, raw_dir, refresh=refresh_listing)
    # The manifest always describes the full plan; filters only limit what gets downloaded.
    full_plan = sp_plan(all_countries, all_sensors, today)
    plan = sp_plan(country_list, sensors, today, years)
    missing = missing_sp(full_plan, listing)
    for m in missing:
        log.warning("SP not on FIRMS country site: %s %s %s", m["sensor"], m["country"], m["year"])

    if dry_run:
        todo = [f for f in plan if f.name in listing and not _sp_complete(f, listing, raw_dir)]
        gb = sum(listing[f.name] for f in todo) / 1e9
        log.info("dry run: %d SP files to download (%.2f GB)", len(todo), gb)
        return {"sp_downloaded": 0, "nrt_downloaded": 0, "sp_todo": len(todo), "sp_gb": gb}

    n_sp = 0
    if not skip_sp:
        n_sp, nbytes = download_sp(plan, listing, fetcher, raw_dir)
        log.info("SP: downloaded %d files (%.2f GB)", n_sp, nbytes / 1e9)

    stats = StatsCache(raw_dir)
    entries = sp_entries(full_plan, listing, raw_dir, stats, today)

    n_nrt = 0
    nrt = []
    if skip_nrt:
        log.info("NRT skipped (--skip-nrt)")
    elif not map_key:
        log.warning("FIRMS_MAP_KEY is empty: skipping NRT top-up")
    else:
        availability = fetch_availability(fetcher, map_key)
        chunks, windows = nrt_plan(entries, today, all_sensors, all_countries, availability)
        for (sensor, region), (s, e) in sorted(windows.items()):
            log.info("NRT %s %s: %s to %s", sensor, region, s, e)
        prune_stale_nrt(chunks, raw_dir, NRT_SOURCES)
        n_nrt = download_nrt(chunks, fetcher, raw_dir, map_key, today)
        log.info("NRT: downloaded %d chunks", n_nrt)
        nrt = nrt_entries(chunks, windows, raw_dir, stats)

    stats.save()
    manifest_path = write_manifest(raw_dir, entries + nrt, missing)
    log.info("wrote %s (%d entries)", manifest_path, len(entries) + len(nrt))
    return {
        "sp_downloaded": n_sp,
        "nrt_downloaded": n_nrt,
        "requests": fetcher.requests_made,
        "manifest": str(manifest_path),
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--countries", nargs="+", choices=countries(), help="limit SP downloads")
    p.add_argument("--sensors", nargs="+", choices=list(SP_SENSORS), help="limit SP downloads")
    p.add_argument("--years", help="limit SP downloads, e.g. 2000 or 2000-2005")
    p.add_argument("--skip-sp", action="store_true", help="do not download SP files")
    p.add_argument("--skip-nrt", action="store_true", help="do not call the NRT area API")
    p.add_argument("--refresh-listing", action="store_true", help="re-fetch the FIRMS listing")
    p.add_argument("--dry-run", action="store_true", help="print the plan and volume only")
    p.add_argument(
        "--upload", action="store_true", help="upload raw files to gs://$DATA_BUCKET/raw/"
    )
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    common.ensure_dirs()
    result = run(
        country_list=args.countries,
        sensors=args.sensors,
        years=_parse_years(args.years),
        skip_sp=args.skip_sp,
        skip_nrt=args.skip_nrt,
        refresh_listing=args.refresh_listing,
        dry_run=args.dry_run,
    )
    log.info("done: %s", result)
    if args.upload and not args.dry_run:
        n = upload_raw(common.RAW_DIR, Path(result["manifest"]))
        log.info("uploaded %d files to gs://%s/raw/", n, common.DATA_BUCKET)


if __name__ == "__main__":
    main()
