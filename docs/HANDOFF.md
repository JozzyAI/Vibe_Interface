# VI Project Handoff

**Date:** 2026-05-18  
**Repo:** `JozzyAI/Project_Interface`  
**Branch:** `main`  
**Phase 1 status: COMPLETE — Fly relay live, E2E verified, tokens rotated**

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
| **VI Dashboard** | Client app (web, desktop, mobile). Shows machines, sessions, approvals. Connects outbound to VI Cloud. |
| **VI Cloud / Relay** | Account layer + control plane + relay. Owns state in production. Routes messages between dashboard clients and vi-agents. |
| **vi-agent** | Execution runtime. Runs on any machine. Launches Claude/Codex/tmux. Reports status, streams terminal, receives commands. Connects outbound only. |

### Long-term security goal

End-to-end encrypted terminal and session payloads — similar to Telegram Secret Chats:
- Dashboard client encrypts locally → VI Cloud forwards ciphertext → vi-agent decrypts
- VI Cloud relay sees only routing metadata, not session contents
- **Not implemented yet.** DB schema and API payloads are stored opaque to support this later without breaking changes.

---

## 2. Architecture Modes

### Mode 1: Local / Same-Wi-Fi (default, no relay config)

```
vi-agent  ──→  dashboard (Next.js :3000)  ←──  browser
               └── data/store.json (source of truth)
terminal  ──→  dashboard (WS :14801)
```

- `packages/web` Next.js server serves both the UI and the backend API
- State stored in `packages/web/data/store.json`
- vi-agent and browser must be on the same network as dashboard
- No relay required
- **Activate:** do NOT set `VI_RELAY_BASE_URL` / `VI_RELAY_VI_TOKEN`

### Mode 2: Cloud Control Plane

```
vi-agent  ──→  VI Relay (:8787)  ←──  dashboard client (browser)
                 └── SQLite (VI_RELAY_DB_PATH)
terminal  ──→  VI Relay (/vi-agent-relay)  ←──  dashboard relay subscriber
```

- `packages/relay` owns all state in SQLite
- vi-agent talks to relay directly — dashboard is NOT in the heartbeat/report loop
- Dashboard reads/writes relay via `/v1/vi/*` REST routes
- **`VI_RELAY_VI_BASE_URL` is fully removed.** The relay never calls back to a local dashboard URL.
- **Activate:** set `VI_RELAY_BASE_URL` + `VI_RELAY_VI_TOKEN` in dashboard env

---

## 3. Recent Major Changes (most recent first)

