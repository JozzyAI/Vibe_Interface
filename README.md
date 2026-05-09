# Project Interface (PI)

**Project Interface** is a standalone control plane for managing AI coding agents. It gives you one place to create tasks, track running sessions, handle human-in-the-loop approvals, and manage remote agent machines — without requiring any specific agent runner framework.

> **Status:** Early-stage / active development. Core UI, session management, remote agent protocol, and approval flows are implemented. Some runtime integrations (local session spawning, tmux capture) are currently stubbed — see [What's Stubbed](#whats-stubbed) below.

---

## What problem does it solve?

Running AI coding agents at any scale means juggling:

- Where are my agents running?
- Which ones need my approval to continue?
- Which sessions failed and need recovery?
- How do I send a task to a specific machine?

PI answers all of these from a single web dashboard and a lightweight JSON-based session store — no external services required to get started.

---

## Features

| Area | Description |
|---|---|
| **Session dashboard** | Live list of all agent sessions with status, activity, branch, PR, and CI state |
| **Approval inbox** | Centralized view of sessions blocked waiting for human input |
| **Remote agents** | Enroll remote machines (Codex CLI, Claude Code, etc.) via a one-time token; jobs and approvals flow through a relay |
| **Idea board** | Draft task specs in markdown columns (Idea Bank → Queue → Working → Done), then send to a connected agent |
| **Session detail** | Per-session view with terminal stream, approval panel, PR/CI status, and session summary |
| **GitHub connector** | Connect GitHub accounts via PAT or OAuth for issue and PR integration |
| **Relay service** | Standalone WebSocket broker (`packages/relay`) for remote agents behind NAT |
| **PI session store** | All session state lives in `~/.pi/sessions/` — plain JSON, no database required |

---

## Packages

### `packages/core` — `@pi/core`

TypeScript library. Owns all PI business logic:

- **Types** — `PISession`, `PISessionStatus`, `PIActivityState`, `CIStatus` and all state enums
- **Paths** — storage path helpers (`~/.pi/sessions/`, `~/.pi/projects/`, `~/.pi/observability/`)
- **Session store** — read/write sessions from `~/.pi/sessions/{id}.json`; returns mock sessions when the store is empty (first-run experience)
- **PI control plane** — `derivePISessionState()`, `readPISessionArtifacts()`, `listPIGitHubConnectors()`, `isRestorable()`, idea board CRUD, GitHub OAuth state

### `packages/relay` — `@pi/relay`

Standalone WebSocket relay broker. Remote agents connect here when they cannot reach the PI dashboard directly. Only dependency: `ws`.

### `packages/web` — `@pi/web`

Next.js 15 dashboard. All pages are server-rendered where possible, client-polled every 5 seconds for live updates.

- `src/app/` — pages: `/`, `/sessions`, `/sessions/[id]`, `/agents`, `/approval-hub`, `/ideas`, `/remote-sessions/[id]`, `/tasks`
- `src/app/api/` — REST API routes: `/api/sessions`, `/api/pi/*`, `/api/remote-agents/*`, `/api/events` (SSE)
- `src/components/` — PI-prefixed React components (no framework lock-in)
- `src/lib/` — server-side business logic, session helpers, GitHub connector API, relay dispatch

---

## What's Stubbed

These features have working UI and API routes but their backend implementations are placeholders:

| Feature | Status |
|---|---|
| Local session spawning | Stub — `sessionManager.spawn()` writes a `PISession` record with `status: "spawning"` but does not start an agent process |
| Session `send` (input to agent) | Stub — no-op; remote agent send works via relay |
| Terminal capture for local sessions | Stub — approval audit trail shows events without tmux terminal snapshot |
| Idea materialization (GitHub issue creation) | Wired — calls GitHub connector API; requires a configured GitHub PAT |
| Workspace file listing | Falls back to `["PI", "README.md"]` if `PI_WORKSPACE_ROOT` directory is unreadable |

Remote agent sessions (enrolled via the Machines page) are **fully implemented** — job dispatch, approval requests, heartbeats, and the relay broker all work end-to-end.

---

## Requirements

- Node.js ≥ 20
- pnpm ≥ 9

---

## Install

```bash
pnpm install
```

---

## Run locally (dev mode)

```bash
pnpm --filter @pi/web dev
```

Dashboard available at `http://localhost:3000`.

To run the relay alongside the dashboard:

```bash
pnpm --filter @pi/relay start &
pnpm --filter @pi/web dev
```

---

## Run locally (production build)

```bash
pnpm --filter @pi/core build
pnpm --filter @pi/relay build
pnpm --filter @pi/web build
node packages/web/node_modules/.bin/next start -p 3000
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Next.js server port |
| `PI_WORKSPACE_ROOT` | `/srv/pi/workspaces` | Root directory shown in the workspace file panel |
| `NEXT_PUBLIC_TERMINAL_WS_PATH` | — | Override WebSocket path for terminal proxy (production deployments) |
| `NEXT_PUBLIC_DIRECT_TERMINAL_PORT` | `14801` | Direct terminal WebSocket port (dev / local) |
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
