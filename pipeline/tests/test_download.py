import json
from datetime import date, timedelta

import pytest
import requests

import common
import download as dl

MODIS_HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,"
    "confidence,version,bright_t31,frp,daynight,type\n"
)
VIIRS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,"
    "confidence,version,bright_ti5,frp,daynight,type\n"
)
TODAY = date(2026, 11, 15)


def modis_csv(*dates: str) -> bytes:
    rows = "".join(
        f"30.1,75.2,310.5,1.0,1.0,{d},0530,Terra,MODIS,80,61.03,290,10,D,0\n" for d in dates
    )
    return (MODIS_HEADER + rows).encode()


def viirs_csv(*dates: str) -> bytes:
    rows = "".join(f"30.1,75.2,330.1,0.4,0.4,{d},0812,N20,VIIRS,n,2,290,5,D,0\n" for d in dates)
    return (VIIRS_HEADER + rows).encode()


class FakeResponse:
    def __init__(self, status: int, body: bytes = b"", headers: dict | None = None):
        self.status_code = status
        self.content = body
        self.headers = headers or {}

    @property
    def text(self) -> str:
        return self.content.decode()

    def iter_content(self, size):
        for i in range(0, len(self.content), max(size, 1)):
            yield self.content[i : i + size]

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    """Serves bodies by URL; `fail` maps URL -> list of statuses/exceptions to emit first."""

    def __init__(self, routes: dict, fail: dict | None = None, default=None):
        self.routes = routes
        self.fail = {k: list(v) for k, v in (fail or {}).items()}
        self.default = default
        self.calls: list[str] = []

    def get(self, url, headers=None, stream=False, timeout=None):
        self.calls.append(url)
        pending = self.fail.get(url)
        if pending:
            err = pending.pop(0)
            if isinstance(err, Exception):
                raise err
            return FakeResponse(err)
        body = self.routes.get(url)
        if body is None and self.default is not None:
            body = self.default(url)
        if body is None:
            return FakeResponse(404, b'{"error":"not found"}')
        return FakeResponse(200, body)


def fetcher(session) -> dl.Fetcher:
    clock = {"t": 0.0}

    def sleep(s):
        clock["t"] += s

    return dl.Fetcher(session, min_interval=0, backoff=0.01, sleep=sleep, clock=lambda: clock["t"])


def listing_text(files: dict[str, bytes]) -> bytes:
    lines = ["filename,size,updated", "AttributesReadme.txt,3178,2025-06-23 13:53:50"]
    lines += [f"{name},{len(body)},2026-10-10 08:56:42" for name, body in files.items()]
    return ("\n".join(lines) + "\n").encode()


def sp_site(files: dict[str, bytes]) -> dict:
    """URL routes for a fake FIRMS country site serving the given SP files."""
    routes = {dl.LISTING_URL: listing_text(files)}
    for name, body in files.items():
        prefix, year, _ = name.split("_", 2)
        routes[f"{dl.COUNTRY_DATA_URL}/{prefix}/{year}/{name}"] = body
    return routes


def full_sp_files() -> dict[str, bytes]:
    """Every SP file FIRMS actually lists for the demo countries (no NOAA-21, no 2026)."""
    files = {}
    for sensor, (prefix, first) in dl.SP_SENSORS.items():
        if sensor == "VIIRS_NOAA21":
            continue
        make = modis_csv if sensor == "MODIS" else viirs_csv
        for year in range(first, 2026):
            for country in dl.countries():
                files[f"{prefix}_{year}_{country}.csv"] = make(f"{year}-03-01", f"{year}-12-30")
    return files


def test_sp_file_naming():
    f = dl.SPFile("VIIRS_NOAA20", "India", 2019)
    assert f.url == (
        "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-jpss1/2019/"
        "viirs-jpss1_2019_India.csv"
    )
    assert f.relpath == "firms/SP/VIIRS_NOAA20/India/viirs-jpss1_2019_India.csv"


def test_retry_on_5xx_then_success(tmp_path):
    url = "https://example.test/f.csv"
    body = modis_csv("2001-01-01")
    session = FakeSession({url: body}, fail={url: [503, 502, requests.Timeout("slow")]})
    f = fetcher(session)
    n = f.download(url, tmp_path / "f.csv", expected_size=len(body))
    assert n == len(body)
    assert (tmp_path / "f.csv").read_bytes() == body
    assert not (tmp_path / "f.csv.part").exists()
    assert len(session.calls) == 4