| Commit | Change |
|--------|--------|
| `48b39f7` | **Dockerfile fix** — builder installs python3/make/g++ and runs `npm install` (no `--ignore-scripts`) so better-sqlite3 native addon compiles; runner copies node_modules from builder |
| `7a373cd` | **Fly.io deployment** — relay live at `https://vi-relay-jozzy.fly.dev`; `fly.toml` with `auto_stop_machines=true`, shared-cpu-1x 256 MB, 1 GB volume in `sin`; no dedicated IPv4; cost-minimised |
| `63fd35d` | **Relay-backed cloud control plane** — SQLite DB in `packages/relay`, `/v1/daemon/*` and `/v1/vi/*` routes, dashboard backend switch, enrollment consume compat alias |
| `aa62bd1` | Relay terminal proxy (`/vi-agent-relay` on relay server), `RelayTerminalSubscriber` in dashboard, Dockerfile + fly.toml |
| `e263590` | Token-based auth — `VI_ACCESS_TOKEN` middleware, login page at `/login`, session cookie, logout button |
| `658ceb1` | Session action menu in Active Remote Sessions list (kebab menu: open, archive, delete with confirm) |
| `0679059` | Global light theme — `defaultTheme="light"` in ThemeProvider, fixed dark hardcoded colors |
| `e8e979a` | Terminal copy/paste hint + New Session UI cleanup |
| `b29fa4f` | Terminal selection fix — root cause: `tmux set-option mouse on` intercepts drag events; fixed to `mouse off` |
| `516fbf6` | Terminal UTF-8 fix — `StringDecoder` streaming decoder for base64 PTY bytes, eliminates mojibake |
| `28a1e82` | Claude default model — uses `VI_CLAUDE_DEFAULT_MODEL` env var instead of shell aliases (subprocess doesn't expand aliases) |

---

## 4. Key Files and Implementation Details

### packages/relay/src/db.ts
SQLite initialization. Loads `better-sqlite3` via `createRequire` (CommonJS in ESM context). Enables WAL mode + `foreign_keys = ON` + `busy_timeout = 5000`. Creates all tables on startup. Bootstraps default owner row from `VI_RELAY_OWNER_TOKEN`. DB path from `VI_RELAY_DB_PATH` env var (default `./vi-relay.db`).

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
- `/v1/daemon/*` — vi-agent calls (daemon token auth). Writes relay DB directly.
- `/v1/vi/*` — dashboard calls (vi token auth). Reads/writes relay DB.
- `/api/remote-agents/enrollments/consume` — no-auth compat alias for backward-compatible `vi-agent pair`
- `/ws` — general relay WebSocket (job dispatch, approval decisions, presence)
- `/vi-agent-relay` — terminal relay WebSocket (proxies between vi-agent and dashboard)
- `/health` — status + DB agent count

### packages/web/src/lib/backend.ts
Mode switch. `isCloudMode()` returns true when both `VI_RELAY_BASE_URL` and `VI_RELAY_VI_TOKEN` are set. `getRemoteAgentsBackend()` returns async dynamic import of either `relay-cloud-client` (cloud) or `remote-agents` (local).

### packages/web/src/lib/relay-cloud-client.ts
HTTP client for all `/v1/vi/*` relay routes. Returns same TypeScript shapes as `remote-agents.ts`. Dashboard API routes use `getRemoteAgentsBackend()` to transparently switch between this and the local store.

### packages/web/src/middleware.ts
Auth middleware. Protects all routes except `/login`, `/api/auth/*`, `/_next/*`, and `/api/remote-agents/*` (daemon routes — vi-agent doesn't send session cookies). If `VI_ACCESS_TOKEN` is not set, middleware is a no-op (open access, dev mode).

### packages/web/server/direct-terminal-ws.ts
WebSocket server for terminal. On startup, calls `buildTerminalRelay()`:
- If `VI_RELAY_BASE_URL` + `VI_RELAY_VI_TOKEN` set → creates `RelayTerminalSubscriber` (outbound WS to relay)
- Otherwise → creates `RemoteTerminalRelay` (inbound WS server on port 14801)

### packages/web/server/mux-websocket.ts
Browser-facing terminal mux. Handles local tmux sessions and remote sessions via relay. Key fix: `tmux set-option mouse off` for VI sessions — `mouse on` caused drag events to route to PTY instead of xterm.js selection engine, making text selection disappear on mouseup.

### Terminal data flow (cloud mode)
```
browser xterm.js
  ↕ WS /mux (port 14801)
mux-websocket.ts
  ↕ RelayTerminalSubscriber (outbound WS)
VI Relay /vi-agent-relay
  ↕ TerminalRelayClient (vi-agent, outbound WS)
vi-agent terminal_relay.py
  ↕ PTY (tmux attach-session)
Claude Code / Codex process
```

### vi-agent pairing flow
1. Dashboard creates enrollment code (stored in relay DB or local store)
2. Dashboard shows: `vi-agent pair --server https://<relay-host> --code XXXX --start`
3. vi-agent calls `POST {server}/api/remote-agents/enrollments/consume`
4. Relay serves this at the compat alias (no auth required)
5. Response includes `config.relayUrl` + `config.relayToken`
6. vi-agent stores relay config in state file
7. Daemon loop uses relay for all subsequent heartbeats/reports/polling

---

## 5. Current Known-Good Behavior

### Phase 1 E2E verified (2026-05-18) — public Fly relay + token rotation

- **Fly relay live:** `https://vi-relay-jozzy.fly.dev` — `/health` → `{"status":"ok"}`, HTTPS + HTTP→HTTPS redirect, 1/1 health checks passing
- **Auth:** no token → 401, old (rotated-away) token → 401, new vi token → 200 on `/presence`
- **Dashboard cloud mode:** `VI_RELAY_BASE_URL` + `VI_RELAY_VI_TOKEN` set in `.env.local`; overview `generatedAt` field confirms relay SQLite as source of truth
- **Enrollment pair command:** correctly uses `https://vi-relay-jozzy.fly.dev --server` in cloud mode
- **vi-agent pairing:** `pair → start-daemon` connects to `wss://vi-relay-jozzy.fly.dev/vi-agent-relay`; `terminal_relay_connected` confirmed
- **Agent online:** status `running`, visible in dashboard overview from relay
- **Claude session:** job dispatched via relay (`relayDispatch.delivered: true`), vi-agent starts tmux session
- **Browser terminal echo:** `/mux` WebSocket → `RelayTerminalSubscriber` → Fly relay → vi-agent → tmux → back; `echo hello` received through full chain
- **Token rotation:** old daemon/vi tokens replaced without code changes; existing agents must re-pair after rotation
- **Local mode:** overview, heartbeat, poll, job creation, approval flow all work end-to-end (unchanged)
- **vi-agent pairing compat:** `POST /api/remote-agents/enrollments/consume` no-auth alias confirmed working on relay
- **Provider-agnostic machines:** `tool_type` is nullable on agents, never used for routing; `provider` lives on jobs
- **Claude default model:** `VI_CLAUDE_DEFAULT_MODEL` env var is respected when launching Claude Code sessions
- **Terminal selection:** drag-select persists after mouseup; `Ctrl+C` copies (not SIGINT) when selection active
- **Terminal UTF-8:** `StringDecoder` streaming decoder prevents mojibake at PTY read boundaries
- **Auth:** `VI_ACCESS_TOKEN` middleware protects all routes except daemon API and login page
- **Light theme:** `defaultTheme="light"` globally; terminal section stays dark intentionally

---

## 6. Known Issues and Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| **E2EE not implemented** | Medium | Payload fields are stored opaque — schema is ready. Needs key exchange design. Not in scope for Phase 2. |
| **No real login/accounts** | Medium | `VI_ACCESS_TOKEN` is a single shared token. Fine for personal use; must replace before multi-user. |
| **SQLite single-instance** | Low | Acceptable for MVP. WAL mode handles concurrency. Future: Postgres (only `db.ts` + `store.ts` change). |
| **No relay mode indicator in UI** | Low | Dashboard doesn't show whether it's in Local or Cloud mode. User must infer from config. Next: add mode badge to header. |
| **Auto-resume in relay is basic** | Low | Port of core auto-resume logic done. Edge cases (exact retry-at parsing, Ralph mode continuation) are simplified vs dashboard version. Test with real Claude usage-limit sessions. |
| **Restart/continue job** | Low | Relay's `restartJob()` is a simplified version — creates a new queued job. Full Codex session resume logic (find matching session in history) is only in local `restartRemoteCodexJob()`. |
| **No enrollment rate limit** | Low | `/api/remote-agents/enrollments/consume` (no-auth alias) has no rate limit. Low risk for personal use. Add before broader deployment. |
| **Do not add `tool_type` routing** | Critical | Machine identity must stay provider-agnostic. `tool_type` is legacy/opaque only. Adding provider logic to agents would break the architecture. |

---

## 7. Environment Variables

### packages/web (.env.local)

| Variable | Required | Description |
|----------|----------|-------------|
| `VI_ACCESS_TOKEN` | Optional | Dashboard auth token. If unset, auth is disabled (dev mode). |
| `VI_RELAY_BASE_URL` | Cloud mode | Relay HTTP base URL, e.g. `https://vi-relay.fly.dev`. Activates cloud mode when set with `VI_RELAY_VI_TOKEN`. |
| `VI_RELAY_VI_TOKEN` | Cloud mode | Bearer token for dashboard → relay `/v1/vi/*` calls. Must match a `kind=vi` token in relay's `VI_RELAY_TOKENS`. |
| `VI_RELAY_DAEMON_TOKEN` | Cloud mode | Daemon token embedded in generated pairing commands. Must match a `kind=daemon` token in relay's `VI_RELAY_TOKENS`. |
| `VI_RELAY_PUBLIC_WS_URL` | Cloud mode | Public WS URL baked into enrollment codes, e.g. `wss://vi-relay.fly.dev`. Used to generate terminal relay URL for pair commands. |
| `VI_CLAUDE_DEFAULT_MODEL` | Optional | Default Claude model for new sessions, e.g. `claude-sonnet-4-5`. Overrides built-in default. Never rely on shell aliases. |
| `VI_PUBLIC_URL` | Optional | Public HTTP URL of dashboard, used in local-mode pair commands, e.g. `http://192.168.1.83:3000`. |
| `DIRECT_TERMINAL_PORT` | Optional | Port for terminal WebSocket server (default `14801`). |

### packages/relay (fly secrets or local env)

| Variable | Required | Description |
|----------|----------|-------------|
| `VI_RELAY_TOKENS` | Yes | Comma-separated auth tokens: `token:kind:label`, e.g. `daemon-abc:daemon,vi-xyz:vi`. |
| `VI_RELAY_OWNER_TOKEN` | Yes | Bearer token for default owner row bootstrap. Used to authenticate the dashboard's `/v1/vi/*` calls at the relay level. |
| `VI_RELAY_DB_PATH` | Optional | SQLite file path (default `./vi-relay.db`). On Fly.io: `/data/vi-relay.db`. |
| `VI_RELAY_PORT` | Optional | HTTP listen port (default `8787`). |
| `VI_RELAY_HOST` | Optional | Bind host (default `0.0.0.0`). |

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
VI_RELAY_PORT=8788 \
VI_RELAY_TOKENS="daemon-test:daemon,vi-test:vi" \
VI_RELAY_OWNER_TOKEN="vi-test" \
VI_RELAY_DB_PATH=/tmp/vi-test.db \
node dist/index.js
```

### Dashboard in cloud mode (pointing at local relay)
```bash
# packages/web/.env.local
VI_RELAY_BASE_URL=http://localhost:8788
VI_RELAY_VI_TOKEN=vi-test
VI_RELAY_DAEMON_TOKEN=daemon-test
```

### vi-agent (on same or remote machine)
```bash
pip install vi-agent  # or: pip install -e bridges/vi-agent

# Pair with local dashboard
vi-agent pair --server http://192.168.x.x:3000 --code XXXX --start

# Pair with cloud relay
vi-agent pair --server https://vi-relay.fly.dev --code XXXX --start
```

### Windows/WSL port-forward (LAN access to WSL dashboard)
When dashboard runs in WSL and vi-agent is on Windows or another LAN device:
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
VI_TOKEN=vi-test

# Health
curl -s $RELAY/health

# Register agent (daemon)
curl -s -X POST $RELAY/v1/daemon/register \
  -H "Authorization: Bearer $DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Test Box","projectLabel":"test","hostLabel":"testhost"}'

# Overview (pi)
curl -s $RELAY/v1/vi/overview -H "Authorization: Bearer $VI_TOKEN"

# Create enrollment + consume via compat alias
CODE=$(curl -s -X POST $RELAY/v1/vi/enrollments \
  -H "Authorization: Bearer $VI_TOKEN" \
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
1. In `.env.local` set `VI_CLAUDE_DEFAULT_MODEL=claude-sonnet-4-5` (or desired model)
2. Create a new remote session without specifying a model in the UI
3. Check the launched command in the session detail — it should include `--model claude-sonnet-4-5`
4. Confirm the AMD gateway or chosen gateway accepts the model

---

## 10. Next Recommended Work

### Phase 2: Cloud Mode Stabilization (current focus)

1. **Mode indicator in dashboard header** — show Local/Cloud badge + relay URL + connection status. User should not need to read `.env.local` to know which mode is active.
2. **Machine lifecycle hardening** — Reconnect / Forget / Remove / Restart daemon flows should be stable and tested in cloud mode. Currently working but not stress-tested.
3. **Session lifecycle dropdown** — Resume / Archive / Delete menu on session cards. Archive and delete work; resume needs better UX for cloud mode (agent may be sleeping).
4. **Cloud relay ops docs** — token rotation runbook, re-pair procedure, volume backup, troubleshooting guide. See `docs/cloud-control-plane.md`.
5. **Basic rate limit on enrollment consume** — `/api/remote-agents/enrollments/consume` (no-auth alias) should have IP-based rate limiting before broader deployment.

### Phase 3: Multi-user / Accounts (not yet)
- Replace `VI_ACCESS_TOKEN` with GitHub OAuth or invite-based accounts. NextAuth.js is the recommended path.
- Do not start this until Phase 2 stabilization is complete.

### Phase 4: E2EE (long-term)
- Dashboard generates session keypair on pairing; all terminal frames and approval payloads encrypted before leaving the client. Relay routes ciphertext only.
- DB schema already has opaque payload fields. Add `payload_encrypted`, `key_id`, `nonce`, `encryption_version` columns via non-destructive `ALTER TABLE ADD COLUMN`.

### Other long-term
- **Postgres migration** — only `db.ts` + `store.ts` need updating. API surface unchanged.
- **Push notifications** — mobile push for approval requests and session state changes.
- **Mobile-optimized dashboard** — current UI is web-responsive but not mobile-native. Expo app is the long-term target.

---

## 11. Do-Not-Do Warnings

| Warning | Why |
|---------|-----|
| **Do not commit `.env.local`** | Contains live relay tokens. It is gitignored — keep it that way. Never stage or force-add it. |
| **Do not print, paste, or log relay tokens** | Tokens in chat, terminal output, logs, or git diffs are considered exposed and must be rotated immediately. |
| **Do not use placeholder/example tokens in production** | Tokens like `daemon-abc123` or `vi-xyz789` are public in docs — anyone can try them. Always generate with `openssl rand -hex 32`. |
| **After rotating tokens, re-pair all vi-agents** | The daemon token is stored in the vi-agent state file at pairing time. Old agents will receive 401 on heartbeat after rotation. They are not auto-updated. |
| **Do not deploy relay without a persistent volume on Fly.io** | Fly's filesystem is ephemeral. The SQLite DB is wiped on every deploy without a mounted volume. Always create `vi_relay_data` before first deploy. Run `fly volumes list` to confirm before deploying. |
| **Do not make the relay call back to a local LAN dashboard URL** | `VI_RELAY_VI_BASE_URL` was the old anti-pattern and has been removed. Relay owns DB state in cloud mode. |
| **Do not make machine identity provider-specific** | `tool_type` on agents is legacy/opaque. Provider lives on `jobs.provider`. Adding provider routing to agents breaks multi-provider agents. |
| **Do not use bash shell aliases for Claude model selection** | `subprocess.Popen` does not expand shell aliases. Always use `VI_CLAUDE_DEFAULT_MODEL` env var or explicit `--model` flag. |
| **Do not enable `tmux mouse on` for VI terminal sessions** | With mouse mode on, xterm.js drag events route to the PTY instead of the selection engine — text selection disappears on mouseup. |
| **Do not stage `dist/`, `.next/`, `*.db`, `*.db-wal`, `*.db-shm`, `node_modules/`** | Never commit generated or runtime artifacts. |
| **Do not push without `VI_RELAY_VI_BASE_URL` confirmed removed** | Grep for it before any relay-related PR. It must appear only in docs as a deprecation notice. |
| **Do not use Claude `PreToolUse` hooks as blocking approval gates by default** | Causes agent deadlock if the hook script exits non-zero. Use the vi-agent approval request flow instead. |

---

## 13. Electron Desktop — Paused (WSLg rendering issue)

**Status:** `apps/desktop` scaffolded, builds, typechecks, and renderer DOM mounts correctly — but the visible WSLg window shows blank/white UI. Work paused pending WSLg restart.

### What was done
- `apps/desktop` created with `electron-vite` + React 19 + TypeScript
- IPC plumbing: `ipc.ts` / `store.ts` / `preload/index.ts` (contextBridge `window.electronAPI`)
- Renderer: `HashRouter` + `App.tsx` with Setup screen (relay URL + VI token) and main layout (sidebar nav, Machines / Sessions / Approvals tabs)
- Config persisted to `userData/vi-config.json` (plain JSON for MVP; TODO: OS keychain)
- WSL2 guard in `main/index.ts`: `disable-gpu` + `disable-software-rasterizer` switches applied when `WSL_DISTRO_NAME` or `WSL_INTEROP` is detected
- DevTools gated on `VI_DESKTOP_OPEN_DEVTOOLS=1` env var (unset by default) — opened `mode: "right"` (docked) to prevent focus theft

### Diagnostics confirmed working
These checks were run via `win.webContents.executeJavaScript()` and `BrowserWindow` API calls, and all passed:
- `win.isVisible()` → `true`
- `win.isFocused()` → `true`
- `document.title` → `"VI"`
- `document.getElementById("root")` contained full Setup screen DOM (relay URL input, VI token input, Save button, Clear button)
- No `did-fail-load` event fired
- No renderer crash — `did-finish-load` confirmed

### Root cause identified
The very first Electron launch in the session produced this log entry:

```
[FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.
```

This FATAL GPU crash corrupted WSLg's GPU/compositor state for the entire session. Subsequent launches show the correct DOM in diagnostics, but WSLg cannot paint pixels to the window surface — the window appears blank/white even though the renderer is fully loaded.

This is **not a code bug**. The renderer works; WSLg's compositor is stuck.

### Recovery steps
1. In Windows PowerShell: `wsl --shutdown`
2. Reopen WSL terminal
3. `cd /mnt/c/Users/lijoe/Desktop/codes/Project_Interface/apps/desktop && pnpm dev`
4. The Setup screen (Relay Base URL, VI Token, Save & Connect) should be visible and clickable

### Code guidelines for resuming
- Do **not** change `main/index.ts` further until after the WSLg restart confirms the existing code works
- Keep DevTools off by default — `VI_DESKTOP_OPEN_DEVTOOLS=1` must be set explicitly
- The `openDevTools({ mode: "detach" })` pattern steals renderer focus; always use `mode: "right"` (docked) if enabling DevTools programmatically
- `playwright-core` was added as a devDependency during an aborted Playwright driver attempt — remove it from `apps/desktop/package.json` before committing
- Root `tsconfig.json` was fixed: changed from `{ "extends": "expo/tsconfig.base" }` to `{ "compilerOptions": {} }` to silence `[WARNING] Cannot find base config file "expo/tsconfig.base"` on every `electron-vite` build
- Do **not** commit desktop changes until after successful WSLg restart verification

---

## 12. Repo Structure Quick Reference

```
Project_Interface/
├── bridges/
│   └── vi-agent/               Python bridge daemon
│       └── src/vi_agent/
│           ├── cli.py           Main daemon + all subcommands
│           └── terminal_relay.py  TerminalRelayClient (WS to /vi-agent-relay)
├── docs/
│   ├── HANDOFF.md               This file
│   ├── cloud-control-plane.md   Local vs cloud setup guide
│   ├── AGENT_LAUNCH.md          How agents launch sessions
│   └── ROADMAP.md               Product roadmap
├── packages/
│   ├── core/                    Shared TypeScript types
│   ├── relay/                   VI Cloud relay / control plane
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
│       │   │   ├── VIAgentsEntry.tsx     Machines page
│       │   │   ├── VIRemoteSessionDetail.tsx  Session detail + terminal
│       │   │   ├── VISessionCreator.tsx  New session form
│       │   │   └── DirectTerminal.tsx   xterm.js terminal component
│       │   └── lib/
│       │       ├── backend.ts           Mode switch (local/cloud)
│       │       ├── relay-cloud-client.ts  /v1/vi/* HTTP client
│       │       ├── relay-dispatch.ts    Local mode relay dispatch
│       │       └── remote-agents.ts     Local store (data/store.json)
│       ├── server/
│       │   ├── direct-terminal-ws.ts    Terminal WS server
│       │   ├── mux-websocket.ts         Browser terminal mux
│       │   ├── remote-terminal-relay.ts Inbound vi-agent relay (local mode)
│       │   └── relay-terminal-subscriber.ts  Outbound relay WS (cloud mode)
│       └── data/                Local store (gitignored in production)
└── package.json                 pnpm workspace root
```
