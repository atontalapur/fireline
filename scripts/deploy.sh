#!/usr/bin/env bash
# Build the image with Cloud Build and deploy it to Cloud Run.
#
# `gcloud run deploy --source .` cannot pass Docker build args, and the Maps browser key
# (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) must be present at build time, so this script builds with
# Cloud Build (cloudbuild.yaml) and then deploys the pushed image.
#
# Usage:
#   scripts/fetch-data.sh        # bake the production dataset into the image
#   scripts/deploy.sh            # reads .env from the repo root if present
#
# Required: GOOGLE_CLOUD_PROJECT. Optional: REGION (us-central1), SERVICE (fireline),
# NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_SERVER_KEY, GEMINI_MODEL, GEMINI_LOCATION,
# DATA_BUCKET, PUBLIC_BASE_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT (see infra/README.md)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-fireline}"
REPO="cloud-run-source-deploy"
IMAGE="$REGION-docker.pkg.dev/$GOOGLE_CLOUD_PROJECT/$REPO/$SERVICE:$(git rev-parse --short HEAD)"

if [ ! -f data/v1/monthly.parquet ]; then
  echo "data/v1/ is empty, so the image would ship the mock data. Run scripts/fetch-data.sh first." >&2
  exit 1
fi

if ! gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" --repository-format docker \
    --location "$REGION" --project "$GOOGLE_CLOUD_PROJECT"
fi

gcloud builds submit . \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --config cloudbuild.yaml \
  --substitutions "_IMAGE=$IMAGE,_MAPS_BROWSER_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:-}"

# Env vars go in a temporary YAML file so values with commas or spaces survive.
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
emit() { [ -n "${2:-}" ] && printf '%s: "%s"\n' "$1" "$2" >> "$ENV_FILE" || true; }
emit GOOGLE_CLOUD_PROJECT "$GOOGLE_CLOUD_PROJECT"
emit GEMINI_MODEL "${GEMINI_MODEL:-gemini-3.5-flash}"
emit GEMINI_LOCATION "${GEMINI_LOCATION:-global}"
emit GOOGLE_MAPS_SERVER_KEY "${GOOGLE_MAPS_SERVER_KEY:-}"
emit DATA_BUCKET "${DATA_BUCKET:-}"
emit PUBLIC_BASE_URL "${PUBLIC_BASE_URL:-}"

gcloud run deploy "$SERVICE" \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --max-instances 3 \
  --env-vars-file "$ENV_FILE"

URL="$(gcloud run services describe "$SERVICE" --project "$GOOGLE_CLOUD_PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "Deployed: $URL"
for path in / /method "/api/weather?region=pantanal&month=2020-09"; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$URL$path")" "$path"
done