def test_retry_gives_up(tmp_path):
    url = "https://example.test/f.csv"
    session = FakeSession({url: b"x"}, fail={url: [500] * 10})
    f = fetcher(session)
    f.max_retries = 2
    with pytest.raises(requests.HTTPError):
        f.get(url)
    assert len(session.calls) == 3


def test_4xx_is_not_retried():
    session = FakeSession({})
    with pytest.raises(requests.HTTPError):
        fetcher(session).get("https://example.test/missing.csv")
    assert len(session.calls) == 1


def test_backoff_is_exponential():
    url = "https://example.test/f.csv"
    session = FakeSession({url: b"ok"}, fail={url: [500, 500, 500]})
    waits = []
    f = dl.Fetcher(session, min_interval=0, backoff=2.0, sleep=waits.append)
    f.get(url)
    assert waits == [2.0, 4.0, 8.0]


def test_sp_cache_skip_on_rerun(tmp_path):
    files = {
        "modis_2000_India.csv": modis_csv("2000-11-01", "2000-12-31"),
        "modis_2001_India.csv": modis_csv("2001-01-05", "2001-12-31"),
    }
    session = FakeSession(sp_site(files))
    kw = dict(raw_dir=tmp_path, country_list=["India"], sensors=["MODIS"], years=(2000, 2001))
    first = dl.run(fetcher=fetcher(session), map_key="", today=TODAY, **kw)
    assert first["sp_downloaded"] == 2
    for name, body in files.items():
        assert (tmp_path / "firms/SP/MODIS/India" / name).read_bytes() == body

    session.calls.clear()
    second = dl.run(fetcher=fetcher(session), map_key="", today=TODAY, **kw)
    assert second["sp_downloaded"] == 0
    assert session.calls == []  # listing is cached too


def test_sp_redownloads_truncated_file(tmp_path):
    body = modis_csv("2000-11-01", "2000-12-31")
    files = {"modis_2000_India.csv": body}
    dest = tmp_path / "firms/SP/MODIS/India/modis_2000_India.csv"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(body[:10])
    session = FakeSession(sp_site(files))
    out = dl.run(
        raw_dir=tmp_path,
        country_list=["India"],
        sensors=["MODIS"],
        years=(2000, 2000),
        map_key="",
        fetcher=fetcher(session),
        today=TODAY,
    )
    assert out["sp_downloaded"] == 1
    assert dest.read_bytes() == body


def test_resume_from_part(tmp_path):
    url = "https://example.test/f.csv"
    body = modis_csv("2001-01-01", "2001-01-02")
    dest = tmp_path / "f.csv"
    (tmp_path / "f.csv.part").write_bytes(body[:20])
    seen = {}

    class RangeSession(FakeSession):
        def get(self, url, headers=None, stream=False, timeout=None):
            seen["headers"] = headers
            start = int(headers["Range"].split("=")[1].rstrip("-"))
            return FakeResponse(206, body[start:])

    dl.Fetcher(RangeSession({}), min_interval=0).download(url, dest, expected_size=len(body))
    assert seen["headers"] == {"Range": "bytes=20-"}
    assert dest.read_bytes() == body


def test_chunk_dates_five_days():
    chunks = dl.chunk_dates(date(2026, 1, 1), date(2026, 1, 12))
    assert chunks == [
        (date(2026, 1, 1), date(2026, 1, 5)),
        (date(2026, 1, 6), date(2026, 1, 10)),
        (date(2026, 1, 11), date(2026, 1, 12)),
    ]
    assert dl.chunk_dates(date(2026, 1, 2), date(2026, 1, 1)) == []


def test_chunk_dates_cover_window_without_gaps():
    start, end = date(2023, 3, 1), TODAY
    chunks = dl.chunk_dates(start, end)
    assert chunks[0][0] == start and chunks[-1][1] == end
    for (_, e1), (s2, _) in zip(chunks, chunks[1:], strict=False):
        assert s2 == e1 + timedelta(days=1)
    assert all(1 <= (e - s).days + 1 <= 5 for s, e in chunks)


def test_nrt_window_starts_after_sp():
    assert dl.nrt_window("MODIS", date(2025, 12, 31), TODAY) == (date(2026, 1, 1), TODAY)
    assert dl.nrt_window("MODIS", TODAY, TODAY) is None
    assert dl.nrt_window("VIIRS_NOAA21", None, TODAY) == (dl.NRT_EARLIEST["VIIRS_NOAA21"], TODAY)
    avail = (date(2024, 1, 17), date(2026, 11, 14))
    assert dl.nrt_window("VIIRS_NOAA21", None, TODAY, avail) == avail


