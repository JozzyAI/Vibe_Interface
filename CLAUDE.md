# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

### Starting the dashboard (WSL2)
```bash
VI_ROOT=/mnt/c/Users/lijoe/Desktop/codes/Project_Interface \
VI_NODE_BIN=/home/lijoe/.nvm/versions/node/v24.13.0/bin \
bash scripts/dev-wsl.sh
```
Starts two tmux sessions:
- `vi-next` — Next.js on :3000
- `vi-direct-terminal` — terminal WebSocket server on :14801

Check logs: `tmux capture-pane -t vi-next -p | tail -20`

### Build
```bash
pnpm install                      # workspace install + symlinks @vi/* packages
cd packages/core && pnpm build    # must build core before web
pnpm --filter @vi/web dev         # dev mode (picks up .env.local)
pnpm --filter @vi/web build       # production build
```

`@vi/core` must be rebuilt after any changes to `packages/core/src/` — Next.js reads `dist/`, not `src/`.

### WSL2 → LAN access
Run once in Windows Admin PowerShell (replace `<WSL2_IP>` with output of `hostname -I`):
```powershell
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL2_IP>
netsh interface portproxy add v4tov4 listenport=14801 listenaddress=0.0.0.0 connectport=14801 connectaddress=<WSL2_IP>
```

### GCP relay
```bash
gcloud compute ssh vi-relay --project=dynastylab-pi --zone=us-central1-a
sudo cat /etc/vi-relay.env        # tokens + config
sudo systemctl status vi-relay    # relay service state
```

## Architecture

### Monorepo packages
| Package | Name | Role |
|---------|------|------|
| `packages/core` | `@vi/core` | Shared types + local session store. Exports `VISession`, `VISessionState`, `deriveVISessionState()`, `listVISessions()`, path helpers. |
| `packages/relay` | `@vi/relay` | Cloud relay server (runs on GCP). Handles agent registration, job dispatch, approval relay, terminal WS proxy. |
| `packages/web` | `@vi/web` | Next.js 15 / React 19 dashboard + standalone terminal WS server. |

### Two runtime modes
Controlled by `packages/web/.env.local`:
- **Local mode** (default): reads/writes `~/.pi/pi-remote-agents/state.json` via `remote-agents.ts`
- **Cloud mode**: set `VI_RELAY_BASE_URL` + `VI_RELAY_VI_TOKEN` → calls `https://relay.dynastylab.ai/v1/vi/*` via `relay-cloud-client.ts`

The switch is in `src/lib/backend.ts` → `getRemoteAgentsBackend()`. All API routes use this; neither UI nor routes need mode-specific logic. Both backends export identical function signatures.

### Key files
- `src/lib/backend.ts` — `isCloudMode()`, `getRemoteAgentsBackend()` — the single mode-switch point
- `src/lib/relay-cloud-client.ts` — HTTP client for all relay `/v1/vi/*` routes (future `@vi/client-sdk` core)
- `src/lib/remote-agents.ts` — local JSON backend with same exported interface
- `src/lib/services.ts` — session manager + project config loaded from env vars
- `server/direct-terminal-ws.ts` — standalone WS server for local terminal relay (port 14801)

### Relay API
- Dashboard auth: `Authorization: Bearer <VI_RELAY_VI_TOKEN>` on `/v1/vi/*`
- Agent auth: daemon token on `/v1/daemon/*`
- Terminal streaming: WebSocket at `wss://relay.dynastylab.ai/vi-agent-relay`
- Token format in `VI_RELAY_TOKENS` env var: `token:kind:label,...` (kind = `vi` or `daemon`)

### Data locations
- Local sessions: `~/.pi/sessions/` (one JSON per session, managed by `@vi/core`)
- Cloud agent state: relay SQLite at `/data/vi-relay.db` on GCP VM
- Local agent state: `~/.pi/pi-remote-agents/state.json`
- Workspace files: `~/pi-workspace/` or `$VI_WORKSPACE_ROOT`

## Roadmap

The planned evolution is: **current web app → shared `@vi/client-sdk` → Tauri desktop + Expo mobile**.

- **Phase 1:** Extract `packages/client-sdk` (`@vi/client-sdk`) from `relay-cloud-client.ts` — a `VIRelayClient` class taking config as constructor args, usable outside Next.js
- **Phase 2:** Refactor web to use client-sdk directly (bypass API route proxies in cloud mode)
- **Phase 3:** `apps/desktop` — Tauri app wrapping existing React UI
- **Phase 4:** `apps/mobile` — Expo React Native app (approval hub first, terminal via WebView)
