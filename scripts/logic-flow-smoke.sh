#!/usr/bin/env bash
# AXIS logic-flow smoke test — READ-ONLY, production-safe.
#
# Validates that major business flows have matching API endpoints (upload ↔ review,
# write ↔ read). Does NOT mutate DB or upload files.
#
# Usage:
#   npm run smoke:logic
#   AXIS_API_BASE=http://127.0.0.1:3333 bash scripts/logic-flow-smoke.sh
set -euo pipefail

API="${AXIS_API_BASE:-http://127.0.0.1:3333}"
PASS=0
WARN=0
FAIL=0
PASS_MSGS=()
WARN_MSGS=()
FAIL_MSGS=()

ok()   { printf '  [PASS] %s\n' "$1"; PASS=$((PASS+1)); PASS_MSGS+=("$1"); }
warn() { printf '  [WARN] %s\n' "$1"; WARN=$((WARN+1)); WARN_MSGS+=("$1"); }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); FAIL_MSGS+=("$1"); }
section() { printf '\n=== %s ===\n' "$1"; }

# Fetch swagger once
if ! curl -sS -o /tmp/swagger.json -w '' "$API/api-docs-json" 2>/dev/null; then
  echo "FATAL: cannot reach $API/api-docs-json"
  exit 2
fi

has_route() {
  local method="$1" route="$2"
  python3 -c "
import json, sys
spec = json.load(open('/tmp/swagger.json'))
m, r = sys.argv[1], sys.argv[2]
paths = spec.get('paths', {})
sys.exit(0 if r in paths and m in paths[r] else 1)
" "$method" "$route" 2>/dev/null
}

check_pair() {
  local label="$1"
  local upload_m="$2" upload_r="$3"
  local review_m="$4" review_r="$5"
  local up=0 rev=0
  has_route "$upload_m" "$upload_r" && up=1
  has_route "$review_m" "$review_r" && rev=1
  if (( up && rev )); then
    ok "$label — upload + review routes both mounted"
  elif (( up && ! rev )); then
    bad "$label — upload exists ($upload_m $upload_r) but NO review ($review_m $review_r)"
  elif (( !up && rev )); then
    bad "$label — review exists but NO upload endpoint"
  else
    warn "$label — neither endpoint mounted (feature may be unbuilt)"
  fi
}

# ─── 1. Core registration → exam → result chain ─────────────────────────────
section "1. Registration → payment → exam → result (route chain)"
chain=(
  "post /auth/login"
  "post /registrations"
  "post /payment/request"
  "post /payment/confirm"
  "post /cbt/sessions/from-registration"
  "post /cbt/sessions/{id}/consent"
  "post /cbt/sessions/{id}/start"
  "get /cbt/sessions/{id}/paper"
  "post /cbt/sessions/{id}/answers"
  "post /cbt/sessions/{id}/submit"
  "get /cbt/sessions/{id}/result"
  "get /users/me/dashboard"
)
for entry in "${chain[@]}"; do
  m=$(echo "$entry" | awk '{print $1}')
  r=$(echo "$entry" | awk '{print $2}')
  if has_route "$m" "$r"; then ok "Chain: $m $r"; else bad "Chain broken: $m $r missing"; fi
done

# ─── 2. Upload ↔ review pairs ────────────────────────────────────────────────
section "2. Upload ↔ admin review pairs"
check_pair "L1 eligibility document" \
  "post" "/registrations/document" \
  "get" "/admin/registrations/eligibility/{id}/document"
check_pair "L1 eligibility review action" \
  "post" "/registrations/document" \
  "post" "/admin/registrations/eligibility/{id}/review"
check_pair "L1 exam deliverable" \
  "post" "/cbt/sessions/{id}/deliverable" \
  "get" "/admin/grading/sessions/{id}/deliverable"
check_pair "Inquiry attachment upload" \
  "post" "/inquiries/uploads" \
  "get" "/admin/inquiries/{id}"
check_pair "Proctor AI evidence" \
  "post" "/cbt/proctor/ai-review" \
  "get" "/cbt/sessions/{id}/proctor/evidence"
