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
DATA_BUCKET="${DATA_BUCKET:-fireline-space-apps-data}"

# Cloud Build uploads the working tree, so tag only clean trees with the commit they match.
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes; commit or stash them before deploying." >&2
  exit 1
fi
IMAGE="$REGION-docker.pkg.dev/$GOOGLE_CLOUD_PROJECT/$REPO/$SERVICE:$(git rev-parse --short HEAD)"

# Without the full dataset in data/v1/ the image would ship the mock data or a partial set.
if [ ! -f data/v1/index.json ]; then
  echo "data/v1/ is empty. Run scripts/fetch-data.sh first." >&2
  exit 1
fi
python3 - data/v1 <<'PY'
import json, os, sys
out = sys.argv[1]
names = [f["path"] for f in json.load(open(os.path.join(out, "index.json")))["files"] if not f["path"].startswith("figures/")]
missing = [n for n in names if not os.path.isfile(os.path.join(out, n))]
if missing:
    sys.exit(f"Missing in {out}: {', '.join(missing)}. Run scripts/fetch-data.sh.")
PY

if ! gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" --repository-format docker \
    --location "$REGION" --project "$GOOGLE_CLOUD_PROJECT"
fi

gcloud builds submit . \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --config cloudbuild.yaml \
  --substitutions "_IMAGE=$IMAGE,_MAPS_BROWSER_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:-}"

# --env-vars-file replaces every env var on the service, so the file is the complete set.
# Values are JSON-encoded, which YAML reads as double-quoted strings, so any character is safe.
# Unset optional vars are left out and named below, since leaving them out removes them.
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}" GEMINI_LOCATION="${GEMINI_LOCATION:-global}" \
DATA_BUCKET="$DATA_BUCKET" python3 - "$ENV_FILE" <<'PY'
import json, os, sys
names = ["GOOGLE_CLOUD_PROJECT", "GEMINI_MODEL", "GEMINI_LOCATION", "DATA_BUCKET", "GOOGLE_MAPS_SERVER_KEY", "PUBLIC_BASE_URL"]
with open(sys.argv[1], "w") as f:
    for n in names:
        v = os.environ.get(n, "")
        if v:
            f.write(f"{n}: {json.dumps(v)}\n")
        else:
            print(f"warning: {n} is not set, so the service will run without it", file=sys.stderr)
PY

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
