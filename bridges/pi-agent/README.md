# pi-agent

Remote agent daemon for [Project Interface](../../README.md).

Install pi-agent on any machine that will run AI coding sessions. It connects outbound to the PI dashboard (local mode) or PI Relay (cloud mode), launches Claude Code or Codex CLI in a tmux session, and streams terminal output back to the browser.

---

## Install

From the PI repo root:

```bash
pip install -e bridges/pi-agent
```

Verify:

```bash
pi-agent --help
```

---

## Pair and start

Get a pair code from **Dashboard → Machines → Add machine**, then run:

```bash
# Local mode (dashboard on same LAN)
pi-agent pair --server http://192.168.1.83:3000 --code XXXX1234ABCD --start

# Cloud mode (relay on public internet)
pi-agent pair --server https://your-relay.fly.dev --code XXXX1234ABCD --start
```

The `--start` flag starts the background daemon immediately after pairing. Without it, use `start-daemon` separately.

---

## Commands

### Daemon lifecycle

```bash
# Start daemon from saved state
pi-agent start-daemon --state-file ~/.config/pi-agent/<project>-agent-<name>.json --tool claude

# Check running status
pi-agent status

# Stop daemon
pi-agent stop-daemon --state-file ~/.config/pi-agent/<project>-agent-<name>.json

# Restart daemon
pi-agent restart-daemon --state-file ~/.config/pi-agent/<project>-agent-<name>.json

# Clean up stale PID/state
pi-agent cleanup --state-file ~/.config/pi-agent/<project>-agent-<name>.json
```

### Other commands

| Command | Description |
|---------|-------------|
| `pair` | Connect to PI with a one-time enrollment code |
| `status` | Print daemon PID, state file path, and running status |
| `context` | Print current agent identity as JSON |
| `run` | Run a wrapped command as a managed remote job |
| `claude` | Launch Claude Code as a managed remote job |
| `codex` | Launch Codex CLI as a managed remote job |
| `request-approval` | Send an approval request to PI and wait for a response |
| `approve-command` | Wrap a risky command behind a PI approval gate |
| `handoff-update` | Update the session handoff context in PI |

---

## State and log files

Pairing creates files under `~/.config/pi-agent/`:

```
~/.config/pi-agent/
  <project>-agent-<name>.json    # state: agentId, server URL, relay config, auth token
  <project>-agent-<name>.pid     # daemon PID
  <project>-agent-<name>.log     # daemon stdout/stderr
  jobs/
    <jobId>.log                  # per-job output log
```

Override the state file path with `--state-file /custom/path.json`.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `PI_AGENT_TOOL` | Default tool if not passed via `--tool` (`claude`, `codex`, `other`) |
| `PI_TERMINAL_RELAY_URL` | Override terminal relay WebSocket URL (set automatically after pairing in cloud mode) |
| `ANTHROPIC_API_KEY` | Required by Claude Code for non-interactive/headless use |

---

## Recovery example

If the daemon crashed or the machine was rebooted:

```bash
# Check status
pi-agent status

# If state file exists, just restart
pi-agent restart-daemon --state-file ~/.config/pi-agent/<project>-agent-<name>.json --tool claude

# If agent is stale or token was rotated, re-pair
# (get a new enrollment code from Dashboard → Machines → Reconnect)
pi-agent pair --server https://your-relay.fly.dev --code NEWCODE --start
```

---

## Requirements

- Python ≥ 3.11
- tmux (for terminal streaming)
- `websocket-client >= 1.8.0`
