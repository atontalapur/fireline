#!/usr/bin/env bash
# Download the production dataset (public/v1/ in the data bucket) into data/v1/, so
# `docker build` and `gcloud run deploy --source .` bake it into the image (see Dockerfile).
# Figures stay in the bucket: the app links to them through DATA_BUCKET.
#
# Usage: scripts/fetch-data.sh            (DATA_BUCKET defaults to fireline-space-apps-data)
# Needs curl and python3. The bucket is public-read, so no gcloud login is required.
set -euo pipefail

BUCKET="${DATA_BUCKET:-fireline-space-apps-data}"
PREFIX="public/v1/"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/v1"
LIST_URL="https://storage.googleapis.com/storage/v1/b/$BUCKET/o?prefix=$PREFIX&fields=items(name,size,md5Hash)"

listing="$(curl -fsS "$LIST_URL")"
mapfile -t objects < <(printf '%s' "$listing" | python3 -c '
import json, sys
for item in json.load(sys.stdin).get("items", []):
    name = item["name"]
    if name.endswith("/") or "/figures/" in name:
        continue
    print(name + "\t" + item["size"] + "\t" + item.get("md5Hash", ""))
')

if [ "${#objects[@]}" -eq 0 ]; then
  echo "No files under gs://$BUCKET/$PREFIX" >&2
  exit 1
fi

mkdir -p "$OUT"
# Base64 MD5, the format the GCS JSON API reports in md5Hash.
md5_b64() { python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.md5(open(sys.argv[1], "rb").read()).digest()).decode())' "$1"; }

for entry in "${objects[@]}"; do
  IFS=$'\t' read -r name size md5 <<<"$entry"
  file="$OUT/${name#"$PREFIX"}"
  if [ -f "$file" ] && [ "$(wc -c < "$file")" -eq "$size" ] && { [ -z "$md5" ] || [ "$(md5_b64 "$file")" = "$md5" ]; }; then
    echo "up to date  ${name#"$PREFIX"}"
    continue
  fi
  curl -fsS -o "$file.part" "https://storage.googleapis.com/$BUCKET/$name"
  got="$(wc -c < "$file.part")"
  if [ "$got" -ne "$size" ] || { [ -n "$md5" ] && [ "$(md5_b64 "$file.part")" != "$md5" ]; }; then
    echo "Size or checksum mismatch for $name" >&2
    rm -f "$file.part"
    exit 1
  fi
  mv "$file.part" "$file"
  echo "downloaded  ${name#"$PREFIX"} ($size bytes)"
done

# Every non-figure file named in index.json must be present (deploy.sh runs the same check).
python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
names = [f["path"] for f in json.load(open(os.path.join(out, "index.json")))["files"] if not f["path"].startswith("figures/")]
missing = [n for n in names if not os.path.isfile(os.path.join(out, n))]
if missing:
    sys.exit(f"Missing in {out}: {', '.join(missing)}")
PY
echo "Dataset ready in $OUT"