check_pair "Admin proctor evidence" \
  "post" "/cbt/proctor/ai-review" \
  "get" "/admin/sessions/{id}/proctor/evidence"

# ─── 3. Identity verification flow ───────────────────────────────────────────
section "3. Identity verification (preflight)"
if has_route "post" "/identity-verification/verify"; then
  ok "POST /identity-verification/verify mounted (candidate upload path)"
else
  bad "POST /identity-verification/verify missing"
fi
if has_route "get" "/admin/identity-verification/{id}" || has_route "get" "/admin/users/{id}/identity"; then
  ok "Admin identity review endpoint exists"
else
  warn "No admin endpoint to review stored ID verification (ID images not persisted by design)"
fi
if has_route "post" "/cbt/sessions/{id}/id-verify"; then
  ok "Legacy id-verify on session exists"
else
  warn "AGENTS.md id-verify on session not implemented — using standalone identity-verification module instead"
fi

# ─── 4. Grading pipeline ─────────────────────────────────────────────────────
section "4. Grading pipeline (admin + expert)"
grading=(
  "get /admin/grading/queue"
  "get /admin/grading/sessions/{id}/detail"
  "post /admin/grading/sessions/{id}/assign"
  "post /admin/grading/sessions/{id}/ai-prescore"
  "post /admin/grading/sessions/{id}/finalize"
)
for entry in "${grading[@]}"; do
  m=$(echo "$entry" | awk '{print $1}')
  r=$(echo "$entry" | awk '{print $2}')
  if has_route "$m" "$r"; then ok "Grading: $m $r"; else bad "Grading gap: $m $r"; fi
done

# ─── 4b. Admin monitor write actions ─────────────────────────────────────────
section "4b. Admin monitor write actions"
monitor_actions=(
  "POST /admin/monitor/sessions/{id}/warn"
  "POST /admin/monitor/sessions/{id}/pause"
  "POST /admin/monitor/sessions/{id}/extend"
  "POST /admin/monitor/sessions/{id}/terminate"
)
for entry in "${monitor_actions[@]}"; do
  m=$(echo "$entry" | awk '{print tolower($1)}')
  r=$(echo "$entry" | awk '{print $2}')
  if has_route "$m" "$r"; then ok "Monitor action: $m $r"; else bad "Monitor action missing: $m $r"; fi
done
fake_id="00000000-0000-0000-0000-000000000000"
for ep in \
  "POST $API/admin/monitor/sessions/$fake_id/warn" \
  "POST $API/admin/monitor/sessions/$fake_id/extend"
do
  m=$(echo "$ep" | awk '{print $1}')
  url=$(echo "$ep" | awk '{print $2}')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X "$m" -H "Content-Type: application/json" -d '{}' "$url")
  if [[ "$code" == "401" ]]; then
    ok "$m ${url#$API} -> 401 (auth required)"
  else
    bad "$m ${url#$API} -> $code (expected 401)"
  fi
done

# ─── 5. Known spec gaps (warn if still missing — not failures) ───────────────
section "5. Known incomplete features (spec vs implementation)"
declare -A spec_gaps=(
  ["POST /cbt/sessions/{id}/code/run"]="AXIS-C Judge0 sandbox — backend may exist, frontend unwired"
  ["POST /cbt/sessions/{id}/code/test"]="AXIS-C hidden test cases"
  ["POST /cbt/sessions/{id}/code/submit"]="AXIS-C final code submit"
  ["POST /admin/monitor/sessions/{id}/warn"]="Admin proctor warn push — implemented"
  ["POST /admin/monitor/sessions/{id}/terminate"]="Admin force-terminate — implemented"
  ["POST /admin/monitor/sessions/{id}/extend"]="Admin time extension — implemented"
  ["POST /admin/monitor/sessions/{id}/pause"]="Admin exam pause — implemented"
  ["POST /certificates/issue/{registrationId}"]="Certificate PDF issue endpoint"
  ["GET /certificates/{certNumber}/download"]="Certificate PDF download"
  ["GET /registrations/{id}/admission-ticket.pdf"]="Admission ticket PDF (JSON ticket exists instead)"
  ["POST /cbt/sessions/{id}/network-pause"]="Network disconnect compensation"
  ["GET /cbt/available-exams"]="Pre-flight eligible exam list"
  ["GET /certifications"]="Public certifications catalog"
)
for route_key in "${!spec_gaps[@]}"; do
  m=$(echo "$route_key" | awk '{print tolower($1)}')
  r=$(echo "$route_key" | awk '{print $2}')
  desc="${spec_gaps[$route_key]}"
  if has_route "$m" "$r"; then
    ok "Spec feature present: $route_key"
  else
    # Judge0 sandbox routes use different path — check alternate
    if [[ "$r" == *"/code/run"* ]] && has_route "post" "/cbt/sessions/{id}/code/run"; then
      ok "Judge0 sandbox mounted at /cbt/sessions/{id}/code/*"
    elif [[ "$r" == *"/code/run"* ]]; then
      warn "$desc — route not in Swagger (check sandbox.controller.ts)"
    else
      warn "$desc — $route_key not mounted"
    fi
  fi
