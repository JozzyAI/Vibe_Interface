#!/usr/bin/env bash
# vi-orchestrator-smoke.sh
# -------------------------------------------------------------------------
# Golden-path smoke test for the vi CLI orchestrator.
#
# Demonstrates, in order:
#   vi config show
#   vi machines
#   temp skill creation + vi skills validate
#   vi session create --skill ... --goal ...
#   vi session wait  (queued → running)
#   vi session logs  (verify SKILL_ACTIVE marker)
#   vi session wait  (running → waiting_input | completed | failed)
#   vi session send  (if session paused for input)
#   vi session wait  (final terminal state)
#   vi session logs  (final output)
#
# Usage:
#   bash scripts/vi-orchestrator-smoke.sh
#   bash scripts/vi-orchestrator-smoke.sh --agent rag_47675540-...
#   bash scripts/vi-orchestrator-smoke.sh --goal "summarise the repo in one sentence"
#   bash scripts/vi-orchestrator-smoke.sh --dry-run   # print steps, no relay calls
#
# Requirements:
#   - vi relay configured:  vi config show  (or VI_RELAY_BASE_URL + VI_RELAY_VI_TOKEN)
#   - at least one connected agent (vi machines)
#   - node in PATH, packages/vi-cli/dist/index.js built (pnpm --filter @vi/cli build)
# -------------------------------------------------------------------------

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────

AGENT_ID=""          # auto-detected if empty
GOAL="Confirm the skill is active. Print exactly: 'SKILL_ACTIVE: smoke test passed.' Then ask: 'Ready for next step?'"
SKILL_NAME="vi-smoke-test"
TIMEOUT_START=45     # seconds to wait for session to reach 'running'
TIMEOUT_INPUT=120    # seconds to wait for session to reach waiting_input/completed/failed
TIMEOUT_FINAL=60     # seconds to wait for final completed/failed after send
FOLLOW_UP="All good — you can stop now."
DRY_RUN=false
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Arg parsing ────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)  AGENT_ID="$2";  shift 2 ;;
    --goal)   GOAL="$2";      shift 2 ;;
    --dry-run) DRY_RUN=true;  shift   ;;
    -h|--help)
      sed -n '3,20p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── VI binary ──────────────────────────────────────────────────────────────

if command -v vi &>/dev/null && vi --version 2>&1 | grep -q "VI CLI"; then
  VI="vi"
else
  VI_DIST="$REPO_ROOT/packages/vi-cli/dist/index.js"
  if [[ ! -f "$VI_DIST" ]]; then
    echo "ERROR: vi CLI not found. Run: pnpm --filter @vi/cli build" >&2
    exit 1
  fi
  VI="node $VI_DIST"
fi

# ── Helpers ────────────────────────────────────────────────────────────────

BOLD=$'\e[1m'; RESET=$'\e[0m'
GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; CYAN=$'\e[36m'; DIM=$'\e[2m'
# Disable colour when not writing to a terminal
if [[ ! -t 1 ]]; then BOLD=""; RESET=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; DIM=""; fi

step() {
  local n="$1"; shift
  echo ""
  echo "${BOLD}${CYAN}── Step $n: $* ──${RESET}"
}

ok()   { echo "${GREEN}✓ $*${RESET}"; }
warn() { echo "${YELLOW}⚠ $*${RESET}"; }
fail() { echo "${RED}✗ $*${RESET}" >&2; }
cmd()  { echo "${DIM}\$ $*${RESET}"; }

run() {
  # run <description> <command...>
  local desc="$1"; shift
  cmd "$*"
  if $DRY_RUN; then
    echo "${DIM}  [dry-run — skipped]${RESET}"
    return 0
  fi
  "$@"
}

# ── Cleanup ────────────────────────────────────────────────────────────────

SKILL_DIR="$HOME/.vi/skills/$SKILL_NAME"
CLEANUP_DONE=false

cleanup() {
  $CLEANUP_DONE && return
  CLEANUP_DONE=true
  if [[ -d "$SKILL_DIR" ]]; then
    rm -rf "$SKILL_DIR"
    echo "${DIM}(temp skill $SKILL_NAME removed)${RESET}"
  fi
}
trap cleanup EXIT

# ──────────────────────────────────────────────────────────────────────────
#  STEP 1 — Config check
# ──────────────────────────────────────────────────────────────────────────

step 1 "vi config show"
echo "Verify relay URL and token are configured before any network calls."
echo "${DIM}Expected: Base URL + Token: (set)  — if blank, run: vi config set --base-url ... --token ...${RESET}"
echo ""

cmd "$VI config show"
if ! $DRY_RUN; then
  $VI config show
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 2 — List machines, pick agent
# ──────────────────────────────────────────────────────────────────────────

step 2 "vi machines"
echo "List connected agents. At least one must have status=running."
echo ""

