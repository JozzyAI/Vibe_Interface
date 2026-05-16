# PI Project Handoff

**Date:** 2026-05-15  
**Repo:** `JozzyAI/Project_Interface`  
**Branch:** `main`  
**Last commit:** `63fd35d feat: add relay-backed cloud control plane`

This document is a complete handoff for another agent or developer to continue without needing the full chat history.

---

## 1. Product Direction

PI is a **multi-server vibe-coding operations platform** — a unified dashboard for managing multiple remote machines, each running AI coding agents (Claude Code, Codex, or others), from any device.

The final product should feel like **Telegram or Slack** for AI coding sessions:

- User logs in from Windows, Mac, web, iPhone, or Android
- All machines, agents, and sessions are tied to the user's account
- Start or resume coding sessions from any device
- Agents run on many different servers/nodes simultaneously
- Works across networks — not LAN-only

### Three core components

| Component | Role |
|-----------|------|
| **PI Dashboard** | Client app (web, desktop, mobile). Shows machines, sessions, approvals. Connects outbound to PI Cloud. |
| **PI Cloud / Relay** | Account layer + control plane + relay. Owns state in production. Routes messages between dashboard clients and pi-agents. |
| **pi-agent** | Execution runtime. Runs on any machine. Launches Claude/Codex/tmux. Reports status, streams terminal, receives commands. Connects outbound only. |

### Long-term security goal

End-to-end encrypted terminal and session payloads — similar to Telegram Secret Chats:
- Dashboard client encrypts locally → PI Cloud forwards ciphertext → pi-agent decrypts
- PI Cloud relay sees only routing metadata, not session contents
- **Not implemented yet.** DB schema and API payloads are stored opaque to support this later without breaking changes.

---

## 2. Architecture Modes

### Mode 1: Local / Same-Wi-Fi (default, no relay config)

```
pi-agent  ──→  dashboard (Next.js :3000)  ←──  browser
               └── data/store.json (source of truth)
terminal  ──→  dashboard (WS :14801)
```

- `packages/web` Next.js server serves both the UI and the backend API
- State stored in `packages/web/data/store.json`
- pi-agent and browser must be on the same network as dashboard
- No relay required
- **Activate:** do NOT set `PI_RELAY_BASE_URL` / `PI_RELAY_PI_TOKEN`

### Mode 2: Cloud Control Plane

```
pi-agent  ──→  PI Relay (:8787)  ←──  dashboard client (browser)
                 └── SQLite (PI_RELAY_DB_PATH)
terminal  ──→  PI Relay (/pi-agent-relay)  ←──  dashboard relay subscriber
```

- `packages/relay` owns all state in SQLite
- pi-agent talks to relay directly — dashboard is NOT in the heartbeat/report loop
- Dashboard reads/writes relay via `/v1/pi/*` REST routes
- **`PI_RELAY_PI_BASE_URL` is fully removed.** The relay never calls back to a local dashboard URL.
- **Activate:** set `PI_RELAY_BASE_URL` + `PI_RELAY_PI_TOKEN` in dashboard env

---

## 3. Recent Major Changes (most recent first)

