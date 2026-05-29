# VI Orchestrator — Daily Usage

Practical reference for using VI day-to-day — as a human at the terminal, a shell script, or a Claude Code session acting as an orchestrator.

Full CLI reference: `docs/vi-cli.md` · Skill pack reference: `docs/vi-skills.md`

---

## 1. Setup

Verify the relay is configured and at least one machine is reachable before doing anything else.

```bash
# Check relay URL and token
vi config show
# Expected:
#   Base URL : https://relay.dynastylab.ai
#   Token    : (set)
#   Config   : /home/user/.vi/config.json

# If not configured:
vi config set --base-url https://relay.dynastylab.ai --token <your-token>

# List connected machines
vi machines
# Expected: table with status=running, connectionState=connected
```

---

## 2. Create a skill

Skills inject reusable prompt instructions into every session that uses them. Create one per task type (e.g. `rocm-debug`, `code-review`, `ci-diagnose`).

```bash
# Scaffold directory + starter files
vi skills init rocm-debug
# Creates ~/.vi/skills/rocm-debug/skill.yaml + instructions.md

# Edit the instructions (required — starters are placeholders)
$EDITOR ~/.vi/skills/rocm-debug/instructions.md

# List all available skills
vi skills list

# Inspect metadata and preview instructions
vi skills show rocm-debug

# Validate before first use (warns on issues, always exits 0)
vi skills validate ~/.vi/skills/rocm-debug
# or by name:
vi skills validate rocm-debug
```

Example `~/.vi/skills/rocm-debug/instructions.md`:

```markdown
You are diagnosing a ROCm/HIP GPU build failure.

1. Read the full build log before drawing any conclusions.
2. Identify whether the failure is a missing library, a compiler version mismatch, or a kernel header issue.
3. Propose the minimal fix. Do not change files unrelated to the failure.
4. If a fix requires a command with side effects, request a VI approval first.
5. Summarise your findings in a short report at the end.
```

---

## 3. Create a session with a skill

```bash
vi session create \
  --agent <agentId> \
  --cwd <project-path> \
  --skill rocm-debug \
  --goal "Debug this issue and report findings"

# Get agentId from: vi machines --json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['agentId'])"

# With model override
vi session create \
  --agent <agentId> \
  --cwd /home/amd/rocm-project \
  --skill rocm-debug \
  --model claude-opus-4-7 \
  --goal "the HIP kernel build fails on ROCm 6.2 — find the root cause"

# Without skill (plain prompt)
vi session create \
  --agent <agentId> \
  --cwd /home/amd/project \
  --goal "fix the failing unit tests in packages/core"

# JSON output — capture the jobId
JOB=$(vi session create \
  --agent <agentId> \
  --skill rocm-debug \
  --cwd /home/amd/rocm-project \
  --goal "the HIP kernel build fails" \
  --json | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
```

---

## 4. Wait and inspect

```bash
# Wait until the agent picks up the job (queued → running, typically 2–10s)
vi session wait $JOB --until running --timeout 30

# Wait until Claude finishes its first response
# Note: plan-mode sessions (the default with --goal) report 'busy' at the input
# prompt, not 'waiting_input'. Include both.
vi session wait $JOB --until waiting_input,busy,completed,failed --timeout 600

# Inspect the log tail
vi session logs $JOB

# Pipe to search
vi session logs $JOB | grep -i error

# Full detail: status, provider state, model, cwd, log tail
vi session get $JOB

# JSON — extract just the provider state
vi session get $JOB --json \
  | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('providerState',{}).get('state',''))"
```

---

## 5. Continue and control

```bash
# Send text input (with Enter)
vi session send $JOB "Continue with option 1"

# Send text without pressing Enter (type into a prompt before submitting)
vi session send $JOB "y" --no-submit

# Send Escape — interrupt a running tool call
vi session send $JOB --key escape

# Wait for the next pause after sending
vi session wait $JOB --until waiting_input,busy,completed,failed --timeout 600

# Repeat as needed
vi session logs $JOB
```

---

## 6. Approvals

VI routes risky operations through an approval queue. List and decide them at any time.

```bash
# List open approval requests
vi approvals

# Show all (including already decided)
vi approvals --status all

# Approve
vi approve <requestId>

# Reject with a reason
vi reject <requestId> --response "Too broad — restrict to the failing module only"
```

---

## 7. Full orchestrator workflow

