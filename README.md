# Project Interface (PI)

**Project Interface** is a standalone control plane for managing AI coding agents. It gives you one place to create tasks, track running sessions, handle human-in-the-loop approvals, and watch live terminals — without requiring any specific agent runner framework.

---

## What problem does it solve?

Running AI coding agents means juggling:

- Where are my agents running?
- Which ones need my approval to continue?
- Which sessions failed and need recovery?
- How do I send a task to a specific machine?

PI answers all of these from a single web dashboard.

---

## Features

| Area | Description |
|---|---|
| **Session dashboard** | Live list of all agent sessions with status, activity, and log tail |
| **Live terminal** | Browser-based terminal (xterm.js) connected to the agent's tmux session via WebSocket |
| **Approval inbox** | Centralized view of sessions blocked waiting for human input |
| **Remote agents** | Enroll remote machines (Codex CLI, Claude Code) via a one-time token; jobs and approvals flow over a WebSocket relay |
| **Idea board** | Draft task specs, then dispatch directly to a connected agent |
| **GitHub connector** | Connect GitHub accounts via PAT for issue and PR integration |

---

## Architecture: two processes

PI runs as **two processes** that must both be running:

| Process | Command | Port | Purpose |
|---|---|---|---|
| Next.js dashboard | `next dev` | `3000` | Web UI + all REST API routes |
| DirectTerminal WS | `tsx watch server/direct-terminal-ws.ts` | `14801` | WebSocket server for live terminal (xterm.js ↔ tmux) |

Both are started together by the `dev` script via `concurrently`.

---

## Requirements

- Node.js ≥ 20
- pnpm ≥ 9
- tmux (for live terminal support on the agent machine)
- Python ≥ 3.11 (for `pi-agent`)

---

## Install

```bash
pnpm install
```

---

## Start (dev mode)

From the repo root:

```bash
cd packages/web
node_modules/.bin/concurrently \
  "node_modules/.bin/next dev -p 3000 -H 0.0.0.0" \
  "node_modules/.bin/tsx watch server/direct-terminal-ws.ts"
```

Or via the root shorthand (uses `pnpm --filter @pi/web dev` which calls the same concurrently command):

```bash
pnpm dev
```

### Access from the host machine (WSL2)

If PI runs inside WSL2, the dashboard is **not** at `localhost` from your Windows browser.
Use the WSL2 network IP instead:

```
http://<WSL2-IP>:3000
```

Find your WSL2 IP:

```bash
ip addr show eth0 | grep "inet " | awk '{print $2}' | cut -d/ -f1
```

Example: `http://172.22.218.134:3000`

The Next.js server binds to `0.0.0.0` (`-H 0.0.0.0`) so it is reachable at that IP.

---

## Production build

```bash
pnpm --filter @pi/web build
node packages/web/dist-server/start-all.js
```

`start-all.js` spawns both Next.js and the DirectTerminal WS server in a single process with auto-restart.

---

## pi-agent (remote agent bridge)

Install on any machine that will run agent jobs:

```bash
pip install -e bridges/pi-agent
```

Pair with the PI dashboard using a one-time connect code from the Machines page:

```bash
pi-agent pair --server http://<PI_HOST>:3000 --code ABCD1234
```

Start the background daemon:

```bash
pi-agent start-daemon --server http://<PI_HOST>:3000
```

The daemon polls for jobs, streams terminal output, and routes approval requests back to the dashboard. It connects via the built-in WebSocket relay in the PI server — no separate relay process needed.

### Claude Code permission modes

When launching a Claude Code session from PI:

| Mode | Behavior |
|---|---|
| **Manual** | Claude asks for approval in the live terminal. You respond by typing in the DirectTerminal view. |
| **Always** | Launches Claude with `--dangerously-skip-permissions`. All tools run without prompts. |

`timeout_allow` (auto-approve after N seconds) is available for Codex CLI sessions only.

To re-enable the experimental PI approval hook system (hooks Claude Code's PreToolUse event):

```bash
export PI_ENABLE_CLAUDE_APPROVAL_HOOKS=1
```

Default is disabled — Claude Code 2.1.x kills hooks after ~2–3 seconds regardless of timeout, making blocking approval gates unreliable.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Next.js server port |
| `PI_WORKSPACE_ROOT` | `/srv/pi/workspaces` | Root directory for the workspace file browser |
| `NEXT_PUBLIC_DIRECT_TERMINAL_PORT` | `14801` | DirectTerminal WebSocket port |
| `PI_RELAY_TOKENS` | — | Comma-separated `token:kind:label` entries for pi-agent auth. Empty = dev mode (no auth). |
| `PI_ENABLE_CLAUDE_APPROVAL_HOOKS` | `0` | Set to `1` to enable experimental Claude approval hook system |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app client ID (optional — PAT auth works without it) |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app client secret |

---

## Storage layout

PI stores all runtime state in `~/.pi/` — no database required:

```
~/.pi/
  sessions/          # one JSON file per session ({id}.json)
  projects/
    {projectId}/
      pi-state/      # session artifacts: summary, questions, execution state
      ideas.json     # idea board state
      github-connectors.json
  observability/     # OAuth state tokens
  remote-agents/     # enrolled remote machine records
```

---

## License

MIT — see [LICENSE](LICENSE).
