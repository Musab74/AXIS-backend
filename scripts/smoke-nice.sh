#!/usr/bin/env bash
# Smoke: NICE return bridge + optional /auth/nice/request (needs MySQL + running API).
# Usage: SMOKE_BASE_URL=http://127.0.0.1:3333 bash scripts/smoke-nice.sh
set -euo pipefail
BASE="${SMOKE_BASE_URL:-http://127.0.0.1:3333}"
TMP1="$(mktemp)"
TMP2="$(mktemp)"
trap 'rm -f "$TMP1" "$TMP2"' EXIT

echo "== NICE smoke (BASE=$BASE) =="

curl -sfS --max-time 8 "$BASE/auth/nice/checkplus-return" -o "$TMP1"
grep -q 'AXIS_NICE_RESULT' "$TMP1" || { echo "FAIL: GET checkplus-return missing AXIS_NICE_RESULT"; exit 1; }
grep -q 'postMessage' "$TMP1" || { echo "FAIL: bridge HTML missing postMessage"; exit 1; }
echo "OK: GET /auth/nice/checkplus-return returns bridge HTML"

curl -sfS --max-time 8 -X POST "$BASE/auth/nice/checkplus-return" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'EncodeData=smoke_test_cipher_blob' -o "$TMP2"
grep -q 'smoke_test_cipher_blob' "$TMP2" || { echo "FAIL: POST EncodeData not embedded in JSON"; exit 1; }
echo "OK: POST EncodeData echoed in postMessage payload"

if RESP="$(curl -sfS --max-time 15 -X POST "$BASE/auth/nice/request" \
  -H 'Content-Type: application/json' \
  -d '{"authType":"CHECKPLUS"}' 2>/dev/null)"; then
  if echo "$RESP" | grep -q '"encData"'; then
    echo "OK: POST /auth/nice/request returned JSON with encData (DB + NICE env OK)"
  else
    echo "WARN: /auth/nice/request response unexpected: ${RESP:0:200}"
  fi
else
  echo "WARN: /auth/nice/request unreachable or failed (start API + DB, set NICE_* in .env)"
fi

echo "== done =="
