# VI Architecture

## Goal

A standalone control plane for AI coding agents: idea intake, human-in-the-loop approvals, session recovery, and remote machine management — all backed by plain JSON files with no database or external service dependency.

---

## Package layout

```
packages/
  core/     @vi/core    — types, paths, session store, control plane logic
  relay/    @vi/relay   — WebSocket relay broker for remote agents
  web/      @vi/web     — Next.js dashboard (pages, API routes, components)
```

---

## `packages/core`

Pure TypeScript library with no runtime framework dependency.

**`src/types.ts`** — all VI-owned types:
- `VISession` — canonical session record
- `VISessionStatus` — 16-value status enum (spawning → working → pr_open → merged → …)
- `VIActivityState` — live agent activity (active / idle / waiting_input / blocked / exited)
- `CIStatus`, `VIProjectConfig`, `VITracker`
- `createMockVISessions()` — returns realistic demo sessions for first-run experience

**`src/paths.ts`** — storage path helpers, all rooted at `~/.pi/`:
- `getVISessionsRegistryDir()` → `~/.pi/sessions/`
- `getVIProjectBaseDir(projectId)` → `~/.pi/projects/{id}/`
- `getVIObservabilityDir()` → `~/.pi/observability/`

**`src/session-store.ts`** — VI session registry:
- `listVISessions()` — reads all `~/.pi/sessions/*.json`; falls back to mock sessions if empty
- `upsertVISession()`, `deleteVISession()`

**`src/pi-control-plane.ts`** — core control-plane logic:
- `deriveVISessionState()` — maps raw session fields to a VI state label
- `readVISessionArtifacts()` / `writeVISessionHandoff()` — session summaries and handoff bundles
- `upsertVIPendingQuestion()` / `respondToVIPendingQuestion()` — human-in-the-loop Q&A
- `listVIGitHubConnectors()` / `upsertVIGitHubConnector()` — GitHub PAT/OAuth connector store
- `isVISessionRestorable()` — predicate for restore button visibility
- Idea board CRUD — `getVIIdeaBoard()`, `createVIIdeaCard()`, `moveVIIdeaCard()`
- Plan generation — `createVIIdeaPlan()` (calls LLM to expand idea to issue drafts)

---

## `packages/relay`

Standalone WebSocket broker. No Next.js, no VI core dependency. Only `ws`.

Remote agents connect to the relay when they cannot reach the VI dashboard directly (e.g., behind NAT or a firewall). The relay forwards job dispatch and approval requests between PI and the agent.

**`src/server.ts`** — HTTP upgrade handler + per-connection routing
**`src/routing.ts`** — message routing table (pi → agent, agent → pi)
**`src/auth.ts`** — token-based enrollment auth

---

## `packages/web`

Next.js 15 app router. Server-rendered pages with 5-second client polling for live updates. SSE (`/api/events`) for real-time activity state without full poll overhead.

### Pages

| Route | Description |
|---|---|
| `/` | Home — start task, needs-attention and running-now strips |
| `/sessions` | Session wall — approval inbox + session list for all projects |
| `/sessions/[id]` | Session detail — terminal, approval panel, PR/CI status, summary |
| `/agents` | Remote machines — enrollment, job list, connection status |
| `/remote-sessions/[id]` | Live remote session — terminal stream + approval controls |
| `/approval-hub` | Fleet approval management — policy settings, audit trail |
| `/ideas` | Idea board — markdown drafts → queue → active → done |
| `/tasks` | Tasks view (placeholder) |

### API routes

**PI control plane** (`/api/vi/*`):
- `approval-hub` — fleet approval state and policy
- `control-plane` — session artifact reads
- `github/connectors` — GitHub account management
- `github/oauth` — OAuth start/callback
- `ideas/board`, `ideas/create`, `ideas/plan` — idea board CRUD + LLM plan
- `requests/create`, `requests/respond` — human-in-the-loop Q&A

**Session management** (`/api/sessions/*`):
- CRUD + kill, delete, restore, send, native-approval, output

**Remote agents** (`/api/remote-agents/*`) — 21 routes:
- Enrollment, heartbeat, jobs, job lifecycle, requests, policy, overview, bootstrap

**SSE** (`/api/events`) — server-sent events stream of session snapshots for live title/activity updates

### State management

No global state store. Each page fetches on mount and polls every 5 seconds. SSE supplements polling for low-latency activity updates (document title emoji, approval badge counts).

---

## Session state machine

```
spawning → working → pr_open → ci_failed → review_pending
                             → changes_requested
                             → approved → mergeable → merged
         → needs_input
         → stuck
         → errored → (restore) → spawning
         → terminated / killed
         → cleanup → done
```

`deriveVISessionState()` in `@vi/core` maps a `VISession` to a human-readable attention level: **merge**, **respond**, **review**, **pending**, **working**, **done**.

---

## Persistence contract

Every session record is a single JSON file at `~/.pi/sessions/{id}.json`.

Session artifacts (written by the agent via the VI control plane API) live in `~/.pi/projects/{projectId}/pi-state/{sessionId}/`:
- `session-summary.md` — markdown summary of what the agent did
- `pending-questions.json` — unanswered questions from the agent
- `execution-state.json` — structured state for recovery

---

## Remote agent protocol

1. User generates enrollment token on the Machines page
2. Remote machine runs `vi-agent` (Python CLI in `bridges/vi-agent/`) or any WebSocket client that speaks the VI job protocol
3. Agent connects to relay or VI dashboard WebSocket directly
4. VI dispatches jobs; agent streams output back; approval requests flow through the same channel

---

## What is not in this repo

- Agent runner binaries (Claude Code, Codex CLI, OpenCode) — VI talks to them via enrollment, not bundled
- Database — all state is plain JSON in `~/.pi/`
- CI/CD configuration — add your own