def test_nrt_plan_never_overlaps_sp():
    sp = [
        {"sensor": "MODIS", "country": c, "coverage_end": "2025-12-31", "complete": True}
        for c in dl.countries()
    ] + [
        {"sensor": "VIIRS_NOAA20", "country": "India", "coverage_end": "2026-02-10"},
    ]
    chunks, windows = dl.nrt_plan(sp, TODAY, dl.SP_SENSORS, dl.countries())
    assert chunks
    sp_end = {(e["sensor"], e["country"]): date.fromisoformat(e["coverage_end"]) for e in sp}
    for c in chunks:
        if (c.sensor, c.country) in sp_end:
            assert c.start > sp_end[(c.sensor, c.country)]
        assert c.days <= dl.NRT_CHUNK_DAYS
        assert c.sensor in dl.NRT_SOURCES  # no S-NPP NRT
    assert windows[("VIIRS_NOAA20", "punjab")][0] == date(2026, 2, 11)
    assert windows[("VIIRS_NOAA21", "pantanal")][0] == dl.NRT_EARLIEST["VIIRS_NOAA21"]


def test_nrt_plan_skips_incomplete_sp():
    sp = [{"sensor": "MODIS", "country": "India", "coverage_end": "2000-12-31", "complete": False}]
    chunks, windows = dl.nrt_plan(sp, TODAY, ["MODIS"], ["India"])
    assert chunks == [] and windows == {}


def test_nrt_url_format():
    c = dl.NRTChunk("MODIS", "punjab", "India", date(2026, 1, 1), date(2026, 1, 5))
    assert c.url("KEY") == (
        "https://firms.modaps.eosdis.nasa.gov/api/area/csv/KEY/MODIS_NRT/"
        "73.8,29.5,77,32.6/5/2026-01-01"
    )
    assert c.relpath == "firms/NRT/MODIS/India/MODIS_NRT_punjab_2026-01-01_2026-01-05.csv"


def test_tx_budget_waits_when_full():
    clock = {"t": 0.0}
    waits = []

    def sleep(s):
        waits.append(s)
        clock["t"] += s

    b = dl.TxBudget(limit=10, window=600, sleep=sleep, clock=lambda: clock["t"])
    b.spend(5)
    b.spend(5)
    assert waits == []
    b.spend(5)
    assert waits == [600]


def test_skip_nrt_without_key(tmp_path, caplog):
    files = {"modis_2000_India.csv": modis_csv("2000-11-01")}
    session = FakeSession(sp_site(files))
    out = dl.run(
        raw_dir=tmp_path,
        country_list=["India"],
        sensors=["MODIS"],
        years=(2000, 2000),
        map_key="",
        fetcher=fetcher(session),
        today=TODAY,
    )
    assert out["nrt_downloaded"] == 0
    assert "FIRMS_MAP_KEY is empty" in caplog.text
    assert not any("/api/" in u for u in session.calls)


def test_full_run_manifest_and_nrt(tmp_path):
    files = full_sp_files()
    routes = sp_site(files)
    routes[f"{dl.AVAILABILITY_URL}/KEY/all"] = (
        b"data_id,min_date,max_date\n"
        b"MODIS_NRT,2025-09-01,2026-11-15\n"
        b"VIIRS_NOAA20_NRT,2025-09-01,2026-11-15\n"
        b"VIIRS_NOAA21_NRT,2024-01-17,2026-11-15\n"
    )

    def nrt_body(url):
        if "/api/area/csv/KEY/" not in url:
            return None
        source, _, days, start = url.split("/")[-4:]
        make = modis_csv if source == "MODIS_NRT" else viirs_csv
        return make(start)

    session = FakeSession(routes, default=nrt_body)
    out = dl.run(raw_dir=tmp_path, map_key="KEY", fetcher=fetcher(session), today=TODAY)
    assert out["sp_downloaded"] == len(files)

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert set(manifest) >= {"generated_at", "entries"}
    entries = {(e["product"], e["sensor"], e["country"]): e for e in manifest["entries"]}

    modis = entries[("SP", "MODIS", "India")]
    assert modis["first_date"] == "2000-03-01"
    assert modis["last_date"] == "2025-12-30"
    assert modis["coverage_end"] == "2025-12-31"
    assert modis["rows"] == 2 * 26
    assert len(modis["files"]) == 26
    assert all((tmp_path / f).exists() for f in modis["files"])
    assert ("SP", "VIIRS_NOAA21", "India") not in entries

    # Every sensor has coverage in every country (NOAA-21 via NRT).
    for country in dl.countries():
        for sensor in dl.SP_SENSORS:
            assert any(k[1:] == (sensor, country) for k in entries), (sensor, country)

    # NRT starts the day after SP coverage, NOAA-21 at the availability start.
    nrt_modis = entries[("NRT", "MODIS", "India")]
    assert nrt_modis["coverage_start"] == "2026-01-01"
    assert nrt_modis["coverage_end"] == str(TODAY)
    assert nrt_modis["region"] == "punjab"
    assert entries[("NRT", "VIIRS_NOAA21", "Brazil")]["coverage_start"] == "2024-01-17"

    api_calls = [u for u in session.calls if "/api/area/" in u]
    for u in api_calls:
        source, _, days, start = u.split("/")[-4:]
        assert 1 <= int(days) <= dl.NRT_CHUNK_DAYS
        if source != "VIIRS_NOAA21_NRT":
            assert date.fromisoformat(start) >= date(2026, 1, 1)
    assert not any("VIIRS_SNPP" in u for u in api_calls)

    missing = {(m["sensor"], m["year"]) for m in manifest["missing_sp"]}
    assert ("VIIRS_NOAA21", 2023) in missing and ("MODIS", 2026) in missing

    # Re-run: SP is cached, only the unsettled NRT chunks near today are fetched again.
    session.calls.clear()
    again = dl.run(raw_dir=tmp_path, map_key="KEY", fetcher=fetcher(session), today=TODAY)
    assert again["sp_downloaded"] == 0
    assert not any("/data/country/" in u for u in session.calls)
    assert again["nrt_downloaded"] <= 2 * len(common.REGIONS) * len(dl.NRT_SOURCES)


