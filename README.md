# Fireline

Pick any area, see how much it has burned each month since 2000 on one consistent scale, see whether the current month is abnormal, and download the numbers.

Fireline merges NASA FIRMS MODIS (2000-, 1 km) and VIIRS (2012-, 375 m) hotspots into one harmonized series of MODIS-equivalent fire cell-days, so the 26-year MODIS record keeps going after Terra and Aqua retire.

- Live app: _TBD_
- Demo video: _TBD_
- Challenge: [NASA Space Apps 2026, Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/)

## Repo layout

| folder | what |
|---|---|
| `pipeline/` | Python data pipeline: download, clean, aggregate, calibrate, splice, validate, export |
| `app/` | Next.js app and API |
| `mcp/` | MCP server exposing the fire-history tools |
| `contracts/` | shared data and API formats, plus mock data |
| `docs/` | method write-up and submission text |
| `infra/` | Google Cloud setup |
| `scripts/` | deploy and data helpers |

## Run locally

App (Node 24). With no setup it reads the mock data in `contracts/mock/`:

```bash
cd app
npm install
npm run dev
```

Set `APP_DATA_DIR` to a folder with the real `public/v1/` files to use production data.

Pipeline (Python, uv):

```bash
cd pipeline
uv sync
uv run pytest
```

Container:

```bash
docker build -t fireline .
docker run -p 8080:8080 fireline
```

## Team

_TBD_

## License

Apache-2.0. See [LICENSE](LICENSE).
