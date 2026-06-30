#!/usr/bin/env bash
# AXIS API smoke test — READ-ONLY, safe for production (no DB writes).
#
# Usage:
#   bash scripts/api-smoke.sh
#   AXIS_API_BASE=http://127.0.0.1:3333 bash scripts/api-smoke.sh
#
# Checks:
#   1. Backend alive (Swagger JSON)
#   2. Public marketing / registration endpoints respond
#   3. Auth guards return 401 on protected routes
#   4. /auth/refresh rejects invalid tokens
#   5. Demo exam paper + grading for all cert × level combos
#   6. Critical exam-flow routes are mounted in Swagger
set -euo pipefail

# Prefer 127.0.0.1 — on some hosts "localhost" resolves to ::1 while Node binds IPv4 only.
API="${AXIS_API_BASE:-http://127.0.0.1:3333}"
PASS=0
FAIL=0
FAIL_MSGS=()

ok()   { printf '  [PASS] %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); FAIL_MSGS+=("$1"); }
section() { printf '\n=== %s ===\n' "$1"; }

http() {
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o /tmp/smoke-body.json -w '%{http_code}' \
      -X "$method" -H "Content-Type: application/json" -d "$body" "$url"
  else
    curl -sS -o /tmp/smoke-body.json -w '%{http_code}' -X "$method" "$url"
  fi
}

json_ok() {
  python3 -c "import json; json.load(open('/tmp/smoke-body.json'))" 2>/dev/null
}

# ─── 1. Health ───────────────────────────────────────────────────────────────
section "1. Backend health"
code=$(curl -sS -o /tmp/swagger.json -w '%{http_code}' "$API/api-docs-json")
if [[ "$code" == "200" ]] && python3 -c "import json; json.load(open('/tmp/swagger.json'))" 2>/dev/null; then
  paths=$(python3 -c "import json; print(len(json.load(open('/tmp/swagger.json')).get('paths',{})))")
  ok "Swagger spec OK ($paths routes documented)"
else
  bad "Backend unreachable or invalid Swagger (HTTP $code) — is axis-backend running on $API?"
fi

# ─── 2. Public endpoints ─────────────────────────────────────────────────────
section "2. Public endpoints (no auth)"
declare -A public_checks=(
  ["GET /schedules"]="$API/schedules"
  ["GET /schedules/available"]="$API/schedules/available"
  ["GET /notices"]="$API/notices"
  ["GET /faq"]="$API/faq"
  ["GET /public/site-context"]="$API/public/site-context"
  ["GET /auth/check-userid"]="$API/auth/check-userid?userId=smokeprobe"
)
for label in "${!public_checks[@]}"; do
  url="${public_checks[$label]}"
  code=$(http GET "$url")
  if [[ "$code" == "200" ]] && json_ok; then
    ok "$label -> 200 JSON"
  else
    bad "$label -> HTTP $code (expected 200 JSON)"
  fi
done

code=$(http POST "$API/auth/login" '{"userId":"smoke-invalid","password":"wrong"}')
if [[ "$code" == "401" ]]; then
  ok "POST /auth/login (bad creds) -> 401"
else
  bad "POST /auth/login (bad creds) -> $code (expected 401)"
fi

code=$(http GET "$API/certificates/verify/SMOKE-NONEXISTENT?holderName=SmokeTest")
if [[ "$code" == "200" ]] && json_ok; then
  ok "GET /certificates/verify -> 200 (lookup works, cert may not exist)"
else
  bad "GET /certificates/verify -> $code"
fi

code=$(http GET "$API/results/public/00000000-0000-0000-0000-000000000000")
if [[ "$code" == "404" ]]; then
  ok "GET /results/public/:id (unknown) -> 404"
else
  bad "GET /results/public/:id (unknown) -> $code (expected 404)"
fi

# ─── 3. Auth guards ────────────────────────────────────────────────────────────
section "3. Protected endpoints reject unauthenticated calls"
fake_id="00000000-0000-0000-0000-000000000000"
for ep in \
  "GET  $API/users/me/dashboard" \
  "GET  $API/registrations/mine" \
  "GET  $API/results/mine" \
  "GET  $API/cbt/sessions/$fake_id/paper" \
  "GET  $API/admin/grading/queue"
do
  m=$(echo "$ep" | awk '{print $1}')
  url=$(echo "$ep" | awk '{print $2}')
  code=$(http "$m" "$url")
  path="${url#$API}"
  if [[ "$code" == "401" ]]; then
    ok "$m $path -> 401"
  else
    bad "$m $path -> $code (expected 401)"
  fi
done

# ─── 4. Refresh hardening ──────────────────────────────────────────────────────
section "4. /auth/refresh hardening"
code=$(http POST "$API/auth/refresh" '{"refreshToken":"not-a-valid-jwt"}')
if [[ "$code" == "401" ]]; then
  ok "Bogus refresh token -> 401"
else
  bad "Bogus refresh token -> $code (expected 401)"
fi

# ─── 5. Exam-flow routes mounted ───────────────────────────────────────────────
section "5. Critical exam-flow routes mounted"
required=(
  "POST /auth/login"
  "POST /auth/refresh"
  "GET  /users/me/dashboard"
  "POST /registrations/quick-book"
  "POST /payment/request"
  "POST /payment/confirm"
  "POST /webhooks/portone"
  "POST /cbt/sessions/from-registration"
  "POST /cbt/sessions/{id}/start"
  "GET  /cbt/sessions/{id}/paper"
  "POST /cbt/sessions/{id}/submit"
  "GET  /results/mine"
  "GET  /admin/grading/queue"
)
for entry in "${required[@]}"; do
  method=$(echo "$entry" | awk '{print tolower($1)}')
  route=$(echo "$entry" | awk '{print $2}')
  if python3 -c "
import json, sys
spec = json.load(open('/tmp/swagger.json'))
m, r = sys.argv[1], sys.argv[2]
sys.exit(0 if r in spec.get('paths', {}) and m in spec['paths'][r] else 1)
" "$method" "$route" 2>/dev/null; then
    ok "$entry"
  else
    bad "$entry — NOT mounted"
  fi
done

# ─── 6. Demo paper + grade (all cert × level) ──────────────────────────────────
section "6. Demo paper + grading (all cert × level)"
demo_pass=0
demo_fail=0
for cert in AXIS AXIS_C AXIS_H; do
  for level in L3 L2 L1; do
    code=$(http GET "$API/cbt/demo/$cert/$level")
    if [[ "$code" != "200" ]]; then
      bad "GET /cbt/demo/$cert/$level -> $code"
      demo_fail=$((demo_fail+1))
      continue
    fi
    n=$(python3 -c "import json; print(len(json.load(open('/tmp/smoke-body.json')).get('questions',[])))")
    if [[ "$n" -lt 1 ]]; then
      bad "$cert $level demo paper has 0 questions"
      demo_fail=$((demo_fail+1))
      continue
    fi
    body=$(python3 - "$cert" "$level" <<'PY'
import json, sys
cert, level = sys.argv[1], sys.argv[2]
p = json.load(open('/tmp/smoke-body.json'))
answers = [{"questionId": q["id"], "selectedChoice": "A"} for q in p["questions"]]
print(json.dumps({"certType": cert, "level": level, "answers": answers}))
PY
)
    grade_code=$(http POST "$API/cbt/demo/grade" "$body")
    if [[ "$grade_code" == "200" ]] || [[ "$grade_code" == "201" ]]; then
      pct=$(python3 -c "import json; r=json.load(open('/tmp/smoke-body.json')); print(r.get('totalPct', r.get('score','?')))")
      ok "$cert $level: $n questions, grade HTTP $grade_code (totalPct=$pct)"
      demo_pass=$((demo_pass+1))
    else
      bad "POST /cbt/demo/grade ($cert $level) -> $grade_code"
      demo_fail=$((demo_fail+1))
    fi
  done
done

# ─── Summary ───────────────────────────────────────────────────────────────────
section "SUMMARY"
echo "  Target:  $API"
echo "  Passed:  $PASS"
echo "  Failed:  $FAIL"
echo "  Demo:    $demo_pass/9 combos OK"
if (( FAIL > 0 )); then
  echo
  echo "Failures:"
  for m in "${FAIL_MSGS[@]}"; do echo "  - $m"; done
  exit 1
fi
echo "  ✓ API smoke green."
