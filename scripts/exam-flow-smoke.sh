#!/usr/bin/env bash
# AXIS exam-flow smoke test (READ-ONLY — no DB writes, safe for production).
#
# What it does, in order:
#   1.  Backend health check (Swagger spec must respond 200 + valid JSON).
#   2.  Verify every endpoint the frontend's exam flow calls is mounted.
#   3.  Verify protected endpoints reject unauthenticated requests with 401
#       (so the silent-refresh interceptor in the frontend has a 401 to react to).
#   4.  Verify /auth/refresh rejects bogus tokens with 401 (so the interceptor
#       won't loop forever on a dead token).
#   5.  Pull a demo paper for every (certType, level) combination — this is the
#       same code path that real candidates hit at start, but persists nothing.
#   6.  Submit each demo paper unanswered and verify the grading endpoint runs
#       without throwing (proves the scoring/breakdown code is healthy).
#   7.  Probe the candidate-side certificate read path via /results/mine
#       (returns 401 unauthenticated, which is the expected guarded response).
#
# Exits non-zero if any check fails.
set -euo pipefail

# Prefer 127.0.0.1 — on some hosts "localhost" resolves to ::1 while Node binds IPv4 only.
API="${AXIS_API_BASE:-http://127.0.0.1:3333}"
PASS=0
FAIL=0
FAIL_MSGS=()

ok()   { printf '  [PASS] %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); FAIL_MSGS+=("$1"); }

section() { printf '\n=== %s ===\n' "$1"; }

# ─── 1. Backend health ───────────────────────────────────────────────────────
section "1. Backend health"
code=$(curl -sS -o /tmp/swagger.json -w '%{http_code}' "$API/api-docs-json")
if [[ "$code" == "200" ]] && python3 -c "import json; json.load(open('/tmp/swagger.json'))" 2>/dev/null; then
  ok "Backend reachable, Swagger spec valid JSON"
else
  bad "Swagger spec missing or invalid (HTTP $code)"
fi

# ─── 2. Required exam-flow routes mounted ────────────────────────────────────
section "2. Exam-flow routes mounted"
required=(
  "POST /auth/login"
  "POST /auth/refresh"
  "GET  /users/me/dashboard"
  "POST /registrations/quick-book"
  "POST /payment/request"
  "POST /payment/confirm"
  "POST /webhooks/portone"
  "POST /cbt/sessions/from-registration"
  "POST /cbt/sessions/{id}/consent"
  "POST /cbt/sessions/{id}/start"
  "GET  /cbt/sessions/{id}/paper"
  "POST /cbt/sessions/{id}/answers"
  "POST /cbt/sessions/{id}/practical"
  "POST /cbt/sessions/{id}/proctor/event"
  "POST /cbt/sessions/{id}/submit"
  "GET  /cbt/sessions/{id}/result"
  "GET  /results/mine"
  "GET  /admin/grading/queue"
  "POST /admin/grading/sessions/{id}/finalize"
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

# ─── 3. Protected endpoints reject unauthenticated calls with 401 ────────────
section "3. Auth guard returns 401 (so frontend can refresh)"
fake_id="00000000-0000-0000-0000-000000000000"
for ep in \
  "GET  $API/users/me/dashboard" \
  "GET  $API/registrations/mine" \
  "GET  $API/results/mine" \
  "GET  $API/cbt/sessions/$fake_id/paper" \
  "GET  $API/cbt/sessions/$fake_id/result" \
  "POST $API/cbt/sessions/$fake_id/submit" \
  "GET  $API/admin/grading/queue" \
  "POST $API/admin/grading/sessions/$fake_id/finalize"
do
  m=$(echo "$ep" | awk '{print $1}')
  url=$(echo "$ep" | awk '{print $2}')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X "$m" "$url")
  if [[ "$code" == "401" ]]; then
    ok "$m ${url#$API} -> 401 (correct)"
  else
    bad "$m ${url#$API} -> $code (expected 401)"
  fi
done

# ─── 4. /auth/refresh rejects bogus token (no infinite loop) ─────────────────
section "4. /auth/refresh hardening"
code=$(curl -sS -o /tmp/refresh.json -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -X POST "$API/auth/refresh" \
  -d '{"refreshToken":"this-is-not-a-jwt"}')
if [[ "$code" == "401" ]]; then
  ok "Bogus refresh token -> 401 (frontend interceptor will stop, not loop)"
else
  bad "Bogus refresh token -> $code (expected 401)"
fi

# ─── 5+6. Demo flow per (certType, level) — same code as real exam ───────────
section "5+6. Demo paper + grade for all (certType, level) combos"
for cert in AXIS AXIS_C AXIS_H; do
  for level in L3 L2 L1; do
    paper_code=$(curl -sS -o /tmp/paper.json -w '%{http_code}' "$API/cbt/demo/$cert/$level")
    if [[ "$paper_code" != "200" ]]; then
      bad "GET /cbt/demo/$cert/$level -> $paper_code"
      continue
    fi
    n=$(python3 -c "import json; print(len(json.load(open('/tmp/paper.json')).get('questions',[])))")
    if [[ "$n" -lt 1 ]]; then
      bad "$cert $level demo paper has 0 questions (question bank may be empty)"
      continue
    fi
    ok "GET /cbt/demo/$cert/$level -> $n questions"

    body=$(python3 - "$cert" "$level" <<'PY'
import json, sys
cert, level = sys.argv[1], sys.argv[2]
p = json.load(open('/tmp/paper.json'))
answers = [{"questionId": q["id"], "selectedChoice": "A"} for q in p["questions"]]
print(json.dumps({"certType": cert, "level": level, "answers": answers}))
PY
)
    grade_code=$(curl -sS -o /tmp/grade.json -w '%{http_code}' \
      -H "Content-Type: application/json" \
      -X POST "$API/cbt/demo/grade" \
      -d "$body")
    if [[ "$grade_code" == "200" ]] || [[ "$grade_code" == "201" ]]; then
      score=$(python3 -c "import json; r=json.load(open('/tmp/grade.json')); print(r.get('score', r))")
      ok "POST /cbt/demo/grade ($cert $level) -> $grade_code (score=$score)"
    else
      bad "POST /cbt/demo/grade ($cert $level) -> $grade_code"
    fi
  done
done

# ─── Summary ─────────────────────────────────────────────────────────────────
section "SUMMARY"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if (( FAIL > 0 )); then
  echo
  echo "Failures:"
  for m in "${FAIL_MSGS[@]}"; do echo "  - $m"; done
  exit 1
fi
echo "  ✓ Exam-flow smoke green."
