#!/usr/bin/env bash
# Smoke-test a deployed WindChaser: the pages render and the APIs answer with
# real data. Usage: scripts/smoke_test.sh https://windchaser.io
set -euo pipefail

base="${1:?usage: smoke_test.sh <base-url>}"
failures=0

fetch() {
  # Retries cover the minute after a deploy while CloudFront picks it up.
  curl --silent --show-error --fail --retry 5 --retry-delay 10 --retry-all-errors \
    --max-time 30 "$base$1"
}

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    failures=$((failures + 1))
  fi
}

health() {
  local body
  body="$(fetch /api/health)" || return 1
  jq -e '.status == "ok" and .credentials.resolved and .calibration.rider_model
    and .calibration.segments > 0' <<<"$body" >/dev/null
}

page_contains() {
  fetch "$1" | grep -q "$2"
}

training_loads() {
  local body
  body="$(fetch /training)" || return 1
  grep -q "Training" <<<"$body" && ! grep -q "Training is unavailable" <<<"$body"
}

heatmap() {
  fetch /api/training/heatmap | jq -e 'length > 0' >/dev/null
}

performance() {
  fetch /api/training/performance | jq -e '.ftp != null' >/dev/null
}

check "health: credentials, calibration and rider model resolve" health
check "wind view renders" page_contains / "WindChaser"
check "training overview renders with data" training_loads
check "data version answers" page_contains /api/training/data-version "version"
check "heatmap has routes" heatmap
check "performance has an FTP" performance

if [ "$failures" -gt 0 ]; then
  echo "$failures smoke check(s) failed against $base"
  exit 1
fi
echo "All smoke checks passed against $base"