done

# Judge0 — explicit check (nested under sessions)
section "6. AXIS-C code sandbox (backend vs frontend gap)"
for ep in run test submit; do
  if has_route "post" "/cbt/sessions/{id}/code/$ep"; then
    ok "Backend: POST /cbt/sessions/{id}/code/$ep"
  else
    bad "Backend missing: code/$ep"
  fi
done
warn "Frontend has NO code/run API calls — AXIS-C coding UI not wired (ExamRunnerPage)"

# ─── 7. Broken frontend path detection (admin-only API misuse) ───────────────
section "7. Role / flow mismatches (documented)"
warn "ExamSelectPage calls POST /cbt/sessions (admin-only) — regular users should use /exam-ready + from-registration"
if has_route "post" "/cbt/sessions" && has_route "post" "/cbt/sessions/from-registration"; then
  ok "Both session create paths exist — ensure UI routes examinees to from-registration only"
fi

# ─── 8. Public content flows ─────────────────────────────────────────────────
section "8. Public site content"
for entry in "get /schedules" "get /notices" "get /faq" "get /results/public/rounds" "get /certificates/verify/{certNumber}"; do
  m=$(echo "$entry" | awk '{print $1}')
  r=$(echo "$entry" | awk '{print $2}')
  if has_route "$m" "$r"; then ok "Public: $m $r"; else bad "Public missing: $m $r"; fi
done

# ─── 9. Demo flow (marketing) ────────────────────────────────────────────────
section "9. Demo / practice flow"
for entry in "get /cbt/demo/{certType}/{level}" "post /cbt/demo/grade" "post /cbt/demo/certificate" "get /cbt/demo/proctor/evidence"; do
  m=$(echo "$entry" | awk '{print $1}')
  r=$(echo "$entry" | awk '{print $2}')
  if has_route "$m" "$r"; then ok "Demo: $m $r"; else warn "Demo: $m $r missing"; fi
done
warn "DemoPage practical textarea is NOT saved — by design for practice mode"
warn "Demo proctor evidence at /cbt/demo/evidence — no nav link from DemoPage"

# ─── Summary ─────────────────────────────────────────────────────────────────
section "SUMMARY"
echo "  Target:   $API"
echo "  PASS:     $PASS"
echo "  WARN:     $WARN  (incomplete features — review backlog)"
echo "  FAIL:     $FAIL  (broken chains or upload-without-review)"
if (( FAIL > 0 )); then
  echo
  echo "Failures:"
  for m in "${FAIL_MSGS[@]}"; do echo "  ✗ $m"; done
fi
if (( WARN > 0 )); then
  echo
  echo "Warnings (incomplete / spec drift):"
  for m in "${WARN_MSGS[@]}"; do echo "  ⚠ $m"; done
fi
echo
if (( FAIL > 0 )); then
  echo "  ✗ Logic-flow smoke FAILED ($FAIL blocking issue(s))"
  exit 1
fi
echo "  ✓ No blocking logic gaps in API route pairs."
if (( WARN > 0 )); then
  echo "  ⚠ $WARN incomplete-feature warning(s) — see list above."
fi
