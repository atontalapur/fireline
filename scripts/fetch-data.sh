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
LIST_URL="https://storage.googleapis.com/storage/v1/b/$BUCKET/o?prefix=$PREFIX&fields=items(name,size)"

listing="$(curl -fsS "$LIST_URL")"
mapfile -t objects < <(printf '%s' "$listing" | python3 -c '
import json, sys
for item in json.load(sys.stdin).get("items", []):
    name = item["name"]
    if name.endswith("/") or "/figures/" in name:
        continue
    print(name + "\t" + item["size"])
')

if [ "${#objects[@]}" -eq 0 ]; then
  echo "No files under gs://$BUCKET/$PREFIX" >&2
  exit 1
fi

mkdir -p "$OUT"
for entry in "${objects[@]}"; do
  name="${entry%%$'\t'*}"
  size="${entry##*$'\t'}"
  file="$OUT/${name#"$PREFIX"}"
  if [ -f "$file" ] && [ "$(wc -c < "$file")" -eq "$size" ]; then
    echo "up to date  ${name#"$PREFIX"}"
    continue
  fi
  curl -fsS -o "$file.part" "https://storage.googleapis.com/$BUCKET/$name"
  got="$(wc -c < "$file.part")"
  if [ "$got" -ne "$size" ]; then
    echo "Size mismatch for $name: expected $size, got $got" >&2
    rm -f "$file.part"
    exit 1
  fi
  mv "$file.part" "$file"
  echo "downloaded  ${name#"$PREFIX"} ($size bytes)"
done

for required in monthly.parquet coverage_month.parquet index.json; do
  [ -f "$OUT/$required" ] || { echo "Missing $required in $OUT" >&2; exit 1; }
done
echo "Dataset ready in $OUT"