def test_nrt_error_text_raises(tmp_path):
    c = dl.NRTChunk("MODIS", "punjab", "India", date(2026, 1, 1), date(2026, 1, 5))
    session = FakeSession({c.url("KEY"): b"Invalid MAP_KEY."})
    with pytest.raises(RuntimeError, match="Invalid MAP_KEY"):
        dl.download_nrt([c], fetcher(session), tmp_path, "KEY", TODAY)


def test_prune_stale_nrt(tmp_path):
    keep = dl.NRTChunk("MODIS", "punjab", "India", date(2026, 1, 1), date(2026, 1, 5))
    stale = tmp_path / "firms/NRT/MODIS/India/MODIS_NRT_punjab_2025-12-27_2025-12-31.csv"
    stale.parent.mkdir(parents=True)
    stale.write_text(MODIS_HEADER)
    (tmp_path / keep.relpath).write_text(MODIS_HEADER)
    assert dl.prune_stale_nrt([keep], tmp_path, ["MODIS"]) == 1
    assert not stale.exists() and (tmp_path / keep.relpath).exists()


def test_upload_raw(tmp_path, monkeypatch):
    rel = "firms/SP/MODIS/India/modis_2000_India.csv"
    (tmp_path / rel).parent.mkdir(parents=True)
    (tmp_path / rel).write_bytes(modis_csv("2000-11-01"))
    manifest = dl.write_manifest(
        tmp_path, [dl.summarize("SP", "MODIS", "India", [(rel, dl.csv_stats(tmp_path / rel))])], []
    )
    sent = []
    monkeypatch.setattr(common, "upload_to_gcs", lambda local, dest: sent.append(dest))
    assert dl.upload_raw(tmp_path, manifest) == 2
    assert sent == [f"raw/{rel}", "raw/manifest.json"]


def test_parse_years():
    assert dl._parse_years("2000") == (2000, 2000)
    assert dl._parse_years("2000-2005") == (2000, 2005)
    assert dl._parse_years(None) is None


def test_mid_stream_failure_resumes(tmp_path):
    url = "https://example.test/f.csv"
    body = modis_csv("2001-01-01", "2001-01-02", "2001-01-03")
    ranges = []

    class Broken(FakeResponse):
        def iter_content(self, size):
            yield self.content[:30]
            raise requests.exceptions.ChunkedEncodingError("connection reset")

    class FlakySession(FakeSession):
        def get(self, url, headers=None, stream=False, timeout=None):
            ranges.append(headers)
            if headers is None:
                return Broken(200, body)
            start = int(headers["Range"].split("=")[1].rstrip("-"))
            return FakeResponse(206, body[start:])

    f = fetcher(FlakySession({}))
    assert f.download(url, tmp_path / "f.csv", expected_size=len(body)) == len(body)
    assert (tmp_path / "f.csv").read_bytes() == body
    assert ranges == [None, {"Range": "bytes=30-"}]
