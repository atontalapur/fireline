#!/usr/bin/env bash
# Set up the Fireline Google Cloud project: APIs, data bucket, Maps keys,
# teammate access, and a Vertex AI Gemini test call.
#
# Safe to re-run. Existing resources are kept; key restrictions are re-applied.
#
# Required env vars:
#   PROJECT_ID       Google Cloud project ID (project must already exist with billing)
#   DATA_BUCKET      bucket name, without gs://
# Optional env vars:
#   REGION           default us-central1 (bucket location and Vertex AI region)
#   TEAMMATE_EMAIL   Google account to grant roles/editor; skipped if empty
#   RUN_APP_URL      Cloud Run service URL, e.g. https://fireline-abc123-uc.a.run.app
#   CUSTOM_DOMAIN    custom domain, e.g. fireline.example.com
#   GEMINI_MODEL     default gemini-2.5-flash
#
# Usage:
#   PROJECT_ID=my-proj DATA_BUCKET=my-bucket TEAMMATE_EMAIL=a@b.com bash infra/setup_gcp.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${DATA_BUCKET:?set DATA_BUCKET}"
REGION="${REGION:-us-central1}"
TEAMMATE_EMAIL="${TEAMMATE_EMAIL:-}"
RUN_APP_URL="${RUN_APP_URL:-}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"

BROWSER_KEY_ID="fireline-maps-browser"
SERVER_KEY_ID="fireline-maps-server"

log() { printf '\n==> %s\n' "$*"; }

command -v gcloud >/dev/null || { echo "gcloud not found" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }
gcloud --version >/dev/null || { echo "gcloud is installed but broken; see infra/README.md" >&2; exit 1; }

gcloud config set project "$PROJECT_ID" >/dev/null

log "Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  aiplatform.googleapis.com \
  maps-backend.googleapis.com \
  places.googleapis.com \
  geocoding-backend.googleapis.com \
  storage.googleapis.com \
  apikeys.googleapis.com \
  --project="$PROJECT_ID"

log "Bucket gs://$DATA_BUCKET"
if gcloud storage buckets describe "gs://$DATA_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "exists"
else
  gcloud storage buckets create "gs://$DATA_BUCKET" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --no-public-access-prevention
fi
# Re-assert settings in case the bucket was created by hand.
gcloud storage buckets update "gs://$DATA_BUCKET" \
  --uniform-bucket-level-access \
  --no-public-access-prevention
# Public read covers every prefix (raw/, processed/, public/). Bindings are idempotent.
gcloud storage buckets add-iam-policy-binding "gs://$DATA_BUCKET" \
  --member=allUsers \
  --role=roles/storage.objectViewer >/dev/null

log "Maps API keys"
referrers="http://localhost:3000/*"
[[ -n "$RUN_APP_URL" ]] && referrers+=",${RUN_APP_URL%/}/*"
[[ -n "$CUSTOM_DOMAIN" ]] && referrers+=",https://${CUSTOM_DOMAIN}/*"
[[ -z "$RUN_APP_URL" ]] && echo "RUN_APP_URL not set; re-run after the first Cloud Run deploy to add it."
[[ -z "$CUSTOM_DOMAIN" ]] && echo "CUSTOM_DOMAIN not set; re-run once the domain is live to add it."

key_exists() {
  gcloud services api-keys describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1
}

browser_flags=(
  --allowed-referrers="$referrers"
  --api-target=service=maps-backend.googleapis.com
  --api-target=service=places.googleapis.com
)
if key_exists "$BROWSER_KEY_ID"; then
  gcloud services api-keys update "$BROWSER_KEY_ID" --project="$PROJECT_ID" "${browser_flags[@]}"
else
  gcloud services api-keys create --project="$PROJECT_ID" \
    --key-id="$BROWSER_KEY_ID" \
    --display-name="Fireline Maps browser key" \
    "${browser_flags[@]}"
fi

server_flags=(--api-target=service=geocoding-backend.googleapis.com)
if key_exists "$SERVER_KEY_ID"; then
  gcloud services api-keys update "$SERVER_KEY_ID" --project="$PROJECT_ID" "${server_flags[@]}"
else
  gcloud services api-keys create --project="$PROJECT_ID" \
    --key-id="$SERVER_KEY_ID" \
    --display-name="Fireline Maps server key" \
    "${server_flags[@]}"
fi

echo "Key strings are not printed. Copy them into .env with:"
echo "  gcloud services api-keys get-key-string $BROWSER_KEY_ID --project=$PROJECT_ID   # NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"
echo "  gcloud services api-keys get-key-string $SERVER_KEY_ID --project=$PROJECT_ID    # GOOGLE_MAPS_SERVER_KEY"

if [[ -n "$TEAMMATE_EMAIL" ]]; then
  log "Granting roles/editor to $TEAMMATE_EMAIL"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="user:$TEAMMATE_EMAIL" \
    --role=roles/editor \
    --condition=None >/dev/null
else
  log "TEAMMATE_EMAIL not set; skipping teammate grant"
fi

log "Vertex AI test call ($GEMINI_MODEL in $REGION)"
token="$(gcloud auth print-access-token)"
endpoint="https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent"
response="$(curl -sS -X POST "$endpoint" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with one short sentence: what does NASA FIRMS provide?"}]}]}')"

if grep -q '"text"' <<<"$response"; then
  echo "$response" | grep '"text"' | head -n 1
  log "Done"
else
  echo "Gemini call did not return text. Response:" >&2
  echo "$response" >&2
  echo "If the trial blocks Vertex AI, use the Azure OpenAI fallback (infra/README.md)." >&2
  exit 1
fi