| Commit | Change |
|--------|--------|
| `63fd35d` | **Relay-backed cloud control plane** — SQLite DB in `packages/relay`, `/v1/daemon/*` and `/v1/pi/*` routes, dashboard backend switch, enrollment consume compat alias |
| `aa62bd1` | Relay terminal proxy (`/pi-agent-relay` on relay server), `RelayTerminalSubscriber` in dashboard, Dockerfile + fly.toml |
| `e263590` | Token-based auth — `PI_ACCESS_TOKEN` middleware, login page at `/login`, session cookie, logout button |
| `658ceb1` | Session action menu in Active Remote Sessions list (kebab menu: open, archive, delete with confirm) |
| `0679059` | Global light theme — `defaultTheme="light"` in ThemeProvider, fixed dark hardcoded colors |
| `e8e979a` | Terminal copy/paste hint + New Session UI cleanup |
| `b29fa4f` | Terminal selection fix — root cause: `tmux set-option mouse on` intercepts drag events; fixed to `mouse off` |
| `516fbf6` | Terminal UTF-8 fix — `StringDecoder` streaming decoder for base64 PTY bytes, eliminates mojibake |
| `28a1e82` | Claude default model — uses `PI_CLAUDE_DEFAULT_MODEL` env var instead of shell aliases (subprocess doesn't expand aliases) |

---

## 4. Key Files and Implementation Details

### packages/relay/src/db.ts
SQLite initialization. Loads `better-sqlite3` via `createRequire` (CommonJS in ESM context). Enables WAL mode + `foreign_keys = ON` + `busy_timeout = 5000`. Creates all tables on startup. Bootstraps default owner row from `PI_RELAY_OWNER_TOKEN`. DB path from `PI_RELAY_DB_PATH` env var (default `./pi-relay.db`).

### packages/relay/src/store.ts
All DB read/write operations. Key functions:
- `registerAgent()` / `heartbeatAgent()` / `pollAgent()` — upsert agents, return poll payload
- `reportJob()` — update job status + auto-resume / auto-restart child job creation
- `createApprovalRequest()` — applies auto-approve based on `permission_mode`
- `respondToApproval()` — marks decision, updates agent status
- `createJob()` / `archiveJob()` / `removeJob()` / `restartJob()`
- `createEnrollment()` / `consumeEnrollment()` / `revokeEnrollment()`
- `getOverview()` — aggregate for dashboard overview page
- `createReconnectEnrollment()` — generates new pairing code for existing agent
- Provider derived from `command[1]` (`claude`/`codex`/`other`), never from agent `tool_type`

### packages/relay/src/server.ts
HTTP + WebSocket server. Routes:
- `/v1/daemon/*` — pi-agent calls (daemon token auth). Writes relay DB directly.
- `/v1/pi/*` — dashboard calls (pi token auth). Reads/writes relay DB.
- `/api/remote-agents/enrollments/consume` — no-auth compat alias for backward-compatible `pi-agent pair`
- `/ws` — general relay WebSocket (job dispatch, approval decisions, presence)
- `/pi-agent-relay` — terminal relay WebSocket (proxies between pi-agent and dashboard)
- `/health` — status + DB agent count

### packages/web/src/lib/backend.ts
Mode switch. `isCloudMode()` returns true when both `PI_RELAY_BASE_URL` and `PI_RELAY_PI_TOKEN` are set. `getRemoteAgentsBackend()` returns async dynamic import of either `relay-cloud-client` (cloud) or `remote-agents` (local).

### packages/web/src/lib/relay-cloud-client.ts
HTTP client for all `/v1/pi/*` relay routes. Returns same TypeScript shapes as `remote-agents.ts`. Dashboard API routes use `getRemoteAgentsBackend()` to transparently switch between this and the local store.

### packages/web/src/middleware.ts
Auth middleware. Protects all routes except `/login`, `/api/auth/*`, `/_next/*`, and `/api/remote-agents/*` (daemon routes — pi-agent doesn't send session cookies). If `PI_ACCESS_TOKEN` is not set, middleware is a no-op (open access, dev mode).

### packages/web/server/direct-terminal-ws.ts
WebSocket server for terminal. On startup, calls `buildTerminalRelay()`:
- If `PI_RELAY_BASE_URL` + `PI_RELAY_PI_TOKEN` set → creates `RelayTerminalSubscriber` (outbound WS to relay)
- Otherwise → creates `RemoteTerminalRelay` (inbound WS server on port 14801)

### packages/web/server/mux-websocket.ts
Browser-facing terminal mux. Handles local tmux sessions and remote sessions via relay. Key fix: `tmux set-option mouse off` for PI sessions — `mouse on` caused drag events to route to PTY instead of xterm.js selection engine, making text selection disappear on mouseup.

### Terminal data flow (cloud mode)
```
browser xterm.js
  ↕ WS /mux (port 14801)
mux-websocket.ts
  ↕ RelayTerminalSubscriber (outbound WS)
PI Relay /pi-agent-relay
  ↕ TerminalRelayClient (pi-agent, outbound WS)
pi-agent terminal_relay.py
  ↕ PTY (tmux attach-session)
Claude Code / Codex process
```

### pi-agent pairing flow
1. Dashboard creates enrollment code (stored in relay DB or local store)
2. Dashboard shows: `pi-agent pair --server https://<relay-host> --code XXXX --start`
3. pi-agent calls `POST {server}/api/remote-agents/enrollments/consume`
4. Relay serves this at the compat alias (no auth required)
5. Response includes `config.relayUrl` + `config.relayToken`
6. pi-agent stores relay config in state file
7. Daemon loop uses relay for all subsequent heartbeats/reports/polling

---

## 5. Current Known-Good Behavior

- **Local mode:** overview, heartbeat, poll, job creation, approval flow all work end-to-end
- **Cloud relay routes:** smoke-tested locally — register, heartbeat, poll, enrollment create + consume alias, overview all pass
- **pi-agent pairing compat:** `POST /api/remote-agents/enrollments/consume` no-auth alias confirmed working on relay
- **Provider-agnostic machines:** `tool_type` is nullable on agents, never used for routing; `provider` lives on jobs
- **Claude default model:** `PI_CLAUDE_DEFAULT_MODEL` env var is respected when launching Claude Code sessions; shell aliases are never relied on (subprocess doesn't expand them)
- **Terminal selection:** works because `tmux mouse` is set to `off` for PI sessions — xterm.js drag events reach the selection engine
- **Terminal UTF-8:** `StringDecoder` streaming decoder prevents mojibake at PTY read boundaries
- **Auth:** `PI_ACCESS_TOKEN` middleware protects all routes except daemon API and login page
- **Light theme:** `defaultTheme="light"` globally; terminal section stays dark intentionally

---

## 6. Known Issues and Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| **E2EE not implemented** | Medium | Payload fields are stored opaque — schema is ready. Needs key exchange design. |
| **No real login/accounts** | Medium | `PI_ACCESS_TOKEN` is a single shared token. Fine for personal use; must replace before multi-user. |
| **SQLite single-instance** | Low | Acceptable for MVP. WAL mode handles concurrency. Future: Postgres (only `db.ts` + `store.ts` change). |
| **Auto-resume in relay is basic** | Low | Port of core auto-resume logic done. Edge cases (exact retry-at parsing, Ralph mode continuation) are simplified vs dashboard version. Test with real Claude usage-limit sessions. |
| **Cloud mode needs real deployment** | High | Only smoke-tested with local relay. Full end-to-end test (pi-agent on remote machine → public relay → dashboard) not yet done. |
| **Terminal on cloud relay untested** | Medium | `RelayTerminalSubscriber` + relay `/pi-agent-relay` proxying not yet tested with a real remote pi-agent. |
| **Restart/continue job** | Low | Relay's `restartJob()` is a simplified version — creates a new queued job. Full Codex session resume logic (find matching session in history) is only in local `restartRemoteCodexJob()`. |
| **Do not add `tool_type` routing** | Critical | Machine identity must stay provider-agnostic. `tool_type` is legacy/opaque only. Adding provider logic to agents would break the architecture. |

---

## 7. Environment Variables

### packages/web (.env.local)

| Variable | Required | Description |
|----------|----------|-------------|
| `PI_ACCESS_TOKEN` | Optional | Dashboard auth token. If unset, auth is disabled (dev mode). |
| `PI_RELAY_BASE_URL` | Cloud mode | Relay HTTP base URL, e.g. `https://pi-relay.fly.dev`. Activates cloud mode when set with `PI_RELAY_PI_TOKEN`. |
| `PI_RELAY_PI_TOKEN` | Cloud mode | Bearer token for dashboard → relay `/v1/pi/*` calls. Must match a `kind=pi` token in relay's `PI_RELAY_TOKENS`. |
| `PI_RELAY_DAEMON_TOKEN` | Cloud mode | Daemon token embedded in generated pairing commands. Must match a `kind=daemon` token in relay's `PI_RELAY_TOKENS`. |
| `PI_RELAY_PUBLIC_WS_URL` | Cloud mode | Public WS URL baked into enrollment codes, e.g. `wss://pi-relay.fly.dev`. Used to generate terminal relay URL for pair commands. |
| `PI_CLAUDE_DEFAULT_MODEL` | Optional | Default Claude model for new sessions, e.g. `claude-sonnet-4-5`. Overrides built-in default. Never rely on shell aliases. |
| `PI_PUBLIC_URL` | Optional | Public HTTP URL of dashboard, used in local-mode pair commands, e.g. `http://192.168.1.83:3000`. |
| `DIRECT_TERMINAL_PORT` | Optional | Port for terminal WebSocket server (default `14801`). |

### packages/relay (fly secrets or local env)

| Variable | Required | Description |
|----------|----------|-------------|
| `PI_RELAY_TOKENS` | Yes | Comma-separated auth tokens: `token:kind:label`, e.g. `daemon-abc:daemon,pi-xyz:pi`. |
| `PI_RELAY_OWNER_TOKEN` | Yes | Bearer token for default owner row bootstrap. Used to authenticate the dashboard's `/v1/pi/*` calls at the relay level. |
| `PI_RELAY_DB_PATH` | Optional | SQLite file path (default `./pi-relay.db`). On Fly.io: `/data/pi-relay.db`. |
| `PI_RELAY_PORT` | Optional | HTTP listen port (default `8787`). |
| `PI_RELAY_HOST` | Optional | Bind host (default `0.0.0.0`). |

---

## 8. How to Run Locally

### Dashboard + terminal WS (local mode)
```bash
cd packages/web

# Install deps (first time)
npx pnpm install

# Start Next.js + terminal WS concurrently
npx --no concurrently "next dev --turbopack" "tsx watch server/direct-terminal-ws.ts"

# Or via workspace script:
# npm run dev  (if pnpm is in PATH)
```

Dashboard: `http://localhost:3000`  
Terminal WS: `ws://localhost:14801`

### Relay server (cloud mode testing)
```bash
cd packages/relay

# Build
npx pnpm run build  # or: /path/to/tsc -p tsconfig.json

# Run with test tokens
PI_RELAY_PORT=8788 \
PI_RELAY_TOKENS="daemon-test:daemon,pi-test:pi" \
PI_RELAY_OWNER_TOKEN="pi-test" \
PI_RELAY_DB_PATH=/tmp/pi-test.db \
node dist/index.js
```

### Dashboard in cloud mode (pointing at local relay)
```bash
# packages/web/.env.local
PI_RELAY_BASE_URL=http://localhost:8788
PI_RELAY_PI_TOKEN=pi-test
PI_RELAY_DAEMON_TOKEN=daemon-test
```

### pi-agent (on same or remote machine)
```bash
pip install pi-agent  # or: pip install -e bridges/pi-agent

# Pair with local dashboard
pi-agent pair --server http://192.168.x.x:3000 --code XXXX --start

# Pair with cloud relay
pi-agent pair --server https://pi-relay.fly.dev --code XXXX --start
```

### Windows/WSL port-forward (LAN access to WSL dashboard)
When dashboard runs in WSL and pi-agent is on Windows or another LAN device:
```powershell
# In PowerShell (admin) — forward LAN port 3000 to WSL
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$(wsl hostname -I)
netsh interface portproxy add v4tov4 listenport=14801 listenaddress=0.0.0.0 connectport=14801 connectaddress=$(wsl hostname -I)
```

---

## 9. Smoke Tests

### Local mode
```bash
# Overview (should return agents + jobs)
curl -s http://localhost:3000/api/remote-agents/overview | python3 -c "import sys,json; d=json.load(sys.stdin); print('agents:', d['stats']['agents'], 'running:', d['stats']['running'])"

# Terminal WS health
curl -s http://localhost:14801/health
```

### Cloud relay
```bash
RELAY=http://localhost:8788
DAEMON_TOKEN=daemon-test
PI_TOKEN=pi-test

# Health
curl -s $RELAY/health

# Register agent (daemon)
curl -s -X POST $RELAY/v1/daemon/register \
  -H "Authorization: Bearer $DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Test Box","projectLabel":"test","hostLabel":"testhost"}'

# Overview (pi)
curl -s $RELAY/v1/pi/overview -H "Authorization: Bearer $PI_TOKEN"

# Create enrollment + consume via compat alias
CODE=$(curl -s -X POST $RELAY/v1/pi/enrollments \
  -H "Authorization: Bearer $PI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Dev Box","projectLabel":"dev"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['enrollment']['code'])")

curl -s -X POST $RELAY/api/remote-agents/enrollments/consume \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok:', 'config' in d)"
```

### Terminal selection (manual)
1. Open a remote session detail page
2. Start a Claude Code or Codex session
3. Wait for terminal output
4. Drag-select text — highlight must **persist** after mouseup
5. Press `Ctrl+C` — selected text copies to clipboard (does NOT send SIGINT when selection active)
6. Right-click → Copy or Paste also works

If selection disappears on mouseup: check that `tmux set-option mouse off` is applied for the session. `mouse on` routes drag events to PTY, breaking xterm.js selection.

### Claude default model (manual)
1. In `.env.local` set `PI_CLAUDE_DEFAULT_MODEL=claude-sonnet-4-5` (or desired model)
2. Create a new remote session without specifying a model in the UI
3. Check the launched command in the session detail — it should include `--model claude-sonnet-4-5`
4. Confirm the AMD gateway or chosen gateway accepts the model

---

## 10. Next Recommended Work

### Immediate (before broader use)
1. **Deploy relay to a public host** (Fly.io preferred — `fly.toml` is already set up). Create the persistent volume before first deploy.
2. **End-to-end cloud mode test** — real pi-agent on a remote machine → public relay → dashboard. Terminal stream, approval flow, job lifecycle.
3. **Fix pair command generation in cloud mode** — `remote-agents.ts` `createReconnectEnrollment()` generates pair commands pointing to `PI_PUBLIC_URL`. In cloud mode, this should point to the relay URL instead. Currently dashboard in cloud mode generates locally-stored enrollments but pair command may use wrong server origin.

### Short-term
4. **Real account/login system** — replace `PI_ACCESS_TOKEN` with GitHub OAuth or invite-based accounts (see `ROADMAP.md`). NextAuth.js is the recommended path.
5. **Move auto-resume business logic to relay** — currently ported as a simplified version. Full logic (usage-limit time parsing, Ralph mode iterations, Codex session history matching for restart) should eventually live in `store.ts` for cloud-mode completeness.
6. **Mobile-optimized dashboard** — current UI is web-responsive but not mobile-native. Expo app is the long-term target.

### Long-term
7. **E2EE layer** — Phase 2. Dashboard generates session keypair on pairing; all terminal frames and approval payloads encrypted before leaving the client. Relay routes ciphertext only. DB schema already has opaque payload fields — add `payload_encrypted`, `key_id`, `nonce`, `encryption_version` columns via non-destructive `ALTER TABLE ADD COLUMN`.
8. **Postgres migration** — only `packages/relay/src/db.ts` and the query layer in `store.ts` need updating. API surface unchanged.
9. **Push notifications** — mobile push for approval requests and session state changes.

---

## 11. Do-Not-Do Warnings

| Warning | Why |
|---------|-----|
| **Do not make the relay call back to a local LAN dashboard URL** | `PI_RELAY_PI_BASE_URL` was the old anti-pattern and has been removed. Relay owns DB state in cloud mode. |
| **Do not make machine identity provider-specific** | `tool_type` on agents is legacy/opaque. Provider lives on `jobs.provider`. Adding provider routing to agents breaks multi-provider agents. |
| **Do not use bash shell aliases for Claude model selection** | `subprocess.Popen` does not expand shell aliases. Always use `PI_CLAUDE_DEFAULT_MODEL` env var or explicit `--model` flag. |
| **Do not enable `tmux mouse on` for PI terminal sessions** | With mouse mode on, xterm.js drag events route to the PTY instead of the selection engine — text selection disappears on mouseup. Keep `mouse off` unless the xterm.js selection UX is completely redesigned. |
| **Do not stage `dist/`, `.next/`, `*.db`, `node_modules/`** | Never commit generated or runtime artifacts. |
| **Do not push without `PI_RELAY_PI_BASE_URL` confirmed removed** | Grep for it before any relay-related PR. It must appear only in docs as a deprecation notice. |
| **Do not use Claude `PreToolUse` hooks as blocking approval gates by default** | Causes agent deadlock if the hook script exits non-zero. Use the pi-agent approval request flow instead. |
| **Do not deploy relay without a persistent volume on Fly.io** | Fly's filesystem is ephemeral. The SQLite DB is wiped on every deploy without a mounted volume. Always create `pi_relay_data` before first deploy. |

---

## 12. Repo Structure Quick Reference

```
Project_Interface/
├── bridges/
│   └── pi-agent/               Python bridge daemon
│       └── src/pi_agent/
│           ├── cli.py           Main daemon + all subcommands
│           └── terminal_relay.py  TerminalRelayClient (WS to /pi-agent-relay)
├── docs/
│   ├── HANDOFF.md               This file
│   ├── cloud-control-plane.md   Local vs cloud setup guide
│   ├── AGENT_LAUNCH.md          How agents launch sessions
│   └── ROADMAP.md               Product roadmap
├── packages/
│   ├── core/                    Shared TypeScript types
│   ├── relay/                   PI Cloud relay / control plane
│   │   ├── src/
│   │   │   ├── db.ts            SQLite init + schema
│   │   │   ├── store.ts         All DB operations
│   │   │   ├── server.ts        HTTP + WS server
│   │   │   ├── auth.ts          Token auth
│   │   │   └── routing.ts       RelayRegistry (WS peer routing)
│   │   ├── Dockerfile
│   │   └── fly.toml
│   └── web/                     Next.js dashboard
│       ├── src/
│       │   ├── app/             Next.js App Router pages + API routes
│       │   │   ├── api/remote-agents/   All agent/session/approval APIs
│       │   │   └── login/       Login page
│       │   ├── components/
│       │   │   ├── PIAgentsEntry.tsx     Machines page
│       │   │   ├── PIRemoteSessionDetail.tsx  Session detail + terminal
│       │   │   ├── PISessionCreator.tsx  New session form
│       │   │   └── DirectTerminal.tsx   xterm.js terminal component
│       │   └── lib/
│       │       ├── backend.ts           Mode switch (local/cloud)
│       │       ├── relay-cloud-client.ts  /v1/pi/* HTTP client
│       │       ├── relay-dispatch.ts    Local mode relay dispatch
│       │       └── remote-agents.ts     Local store (data/store.json)
│       ├── server/
│       │   ├── direct-terminal-ws.ts    Terminal WS server
│       │   ├── mux-websocket.ts         Browser terminal mux
│       │   ├── remote-terminal-relay.ts Inbound pi-agent relay (local mode)
│       │   └── relay-terminal-subscriber.ts  Outbound relay WS (cloud mode)
│       └── data/                Local store (gitignored in production)
└── package.json                 pnpm workspace root
```
