#!/usr/bin/env bash
# Run the Fireline pipeline end to end (A1-A7).
# Usage: pipeline/run_all.sh [--upload]
#   --upload  passed to export.py: publish PUBLIC_DIR to gs://$DATA_BUCKET/public/v1/
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

export_args=()
for arg in "$@"; do
  case "$arg" in
    --upload) export_args+=(--upload) ;;
    -h | --help)
      sed -n '2,4p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Run one stage, print its wall time, and return its exit status.
run_step() {
  local script=$1
  shift
  local start=$SECONDS status=0
  echo "==> $script $*"
  uv run python "$script" "$@" || status=$?
  echo "<== $script: exit $status, $((SECONDS - start))s"
  return "$status"
}

# Tier-3 stage: skipped if the file is missing, and a failure does not stop the run.
run_optional() {
  local script=$1
  if [[ ! -f "$script" ]]; then
    echo "--- $script not found, skipping"
    return 0
  fi
  run_step "$script" || echo "warning: optional step $script failed, continuing" >&2
}

total_start=$SECONDS
uv sync

run_step download.py
run_step clean.py
run_step cell_days.py
run_step calibrate.py
run_step splice.py
run_step validate.py
run_optional weather.py
run_optional sentinel3.py
run_step export.py ${export_args[@]+"${export_args[@]}"}

echo "pipeline done in $((SECONDS - total_start))s"
