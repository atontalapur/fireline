# scripts

Deploy and data helpers (#4, #23). Both run from any directory.

| script | what |
|---|---|
| `fetch-data.sh` | Downloads the production dataset (`gs://fireline-space-apps-data/public/v1/`, minus figures) into `data/v1/`. Needs curl and python3; the bucket is public, so no login. Re-running skips files whose size and MD5 match the bucket, and the script fails if any file listed in `index.json` is missing. |
| `deploy.sh` | Builds the image with Cloud Build (`cloudbuild.yaml`, which passes the Maps browser key as a build arg) and deploys it to Cloud Run as a public service. Refuses to run from a dirty working tree (the image is tagged with the commit) or when any dataset file is missing, so the mock data never ships by accident. |

```bash
scripts/fetch-data.sh
scripts/deploy.sh   # reads .env; needs gcloud signed in to GOOGLE_CLOUD_PROJECT
```

`deploy.sh` replaces the service's env vars with these, taken from `.env` or the shell, and warns about each one that is unset (an unset var is removed from the service): `GOOGLE_CLOUD_PROJECT`, `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_LOCATION` (default `global`), `GOOGLE_MAPS_SERVER_KEY`, `DATA_BUCKET` (default `fireline-space-apps-data`), `PUBLIC_BASE_URL`. Optional overrides: `REGION` (default `us-central1`), `SERVICE` (default `fireline`).

The Cloud Run service account needs the Vertex AI User role for the chat to work.

`GOOGLE_MAPS_SERVER_KEY` is set as a plain env var, readable by anyone with view access to the service. Move it to Secret Manager (`--set-secrets`) if more people get project access.
