#!/usr/bin/env bash
# ============================================================
#  ENZO CI/CD Local Runner
#  Mirrors the .github/workflows/ci.yml pipeline.
#  Usage:  bash ci-runner.sh [--cd] [--pentest]
#
#  --pentest also runs scripts/pentest.sh against the local
#  backend on http://localhost:5001 (which must be running —
#  this script does NOT boot it).
#  --cd      also runs the CD (deployment readiness) stage.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FE="$ROOT/synthetic-nature"
REPORT="$ROOT/.ci-report.txt"

RUN_CD=false
RUN_PENTEST=false
for arg in "$@"; do
  case "$arg" in
    --cd)      RUN_CD=true ;;
    --pentest) RUN_PENTEST=true ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: bash ci-runner.sh [--cd] [--pentest]" >&2; exit 2 ;;
  esac
done

PENTEST_BASE="${BASE:-http://localhost:5001}"

# ── Portable timeout ──────────────────────────────────────
# `timeout` is absent on stock macOS. Prefer `gtimeout`
# (coreutils), fall back to a bash background+kill wrapper.
timeout() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@" & local pid=$!
    ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null || true ) & local watcher=$!
    wait "$pid" 2>/dev/null
    local status=$?
    disown "$watcher" 2>/dev/null || true
    kill "$watcher" 2>/dev/null || true
    return "$status"
  fi
}

# ── Colours ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── Tracking ────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0
declare -a RESULTS=()
PIPELINE_START=$(date +%s)

# ── Helpers ─────────────────────────────────────────────────
banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════${RESET}"; echo -e "${CYAN}${BOLD}  $1${RESET}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════${RESET}"; }

step() {
  local LABEL="$1"; shift
  local START=$(date +%s)
  echo -e "\n${BOLD}▶ $LABEL${RESET}"
  local OUT
  local EXIT=0
  OUT=$(eval "$@" 2>&1) || EXIT=$?
  local ELAPSED=$(( $(date +%s) - START ))
  if [[ $EXIT -eq 0 ]]; then
    echo -e "  ${GREEN}✔ PASS${RESET} ${DIM}(${ELAPSED}s)${RESET}"
    RESULTS+=("PASS | $LABEL (${ELAPSED}s)")
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}✘ FAIL${RESET} ${DIM}(${ELAPSED}s)${RESET}"
    echo -e "${DIM}--- output ---${RESET}"
    echo "$OUT" | head -40
    echo -e "${DIM}--- end ---${RESET}"
    RESULTS+=("FAIL | $LABEL (${ELAPSED}s)")
    FAIL=$((FAIL+1))
  fi
}

step_skip() {
  echo -e "\n${BOLD}▶ $1${RESET}"
  echo -e "  ${YELLOW}⊘ SKIP${RESET} ${DIM}($2)${RESET}"
  RESULTS+=("SKIP | $1")
  SKIP=$((SKIP+1))
}