cmd "$VI machines"
if ! $DRY_RUN; then
  $VI machines

  if [[ -z "$AGENT_ID" ]]; then
    AGENT_ID=$($VI machines --json | python3 -c "
import sys, json
agents = json.load(sys.stdin)
running = [a for a in agents if a.get('status') == 'running']
if not running:
    print('')
else:
    print(running[0]['agentId'])
" 2>/dev/null || true)

    if [[ -z "$AGENT_ID" ]]; then
      fail "No running agent found. Start vi-agent on a remote machine first."
      echo ""
      echo "Troubleshooting → see bottom of this script."
      exit 2
    fi

    ok "Auto-selected agent: $AGENT_ID"
  else
    ok "Using agent: $AGENT_ID"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 3 — Create temporary skill
# ──────────────────────────────────────────────────────────────────────────

step 3 "Create temp skill: $SKILL_NAME"
echo "Skill is created at $HOME/.vi/skills/$SKILL_NAME/ and removed on exit."
echo ""

if ! $DRY_RUN; then
  mkdir -p "$SKILL_DIR"

  cat > "$SKILL_DIR/skill.yaml" << 'YAML'
name: vi-smoke-test
description: Temporary skill for vi CLI golden-path smoke test
version: "1.0"
allowedTools:
  - Read
YAML

  cat > "$SKILL_DIR/instructions.md" << 'MD'
You are running a smoke test for the vi CLI skill pack system.

Your first action must be to print exactly:
  SKILL_ACTIVE: smoke test passed.

Then respond to the user goal below.
Keep your response short (2–3 sentences maximum).
MD

  ok "Skill files written to $SKILL_DIR"
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 4 — Validate skill
# ──────────────────────────────────────────────────────────────────────────

step 4 "vi skills validate $SKILL_NAME"
echo "Expected: 'Skill \"$SKILL_NAME\" is valid.'  Exit code: 0"
echo ""

cmd "$VI skills validate $SKILL_NAME"
if ! $DRY_RUN; then
  $VI skills validate "$SKILL_NAME"
  ok "Skill validates cleanly"
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 5 — Create session with skill
# ──────────────────────────────────────────────────────────────────────────

step 5 "vi session create --skill $SKILL_NAME --goal \"...\""
echo "VI_INITIAL_GOAL will be composed as:"
echo "  [SKILL: vi-smoke-test]"
echo "  <instructions.md>"
echo "  --- Goal ---"
echo "  $GOAL"
echo ""
echo "Expected: job JSON with status=queued, env.VI_INITIAL_GOAL contains [SKILL: vi-smoke-test]"
echo ""

JOB_ID=""

cmd "$VI session create --agent \$AGENT_ID --skill $SKILL_NAME --goal \"...\" --title \"vi smoke test\" --json"
if ! $DRY_RUN; then
  JOB_JSON=$($VI session create \
    --agent "$AGENT_ID" \
    --skill "$SKILL_NAME" \
    --goal "$GOAL" \
    --title "vi smoke test" \
    --json)

  JOB_ID=$(echo "$JOB_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
  COMPOSED_GOAL=$(echo "$JOB_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['env'].get('VI_INITIAL_GOAL',''))")

  ok "Session created: $JOB_ID"

  if echo "$COMPOSED_GOAL" | grep -q "\[SKILL: vi-smoke-test\]"; then
    ok "VI_INITIAL_GOAL contains skill header ✓"
  else
    warn "VI_INITIAL_GOAL does not contain expected skill header"
    echo "  Got: $COMPOSED_GOAL"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 6 — Wait for session to start
# ──────────────────────────────────────────────────────────────────────────

step 6 "vi session wait — queued → running"
echo "The agent polls the relay and picks up the job (typically 2–10s)."
echo "Expected: 'Session <id> reached running (status) after Ns.'"
echo ""

cmd "$VI session wait \$JOB_ID --until running --timeout $TIMEOUT_START"
if ! $DRY_RUN; then
  $VI session wait "$JOB_ID" --until running --timeout "$TIMEOUT_START"
  ok "Session is running"
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 7 — First log check
# ──────────────────────────────────────────────────────────────────────────

step 7 "vi session logs — first look"
echo "Give Claude a few seconds to process the initial goal, then check for the SKILL_ACTIVE marker."
echo ""

if ! $DRY_RUN; then
  sleep 6
  LOGS=$($VI session logs "$JOB_ID")
  echo "$LOGS"
  echo ""

  if echo "$LOGS" | grep -q "SKILL_ACTIVE"; then
    ok "SKILL_ACTIVE marker found in logs ✓"
  else
    warn "SKILL_ACTIVE not yet visible — session may still be processing"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 8 — Wait for input prompt or completion
# ──────────────────────────────────────────────────────────────────────────

step 8 "vi session wait — running → waiting_input | completed | failed"
echo "Claude finishes its initial response and either pauses for input or completes."
echo "Expected: matched state printed, exit 0."
echo ""

MATCHED_STATE=""

cmd "$VI session wait \$JOB_ID --until waiting_input,completed,failed --timeout $TIMEOUT_INPUT --json"
if ! $DRY_RUN; then
  WAIT_JSON=$($VI session wait "$JOB_ID" \
    --until waiting_input,completed,failed \
    --timeout "$TIMEOUT_INPUT" \
    --json)

  MATCHED_STATE=$(echo "$WAIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['matchedState'])")
  ok "Session reached: $MATCHED_STATE"
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 9 — Send follow-up (only if waiting for input)
# ──────────────────────────────────────────────────────────────────────────

step 9 "vi session send — follow-up message"

if ! $DRY_RUN; then
  if [[ "$MATCHED_STATE" == "waiting_input" ]]; then
    echo "Session is paused for input. Sending: \"$FOLLOW_UP\""
    echo ""

    cmd "$VI session send \$JOB_ID \"$FOLLOW_UP\""
    $VI session send "$JOB_ID" "$FOLLOW_UP"
    ok "Input sent"

    echo ""
    echo "Waiting for session to complete after follow-up..."
    cmd "$VI session wait \$JOB_ID --until completed,failed --timeout $TIMEOUT_FINAL"
    $VI session wait "$JOB_ID" --until completed,failed --timeout "$TIMEOUT_FINAL"
    ok "Session reached terminal state"

  elif [[ "$MATCHED_STATE" == "completed" ]]; then
    ok "Session already completed — no send needed"
  else
    warn "Session ended with state: $MATCHED_STATE — skipping send"
  fi
else
  echo "${DIM}[dry-run] would send follow-up if session reached waiting_input${RESET}"
fi

# ──────────────────────────────────────────────────────────────────────────
#  STEP 10 — Final logs
# ──────────────────────────────────────────────────────────────────────────

step 10 "vi session logs — final output"
echo ""

cmd "$VI session logs \$JOB_ID"
if ! $DRY_RUN; then
  FINAL_LOGS=$($VI session logs "$JOB_ID")
  echo "$FINAL_LOGS"
  echo ""

  if echo "$FINAL_LOGS" | grep -q "SKILL_ACTIVE"; then
    ok "SKILL_ACTIVE confirmed in final logs"
  else
    warn "SKILL_ACTIVE marker not found in final logs — check session output above"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
#  Summary
# ──────────────────────────────────────────────────────────────────────────

echo ""
echo "${BOLD}${GREEN}══ Smoke test complete ══${RESET}"
if ! $DRY_RUN && [[ -n "$JOB_ID" ]]; then
  echo "  Job ID : $JOB_ID"
  echo "  Agent  : $AGENT_ID"
fi
echo ""
echo "Re-inspect anytime:"
echo "  $VI session get  \$JOB_ID"
echo "  $VI session logs \$JOB_ID"
echo ""
exit 0

# ──────────────────────────────────────────────────────────────────────────
#  Troubleshooting
# ──────────────────────────────────────────────────────────────────────────
#
# Exit 1 — user/config error
#   vi config show returns "(not set)"
#   → Run: vi config set --base-url <url> --token <token>
#   → Or set: export VI_RELAY_BASE_URL=... VI_RELAY_VI_TOKEN=...
#
# Exit 2 — no running agent found
#   vi machines shows no rows, or all agents have status=disconnected
#   → On the remote machine, check: vi-agent status
#   → Restart: vi-agent start --relay-url ... --token ...
#   → Relay logs: ssh vi-relay 'sudo journalctl -u vi-relay -n 50'
#
# Exit 2 — relay network error
#   "Error: Relay error: fetch failed" or HTTP 401/403/5xx
#   → Verify relay is running: curl -s <VI_RELAY_BASE_URL>/health
#   → Verify token: vi config show (must say "(set)")
#   → Check relay logs on GCP: sudo journalctl -u vi-relay -n 50
#
# Exit 3 — session not found after create
#   Race: job was GC'd before wait ran (very unlikely, TTL is hours)
#   → Re-run the script; or manually: vi session get <jobId>
#
# Timeout on step 6 (queued → running)
#   Agent is not picking up jobs.
#   → vi machines — confirm status=running AND connectionState=connected
#   → On the machine: ps aux | grep vi-agent
#   → Check agent log: tail -f ~/.config/vi-agent/*.log
#
# Timeout on step 8 (waiting for waiting_input or completed)
#   Claude is still working, or the session hung.
#   → vi session get <jobId>  — check providerState.state
#   → vi session logs <jobId> — see if Claude is mid-tool-call
#   → If stuck: vi session send <jobId> --key escape  (interrupt)
#
# SKILL_ACTIVE not in logs
#   Skill instructions were delivered but Claude did not follow them.
#   This is a model behaviour issue, not a CLI bug.
#   → vi session logs <jobId> | head -40  — check what Claude printed
#   → Strengthen instructions.md: "You MUST print exactly: ..."
#
# vi CLI binary not found
#   → pnpm --filter @vi/cli build
#   → Or: export PATH="$PATH:$(pwd)/packages/vi-cli/dist"
#   → Or symlink: ln -sf $(pwd)/packages/vi-cli/dist/index.js ~/.local/bin/vi
