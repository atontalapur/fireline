# Infra setup

One Google Cloud project hosts everything: Cloud Run, Vertex AI (Gemini), Maps Platform and Cloud Storage.

| Setting | Value |
| --- | --- |
| Project ID | `fireline-nasa-2026` |
| Region | `us-central1` |
| Data bucket | `gs://fireline-nasa-2026-data` (public read, GET/HEAD CORS) |
| Gemini | `gemini-3.5-flash`, `global` endpoint |
| Billing | "My Billing Account", $10/month budget alert at 50%, 90%, 100% |
| Cloud Run URL | `<RUN_APP_URL>` |
| Custom domain | `<CUSTOM_DOMAIN>` |

Fill in the Cloud Run URL and custom domain after the first deploy.

## 1. Manual steps (console)

- [ ] Claim the Google Cloud Global Offer ($300 trial) and attach the billing account.
- [ ] Create the project and note its ID above.
- [ ] Get a FIRMS MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
- [ ] Create a NASA Earthdata login: https://urs.earthdata.nasa.gov/
- [ ] Get Meteomatics credentials (Global Offer) for `METEOMATICS_USERNAME` / `METEOMATICS_PASSWORD`.

The script below grants the teammate Editor. If you skip it, add them in IAM & Admin > IAM > Grant access, role Editor, and check they can open the console.

## 2. Local gcloud

`gcloud` must run before the script will work. If it fails because the Homebrew `python@3.14` path it points to is missing, point it at another Python 3:

```bash
export CLOUDSDK_PYTHON="$(command -v python3)"   # add to ~/.zshrc to keep it
```

Then sign in:

```bash
gcloud auth login
gcloud auth application-default login   # used by pipeline/export.py --upload
gcloud --version
```

## 3. Run the setup script

```bash
PROJECT_ID=fireline-nasa-2026 \
DATA_BUCKET=fireline-nasa-2026-data \
TEAMMATE_EMAIL=<teammate@gmail.com> \
bash infra/setup_gcp.sh
```

Optional: `REGION` (default `us-central1`), `RUN_APP_URL`, `CUSTOM_DOMAIN`, `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_LOCATION` (default `global`).

The script:

1. Enables Cloud Run, Artifact Registry, Cloud Build, Vertex AI, Maps JavaScript API, Places API (New), Geocoding API, Cloud Storage and the API Keys API.
2. Creates the bucket with uniform bucket-level access and grants `allUsers` Storage Object Viewer. This makes every prefix (`raw/`, `processed/`, `public/`) publicly readable.
3. Creates two Maps keys:
   - `fireline-maps-browser`: referrers `http://localhost:3000/*`, the run.app URL and the custom domain; APIs Maps JavaScript + Places (New).
   - `fireline-maps-server`: API restricted to Geocoding.
4. Grants `TEAMMATE_EMAIL` the Editor role.
5. Sends one Gemini request to Vertex AI (global endpoint) and prints the reply.

It is safe to re-run. The Cloud Run URL and custom domain are not known on day one, so re-run with `RUN_APP_URL` and `CUSTOM_DOMAIN` set after the first deploy to update the browser key referrers.

Copy the key strings into `.env` (see `.env.example`):

```bash
gcloud services api-keys get-key-string fireline-maps-browser --project=fireline-nasa-2026
gcloud services api-keys get-key-string fireline-maps-server --project=fireline-nasa-2026
```

## 4. Environment variables

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored. Do not commit keys.

## Fallback: Azure OpenAI

If the trial blocks Vertex AI (the test call returns a quota or billing error), note the error here and switch the AI analyst to Azure OpenAI. Create an Azure OpenAI resource, deploy a small chat model, and add its endpoint, key and deployment name to `.env`. Hosting and maps stay on Google.
