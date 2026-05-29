# VI Orchestrator — Daily Usage

This is the practical reference for using VI day-to-day, whether you're a human at the terminal or a Claude Code session acting as an orchestrator.

---

## 1. Check what's running

```bash
vi machines               # list agents and their connection state
vi sessions               # list all active jobs across all machines
vi sessions --status running   # filter to running only
vi overview               # summary stats (machines, running, pending approvals)
```

---

## 2. Create a skill for a task type

Skills inject reusable prompt instructions into every session that uses them.

```bash
# Scaffold a new skill
vi skills init rocm-debug

# Edit the instructions
$EDITOR ~/.vi/skills/rocm-debug/instructions.md

# Validate before using
vi skills validate rocm-debug

# List all available skills
vi skills list
```

Example `~/.vi/skills/rocm-debug/instructions.md`:
```markdown
You are diagnosing a ROCm/HIP GPU build failure.

1. Read the full build log before drawing conclusions.
2. Identify whether the failure is a missing library, a compiler version mismatch, or a kernel header issue.
3. Propose the minimal fix. Do not change unrelated files.
4. If you need to run a command with side effects, request a VI approval first.
```

---

## 3. Start a session

```bash
# Basic — no skill
vi session create \
  --agent rag_47675540-... \
  --cwd /home/amd/project \
  --goal "fix the failing unit tests in packages/core"

# With a skill
vi session create \
  --agent rag_47675540-... \
  --skill rocm-debug \
  --cwd /home/amd/rocm-project \
  --goal "the HIP kernel build fails on ROCm 6.2 — find the root cause"

# With model override
vi session create \
  --agent rag_47675540-... \
  --skill rocm-debug \
  --model claude-opus-4-7 \
  --cwd /home/amd/rocm-project \
  --goal "..."

# Check what VI_INITIAL_GOAL will look like before creating
vi skills show rocm-debug
```

---

## 4. Wait for the session to reach a known state

```bash
JOB=raj_a10efa77-...

# Wait until the agent picks up the job (queued → running)
vi session wait $JOB --until running --timeout 30

# Wait until Claude finishes its initial response
# Note: plan-mode sessions report 'busy' at the input prompt, not 'waiting_input'
vi session wait $JOB --until waiting_input,busy,completed,failed --timeout 120
```

---

## 5. Check logs

```bash
# Show log tail (last ~200 lines from the PTY)
vi session logs $JOB

# Pipe to search
vi session logs $JOB | grep -i error

# Full detail (status, model, cwd, log tail)
vi session get $JOB
```

---

## 6. Send input to a running session

```bash
# Send text + Enter
vi session send $JOB "looks good, continue to the next file"

# Send text without pressing Enter (e.g. to type into a prompt before submitting)
vi session send $JOB "y" --no-submit

# Send Escape (interrupt a running tool call)
vi session send $JOB --key escape
```

---

## 7. Handle approvals

```bash
# List open approval requests
vi approvals

# Show all (including already decided)
vi approvals --status all

# Approve or reject
vi approve rar_abc123-...
vi reject  rar_abc123-... --response "too risky, use a scoped approach"
```

---

## 8. End-to-end orchestrator pattern

This is how a Claude Code session (or a shell script) can autonomously orchestrate another agent:

```bash
#!/usr/bin/env bash
set -euo pipefail
AGENT="rag_47675540-..."

# 1. Start job
JOB=$(vi session create \
  --agent "$AGENT" \
  --skill code-review \
  --goal "review the diff in the last commit for correctness and security" \
  --json | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")

echo "Created: $JOB"

# 2. Wait for agent to start
vi session wait "$JOB" --until running --timeout 30

# 3. Wait for review to finish
vi session wait "$JOB" --until waiting_input,busy,completed,failed --timeout 300

# 4. Read the output
vi session logs "$JOB"

# 5. Send follow-up if still interactive
STATE=$(vi session get "$JOB" --json | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('providerState',{}).get('state',''))")
if [[ "$STATE" == "waiting_input" || "$STATE" == "busy" ]]; then
  vi session send "$JOB" "thanks — please summarise your findings in 3 bullet points then stop"
fi
```

---

## Quick reference

| Command | What it does |
|---------|-------------|
| `vi machines` | List agents and connection state |
| `vi sessions` | List all jobs |
| `vi overview` | Summary stats |
| `vi skills list` | List skill packs |
| `vi skills init <name>` | Scaffold a new skill |
| `vi skills show <name>` | Inspect instructions + metadata |
| `vi skills validate <name>` | Check for issues |
| `vi session create --agent ... --goal ...` | Start a session |
| `vi session create --skill <name> ...` | Start with skill context |
| `vi session wait <id> --until <states>` | Block until state matches |
| `vi session logs <id>` | Tail the PTY log |
| `vi session send <id> <text>` | Send text input |
| `vi session get <id>` | Full session detail |
| `vi approvals` | List open approvals |
| `vi approve <id>` / `vi reject <id>` | Decide an approval |

Exit codes: `0` success · `1` user/config error · `2` relay error · `3` not found · `4` read-only

---

## Automating this with Claude Code

Claude Code can read this file and use `vi` as a subprocess. The recommended pattern:

1. Read `docs/vi-orchestrator.md` (this file) for available commands
2. Use `vi machines --json` to discover available agents
3. Use `vi skills list --json` to discover available skills
4. Use `vi session create ... --json` to launch sessions
5. Use `vi session wait ... --json` to poll for completion
6. Use `vi session logs` to read output
7. Use `vi approve`/`vi reject` only after reviewing the approval content

The full CLI reference is in `docs/vi-cli.md`. The skill pack reference is in `docs/vi-skills.md`.