End-to-end example: machines → create with skill → wait → logs → send → approve.

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Pick a connected agent
AGENT=$(vi machines --json \
  | python3 -c "
import sys, json
agents = json.load(sys.stdin)
running = [a for a in agents if a['status'] == 'running' and a['connectionState'] == 'connected']
if not running: raise SystemExit('no connected agents')
print(running[0]['agentId'])
")
echo "Using agent: $AGENT"

# 2. Start the session
JOB=$(vi session create \
  --agent "$AGENT" \
  --skill rocm-debug \
  --cwd /home/amd/rocm-project \
  --goal "the HIP kernel fails on ROCm 6.2 — find root cause and propose fix" \
  --json | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
echo "Created: $JOB"

# 3. Wait for running
vi session wait "$JOB" --until running --timeout 30

# 4. Wait for first response
vi session wait "$JOB" --until waiting_input,busy,completed,failed --timeout 600

# 5. Read findings
vi session logs "$JOB"

# 6. If still interactive, ask for a summary
STATE=$(vi session get "$JOB" --json \
  | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('providerState',{}).get('state',''))")

if [[ "$STATE" == "waiting_input" || "$STATE" == "busy" ]]; then
  vi session send "$JOB" "Summarise your findings in 3 bullet points then stop."
  vi session wait "$JOB" --until waiting_input,busy,completed,failed --timeout 300
  vi session logs "$JOB"
fi

# 7. Handle any pending approvals
OPEN=$(vi approvals --json | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
if [[ "$OPEN" -gt 0 ]]; then
  vi approvals
  echo ""
  echo "Review the approvals above, then run:"
  echo "  vi approve <requestId>"
  echo "  vi reject  <requestId> --response '...'"
fi
```

---

## Quick reference

| Command | What it does |
|---------|-------------|
| `vi config show` | Show relay URL + token status |
| `vi machines` | List agents and connection state |
| `vi sessions` | List all jobs |
| `vi overview` | Summary stats (agents, running, pending) |
| `vi skills init <name>` | Scaffold a new skill |
| `vi skills list` | List all skill packs |
| `vi skills show <name>` | Inspect metadata + instructions preview |
| `vi skills validate <name>` | Check for issues (exit 0 always) |
| `vi session create --agent ... --goal ...` | Start a session |
| `vi session create --skill <name> ...` | Start with skill context |
| `vi session wait <id> --until <states>` | Block until state matches |
| `vi session logs <id>` | Tail the PTY log |
| `vi session send <id> <text>` | Send text input |
| `vi session get <id>` | Full session detail |
| `vi approvals` | List open approvals |
| `vi approve <id>` / `vi reject <id>` | Decide an approval |

Exit codes: `0` success · `1` user/config error · `2` relay error · `3` not found · `4` read-only violation

---

## Troubleshooting

**No machines connected**
```
vi machines → empty table, or all status=disconnected
```
On the remote machine, check the vi-agent daemon:
```bash
ps aux | grep vi-agent
tail -f ~/.config/vi-agent/*.log
# Restart:
vi-agent start --relay-url https://relay.dynastylab.ai --token <daemon-token>
```

**Session create succeeds but vi session logs shows nothing**

The agent hasn't picked up the job yet. Check:
```bash
vi session get $JOB   # status should change queued → running within 10s
vi machines           # confirm connectionState=connected, not just status=running
```
If stuck at `queued` for > 30s, the agent may have lost its relay connection. Restart vi-agent on the remote machine.

**Plan mode shows `busy` instead of `waiting_input`**

This is expected. When `VI_INITIAL_GOAL` is set, vi-agent injects the goal as `/plan <content>` which puts Claude Code into plan mode. In plan mode the PTY detector reports `busy` at the input prompt rather than `waiting_input`. Use both in your wait:
```bash
vi session wait $JOB --until waiting_input,busy,completed,failed --timeout 600
```
Then check logs for your expected marker before sending follow-up input.

**Skills not found (`Error: skill not found: rocm-debug`)**

```bash
vi skills list            # confirm the skill appears
ls ~/.vi/skills/rocm-debug/   # confirm skill.yaml + instructions.md both exist
vi skills validate rocm-debug # check for parse errors
```
Skills must have both `skill.yaml` and `instructions.md`. A missing file silently prevents resolution.

**Read-only mode blocks writes**

```bash
Error: write commands are disabled (VI_CLI_READ_ONLY=1)
```
`VI_CLI_READ_ONLY=1` is set in the environment. Unset it, or use a shell without that variable. This flag intentionally disables all write commands (`session create`, `session send`, `approve`, `reject`).

**Dashboard slow — use CLI as fallback**

The dashboard polls every 8s at level 1. For faster feedback during active debugging:
```bash
# Continuous log poll
watch -n 3 vi session logs $JOB

# One-shot state check
vi session get $JOB --json | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j.get('providerState',{}).get('state',''))"
```

---

## Using this as an orchestrator context

If you are a Claude Code session reading this file to orchestrate a remote agent:

1. Run `vi machines --json` to discover available agents.
2. Run `vi skills list --json` to discover available skills.
3. Use `vi session create ... --json` to start a session and capture `jobId`.
4. Use `vi session wait ... --json` to poll. `matchedState` in the JSON output tells you what triggered the match.
5. Use `vi session logs` to read output. Pipe to `grep` for specific markers.
6. Use `vi approve`/`vi reject` only after inspecting the approval request via `vi approvals --json`.
7. Never hard-code agent IDs — discover them from `vi machines` at runtime.
