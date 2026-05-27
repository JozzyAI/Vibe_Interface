# VI CLI (`vi`)

`vi` is the command-line orchestrator interface for VI Relay. It lets you inspect agents, manage sessions, and respond to approval requests — all scriptable and pipe-friendly.

**Binary:** `vi` (package `@vi/cli`, installed from `packages/vi-cli`)  
**Transport:** VI Relay HTTP API (`@vi/client-sdk`)

---

## 1. Setup

```bash
vi config set --base-url https://your-relay.fly.dev
vi config set --token <your-vi-token>
```

Config is stored in `~/.vi/config.json` (chmod 600). Token is never echoed.

Override per-command via env vars:
```bash
VI_RELAY_BASE_URL=https://... VI_RELAY_VI_TOKEN=... vi overview
```

Verify:
```bash
vi config show
# Base URL : https://your-relay.fly.dev
# Token    : (set)
# Config   : /home/user/.vi/config.json
```

---

## 2. Inspect

```bash
vi overview                        # summary: machines, running, pending approvals, failed
vi machines                        # list all agents
vi machines --status running       # filter by status
vi sessions                        # list all jobs
vi sessions --agent <agentId>      # filter by machine
vi sessions --status running       # filter by status
vi approvals                       # open approval requests (default)
vi approvals --status all          # all requests
```

Add `--json` to any command for machine-readable output:
```bash
vi machines --json | jq '.[].agentId'
vi sessions --json | jq '.[] | select(.status == "running") | .jobId'
```

---

## 3. Create a session

Start an interactive Claude Code session on a remote agent:

```bash
vi session create \
  --agent <agentId> \
  --cwd /path/on/remote \
  --goal "Describe what Claude should do" \
  --model claude-opus-4-7 \
  --title "My task"
```

- `--agent` is required; get the ID from `vi machines`.
- `--goal` is injected as `VI_INITIAL_GOAL` — Claude receives it as an initial prompt. Session stays interactive; Claude does not exit after the goal.
- `--model` is optional; defaults to the agent's configured model.
- `--cwd` sets the working directory on the remote machine.

```bash
vi session create --agent <agentId> --cwd /tmp --goal "list running processes" --json
# → { "jobId": "raj_...", "status": "queued", ... }
```

---

## 4. Control a session

**Send text input:**
```bash
vi session send <jobId> "your message"           # sends text + Enter
vi session send <jobId> "your message" --no-submit  # types without pressing Enter
vi session send <jobId> --key escape             # sends Escape key
```

**Wait for a state:**
```bash
vi session wait <jobId> --until waiting_input
vi session wait <jobId> --until completed,failed --timeout 600
```

Valid `--until` values:
- `job.status`: `running`, `completed`, `failed`, `archived`
- `providerState.state`: `waiting_input`, `busy`, `waiting_approval`

**Read logs:**
```bash
vi session logs <jobId>                          # raw log tail (pipeable)
vi session logs <jobId> | grep -i error
```

**Inspect a session:**
```bash
vi session get <jobId>                           # key-value detail table
vi session get <jobId> --json                    # full job object
```

---

## 5. Approvals

When Claude requests approval for a risky tool call, it appears as an open approval request.

```bash
vi approvals                                     # list open requests
vi approve <requestId>                           # approve
vi approve <requestId> --response "looks fine"  # approve with note
vi reject  <requestId> --response "too risky"   # reject with reason
vi approve <requestId> --json                    # output updated request as JSON
```

---

## 6. Orchestrator workflow example

Full pipeline: create → wait for input → inspect → send → wait for completion → read output.

```bash
# 1. Pick a machine
AGENT=$(vi machines --json | jq -r '.[0].agentId')

# 2. Start a session
JOB=$(vi session create \
  --agent "$AGENT" \
  --cwd /workspace \
  --goal "Run the test suite and report failures" \
  --title "CI check" \
  --json | jq -r '.jobId')

echo "Created: $JOB"

# 3. Wait until Claude is ready for input
vi session wait "$JOB" --until waiting_input --timeout 60

# 4. Check what Claude has planned
vi session logs "$JOB" | tail -20

# 5. Approve the plan and proceed
vi session send "$JOB" "1"   # "Yes, proceed"

# 6. Wait for session to finish (or need more input)
vi session wait "$JOB" --until completed,failed,waiting_input --timeout 300

# 7. Handle any approval requests that arose during execution
APPROVAL=$(vi approvals --json | jq -r '.[0].requestId // empty')
if [ -n "$APPROVAL" ]; then
  vi approvals --json | jq '.[0] | {title, riskLevel, toolName}'
  vi approve "$APPROVAL" --response "approved by CI script"
  vi session wait "$JOB" --until completed,failed --timeout 120
fi

# 8. Read the final output
vi session logs "$JOB"
vi session get  "$JOB"
```

---

## 7. Safety flags

| Flag / Env | Effect |
|---|---|
| `VI_CLI_READ_ONLY=1` | Blocks all write commands (exit 4). Safe for read-only observers. |
| `--json` | Suppresses all prose; outputs raw JSON to stdout only. |

All errors go to **stderr**. All data goes to **stdout**. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | User / config error |
| 2 | Relay / network / auth error |
| 3 | Not found |
| 4 | Write blocked (`VI_CLI_READ_ONLY=1`) |