# is_port_open HOST PORT — fast TCP probe (1s cap), used to
# decide whether a "live server" check should run or skip.
is_port_open() {
  curl -s --max-time 1 -o /dev/null "http://$1:$2/" 2>/dev/null && return 0
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

# ── Header ──────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     ENZO CI/CD Pipeline Runner       ║"
echo "  ║     $(date '+%Y-%m-%d %H:%M:%S')             ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${RESET}"
echo "  Node: $(node --version)  |  npm: $(npm --version)  |  tsx: $(npx tsx --version 2>/dev/null | head -1)"
echo "  Root: $ROOT"
MODE="CI only"
[[ "$RUN_CD" == true ]] && MODE="CI + CD"
[[ "$RUN_PENTEST" == true ]] && MODE="$MODE + pentest"
echo "  Mode: $MODE"

# ═══════════════════════════════════════════════════════════════
banner "STAGE 1 · SECURITY CHECKS"
# ═══════════════════════════════════════════════════════════════

# `! cd "$ROOT" && git grep …` was the original form and it never worked: `!`
# binds to the first pipeline only, so a successful `cd` yielded 1, short-circuited
# the `&&`, and the grep never ran — a permanent FAIL that searched nothing.
# `git -C` does the same job with no shell operator to get wrong.
step "No hardcoded API key literals in tracked files" \
  "! git -C '$ROOT' grep -nIE \
    '(gsk_[A-Za-z0-9]{40,}|sk_[A-Za-z0-9]{20,}|sk-or-v1-[a-f0-9]+|oauth_app_secret_[A-Za-z0-9]+|nvapi-[A-Za-z0-9]{30,})' \
    -- . ':(exclude)*package-lock.json' ':(exclude)*.lock' ':(exclude)*/dist/*' \
          ':(exclude)*.mp4' ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.jpeg' \
          ':(exclude)*.svg' ':(exclude)*.ico' ':(exclude)*.woff' ':(exclude)*.woff2' \
          ':(exclude)*.webp' ':(exclude)*.gif' ':(exclude)*.zip' 2>/dev/null"

step "No hardcoded API key literals in server source" \
  "! grep -rn --include='*.ts' --include='*.tsx' --include='*.js' \
    -E '(gsk_[A-Za-z0-9]{40,}|sk_[A-Za-z0-9]{20,}|sk-or-v1-[a-f0-9]+|oauth_app_secret_[A-Za-z0-9]+|nvapi-[A-Za-z0-9]{30,})' \
    '$ROOT/index.ts' '$ROOT/src' 2>/dev/null"

step ".env not committed to git" \
  "! git ls-files '$ROOT/.env' | grep -q '.env'"

step "No .env files tracked by git" \
  "! git ls-files '$ROOT' | grep -E '^\.env(\.[^e]|$)' | grep -v '.env.example'"

step ".env.example exists and has no real secrets" \
  "test -f '$ROOT/.env.example' && \
   ! grep -qE '(gsk_[A-Za-z0-9]{40,}|sk_[A-Za-z0-9]{20,}|sk-or-v1-[a-f0-9]+|oauth_app_secret_[A-Za-z0-9]+)' '$ROOT/.env.example'"

step "No personal PDFs or credential files in git" \
  "! git ls-files | grep -qE '\.(pdf|rtf)$'"

# ═══════════════════════════════════════════════════════════════
banner "STAGE 2 · DEPENDENCY AUDIT"
# ═══════════════════════════════════════════════════════════════

step "Backend: node_modules installed" \
  "test -d '$ROOT/node_modules'"

step "Backend: npm audit (no critical)" \
  "cd '$ROOT' && npm audit --audit-level=critical --json 2>/dev/null | node -e \
    \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
      const c=(d.metadata?.vulnerabilities?.critical||0); \
      process.exit(c>0?1:0)\""

step "Frontend: node_modules installed" \
  "test -d '$FE/node_modules'"

step "Frontend: npm audit (no critical)" \
  "cd '$FE' && npm audit --audit-level=critical --json 2>/dev/null | node -e \
    \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
      const c=(d.metadata?.vulnerabilities?.critical||0); \
      process.exit(c>0?1:0)\""

# ═══════════════════════════════════════════════════════════════
banner "STAGE 3 · BACKEND CI"
# ═══════════════════════════════════════════════════════════════

step "Backend: TypeScript type-check (tsc --noEmit)" \
  "cd '$ROOT' && npm run typecheck 2>&1"

step "Backend: every imported file is tracked by git" \
  "cd '$ROOT' && npm run check:imports 2>&1"

step "Backend: unit tests (incl. both AES round-trips)" \
  "cd '$ROOT' && npm test 2>&1"

step "Backend: requireEnv guard exists in index.ts" \
  "grep -q 'function requireEnv' '$ROOT/index.ts'"

step "Backend: tunnel.ts has no hardcoded key fallbacks" \
  "! grep -qE \"\\|\\|\\s*'(gsk_|sk_|sk-or-v1-)\" '$ROOT/src/features/tunnel.ts'"

# The server is pure BYOK: users supply provider keys per request, so it MUST
# boot with no GROQ_API_KEY (see optionalEnv in index.ts). A hard requireEnv on
# a provider key would break every hosted deploy at startup, so guard the
# keyless path instead of asserting the old "throws on missing key" contract.
#
# NOTE: the boot runs `timeout ... tsx index.ts > log 2>&1; grep ...` — the
# semicolon matters. Under `set -o pipefail`, piping the server's output into
# grep makes timeout's exit 124 (the kill that ENDS a healthy boot check) the
# pipeline's status, so the old `... | grep -q` form failed every run even
# when the expected log line had been printed. Here grep alone decides PASS.
step "Backend: boots keyless (BYOK) with no provider key" \
  "cd '$ROOT' && GROQ_API_KEY= HF_CLIENT_SECRET=ci PORT=5099 \
    timeout 20 npx tsx index.ts > /tmp/enzo-ci-boot-keyless.log 2>&1; \
    grep -q 'keyless BYOK mode' /tmp/enzo-ci-boot-keyless.log"

step "Backend: module load check (tsx with placeholder env)" \
  "cd '$ROOT' && GROQ_API_KEY=ci-test HF_CLIENT_SECRET=ci-test PORT=5099 \
    timeout 20 npx tsx index.ts > /tmp/enzo-ci-boot-load.log 2>&1; \
    grep -q 'Backend ready\\|listening\\|initialized' /tmp/enzo-ci-boot-load.log"

if is_port_open localhost 5001; then
  step "Backend: /api/v1/models responds 200 (live server check)" \
    "curl -sf -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5001/api/v1/models | grep -q 200"

  step "Backend: /api/chat endpoint exists (live)" \
    "curl -sf -X POST http://localhost:5001/api/chat \
      -H 'Content-Type: application/json' -d '{\"message\":\"ping\",\"chosenModel\":\"\"}' \
      --max-time 3 -o /dev/null -w '%{http_code}' | grep -qE '200|401|500'"

  step "Backend: /api/image/generate endpoint exists (live)" \
    "curl -sf -X POST http://localhost:5001/api/image/generate \
      -H 'Content-Type: application/json' -d '{\"prompt\":\"test\"}' \
      --max-time 3 -o /dev/null -w '%{http_code}' | grep -qE '200|400|500'"
else
  step_skip "Backend: /api/v1/models responds 200 (live server check)" "no server on :5001"
  step_skip "Backend: /api/chat endpoint exists (live)" "no server on :5001"
  step_skip "Backend: /api/image/generate endpoint exists (live)" "no server on :5001"
fi

# ═══════════════════════════════════════════════════════════════
banner "STAGE 4 · FRONTEND CI"
# ═══════════════════════════════════════════════════════════════

step "Frontend: TypeScript strict type-check (tsc --noEmit)" \
  "cd '$FE' && npx tsc --noEmit 2>&1"

step "Frontend: No 'any' type assertions in gesture lib" \
  "! grep -rn 'as any' '$FE/src/features/gesture/' 2>/dev/null | grep -v '//'"

step "Frontend: Vite production build" \
  "cd '$FE' && npm run build 2>&1"

step "Frontend: dist/index.html generated" \
  "test -f '$FE/dist/index.html'"

step "Frontend: dist JS bundle < 2MB (gzipped)" \
  "find '$FE/dist/assets/' -name '*.js' | xargs ls -la | \
    awk '{sum+=\$5} END {exit (sum > 2097152) ? 1 : 0}'"

if is_port_open localhost 5173; then
  step "Frontend: Dev server responds 200 (live)" \
    "curl -sf -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5173/ | grep -q 200"
else
  step_skip "Frontend: Dev server responds 200 (live)" "no dev server on :5173"
fi

# ═══════════════════════════════════════════════════════════════
banner "STAGE 5 · REPO HYGIENE"
# ═══════════════════════════════════════════════════════════════

step "CI workflow file exists (.github/workflows/ci.yml)" \
  "test -f '$ROOT/.github/workflows/ci.yml'"

step "marketplace_theme/ removed from git tracking" \
  "! git ls-files '$ROOT/marketplace_theme/' | grep -q '.'"

# Mirrors ci.yml: exclude synthetic-nature/public/* AND *.mp4 from the 300MB rule.
step "No unexpected large binary files (>300MB) tracked by git" \
  "! git ls-files | grep -Ev '^synthetic-nature/public/|\.mp4$' | xargs -I{} sh -c 'f=\"$ROOT/{}\"; [ -f \"\$f\" ] && stat -f\"%z\" \"\$f\" 2>/dev/null || stat -c\"%s\" \"\$f\" 2>/dev/null' 2>/dev/null | \
    awk '{if(\$1+0 > 314572800) count++} END {exit (count>0) ? 1 : 0}'"

step "CHANGELOG.md exists, non-empty, has a dated entry" \
  "test -s '$ROOT/docs/CHANGELOG.md' && grep -qE '^## \[20[0-9]{2}-' '$ROOT/docs/CHANGELOG.md'"

step "AGENTS.md (project guide) exists" \
  "test -f '$ROOT/docs/AGENTS.md'"

# ═══════════════════════════════════════════════════════════════
if [[ "$RUN_PENTEST" == true ]]; then
  banner "STAGE 5b · SECURITY PENTEST (BLACK-BOX)"

  if is_port_open localhost "${PENTEST_BASE##*:}"; then
    step "Security pentest against $PENTEST_BASE" \
      "bash '$ROOT/scripts/pentest.sh' --base '$PENTEST_BASE'"
  else
    step_skip "Security pentest against $PENTEST_BASE" "no server running on $PENTEST_BASE — start the backend first"
  fi
fi

# ═══════════════════════════════════════════════════════════════
if [[ "$RUN_CD" == true ]]; then
  banner "STAGE 6 · CD — DEPLOYMENT READINESS"

  # Same timeout/semicolon pattern as the Stage-2 boot checks: timeout's exit
  # 124 is the SUCCESS case (we only need the server to come up), so grep on
  # the captured log — not the pipeline status — decides this step.
  step "CD: Backend starts cleanly on custom port" \
    "cd '$ROOT' && GROQ_API_KEY=ci-test HF_CLIENT_SECRET=ci-test PORT=5098 \
      timeout 8 npx tsx index.ts > /tmp/enzo-ci-cd-boot.log 2>&1; \
      grep -q 'listening\\|Backend ready' /tmp/enzo-ci-cd-boot.log"

  step "CD: Vite preview server (production build) starts" \
    "cd '$FE' && (npx vite preview --port 5074 &); sleep 3; \
     curl -sf -o /dev/null -w '%{http_code}' http://localhost:5074/ | grep -q 200; \
     pkill -f 'vite preview' 2>/dev/null || true"

  step "CD: dist/ contains all required assets" \
    "test -f '$FE/dist/index.html' && \
     find '$FE/dist/assets/' -name '*.js' | grep -q . && \
     find '$FE/dist/assets/' -name '*.css' | grep -q ."

  step "CD: No source maps in production build (security)" \
    "! find '$FE/dist/' -name '*.map' | grep -q ."
fi

# ═══════════════════════════════════════════════════════════════
banner "PIPELINE REPORT"
# ═══════════════════════════════════════════════════════════════

TOTAL_TIME=$(( $(date +%s) - PIPELINE_START ))
TOTAL=$(( PASS + FAIL + SKIP ))

echo ""
for R in "${RESULTS[@]}"; do
  STATUS="${R%% |*}"
  LABEL="${R#*| }"
  if   [[ "$STATUS" == "PASS" ]]; then echo -e "  ${GREEN}✔${RESET}  $LABEL"
  elif [[ "$STATUS" == "FAIL" ]]; then echo -e "  ${RED}✘${RESET}  $LABEL"
  else                                  echo -e "  ${YELLOW}⊘${RESET}  $LABEL"
  fi
done

echo ""
echo "  ┌─────────────────────────────────────┐"
printf "  │  PASS: %-4s  FAIL: %-4s  SKIP: %-4s │\n" "$PASS" "$FAIL" "$SKIP"
printf "  │  TOTAL: %-3s   TIME: %-3ss           │\n" "$TOTAL" "$TOTAL_TIME"
echo "  └─────────────────────────────────────┘"

# Write machine-readable report
{
  echo "ENZO CI/CD Report — $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Pass: $PASS / Fail: $FAIL / Skip: $SKIP / Total: $TOTAL"
  echo "Duration: ${TOTAL_TIME}s"
  echo "---"
  for R in "${RESULTS[@]}"; do echo "$R"; done
} > "$REPORT"
echo ""
echo "  Report saved → $REPORT"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}${BOLD}PIPELINE FAILED — $FAIL check(s) did not pass.${RESET}"
  exit 1
else
  echo -e "  ${GREEN}${BOLD}PIPELINE PASSED — all $PASS checks green.${RESET}"
  exit 0
fi
