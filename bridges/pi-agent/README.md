# pi-agent

Remote agent client for [Project Interface](../../README.md).

Install this on any machine that will run AI coding agents (Codex CLI, Claude Code, etc.) so PI can see it, dispatch jobs, and route approval requests back to the dashboard.

## Install

From the PI repo root:

```bash
pip install -e bridges/pi-agent
```

Or install a specific release tarball served by your PI dashboard:

```bash
pip install http://YOUR_PI_HOST:3000/api/remote-agents/bootstrap/package
```

Or use the one-click bootstrap script from the Machines page — it installs and pairs in one command.

## Quick start

**Pair with PI using a connect code from the Machines page:**

```bash
pi-agent pair --server http://YOUR_PI_HOST:3000 --code ABCD1234EFGH5678 --start
```

This saves a state file and immediately starts the background daemon.

**Start the daemon from a saved state file:**

```bash
pi-agent start-daemon --state-file ~/.config/pi-agent/my-project.json
```

**Run with relay (when the machine can't reach PI directly):**

```bash
pi-agent start-daemon \
  --server https://pi.yourdomain.com \
  --relay-url wss://relay.yourdomain.com/ws \
  --relay-token YOUR_TOKEN \
  --display-name "Office Codex" \
  --project "my-project" \
  --tool codex-cli
```

## State files

Pairing creates a state file at:

```
~/.config/pi-agent/<project>-<tool>-<name>.json
```

Override the path with `--state-file /path/to/state.json`.

Companion files (same directory):
- `*.pid` — daemon PID
- `*.log` — daemon log
- `jobs/<job-id>.log` — per-job output

## Commands

| Command | Description |
|---|---|
| `pair` | Connect to PI with a one-time code |
| `start-daemon` | Start background daemon from saved state |
| `restart-daemon` | Stop and start the daemon from the same saved state |
| `stop-daemon` | Stop the background daemon |
| `cleanup` | Remove stale PID state; optionally kill PI-owned job tmux sessions |
| `status` | Check daemon health |
| `context` | Print current daemon identity as JSON |
| `run` | Run a wrapped command with auto register + heartbeat |
| `claude` | Run Claude Code as a managed remote job |
| `codex` | Run Codex CLI as a managed remote job |
| `request-approval` | Send an approval request to PI and wait |
| `approve-command` | Wrap a risky command behind PI approval |
| `handoff-update` | Update session handoff context |

Fresh recovery examples:

```bash
pi-agent restart-daemon
pi-agent cleanup --kill-jobs --clear-jobs
pi-agent restart-daemon
```

## Environment variables

| Variable | Description |
|---|---|
| `PI_SERVER` | PI dashboard URL |
| `PI_RELAY_URL` | Relay WebSocket URL (optional) |
| `PI_RELAY_TOKEN` | Relay auth token (optional) |
| `PI_AGENT_STATE_FILE` | Path to state file |
| `PI_AGENT_ID` | Agent ID (set automatically after pairing) |
| `PI_AGENT_DISPLAY_NAME` | Display name shown in the dashboard |
| `PI_AGENT_PROJECT` | Project label |
| `PI_AGENT_TOOL` | Tool type (`codex-cli`, `claude-code`) |

## Examples

See the `examples/` folder for sample scripts.

## Requirements

- Python ≥ 3.10
- `websocket-client >= 1.8.0`
