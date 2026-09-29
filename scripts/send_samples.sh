#!/usr/bin/env bash
# POSTs every sample in tests/samples.json to the n8n webhook and writes the returned records
# to outputs/outputs.json.
#   ./scripts/send_samples.sh                       # production URL (workflow must be Active)
#   URL=http://localhost:5678/webhook-test/arcvault/intake ./scripts/send_samples.sh
#                                                   # test URL (click "Listen for test event" first;
#                                                   # it only accepts ONE request per click)
# Sleeps between requests: 2 Gemini calls per sample, free tier is 15 requests/minute.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${URL:-http://localhost:5678/webhook/arcvault/intake}"
SAMPLES="${1:-$ROOT/tests/samples.json}"
OUT="${OUT:-$ROOT/outputs/outputs.json}"
DELAY="${DELAY:-10}"

count=$(jq length "$SAMPLES")
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

for i in $(seq 0 $((count - 1))); do
  body=$(jq -c ".[$i] | {source, message}" "$SAMPLES")
  echo "[$((i + 1))/$count] $(jq -r ".[$i].message // \"<null>\" | .[0:60]" "$SAMPLES")..." >&2
  start=$SECONDS
  resp=$(curl -sS --fail-with-body -X POST "$URL" -H 'Content-Type: application/json' -d "$body")
  echo "$resp" | jq -c --arg s "$((SECONDS - start))" '{seconds: ($s | tonumber), category: .classification.category, priority: .classification.priority,
    confidence: .classification.confidence, final_queue: .routing.final_queue,
    reasons: .escalation.reasons}' >&2
  echo "$resp" >> "$tmp"
  [ "$i" -lt $((count - 1)) ] && sleep "$DELAY"
done

jq -s '.' "$tmp" > "$OUT"
echo "wrote $OUT" >&2
