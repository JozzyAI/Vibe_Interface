# PI Dashboard — Agent Launch Guide

This document is written for AI agents. Follow it exactly to install and launch the PI dashboard. Every common failure mode is documented below.

---

## Repository Layout

```
/mnt/e/project/PI/
├── packages/web/          ← Next.js dashboard (all commands run from here)
│   ├── .env.local         ← env vars (PI_PUBLIC_URL, etc.)
│   ├── .next/             ← build cache (delete to force clean rebuild)
│   └── dist-server/       ← compiled server bundle (production only)
├── packages/core/         ← shared TypeScript core
├── bridges/pi-agent/      ← Python pi-agent client
└── ROADMAP.md
```

**All `npm` commands must be run from `/mnt/e/project/PI/packages/web/`.**

---

## Prerequisites

```bash
node --version   # must be >= 18
pnpm --version   # must be installed
tmux -V          # must be installed (used by terminal sessions)
```

Install dependencies from the repo root (only needed once or after pulling):

```bash
cd /mnt/e/project/PI
pnpm install
```

---

## Ports Used

| Port | Service | Notes |
|------|---------|-------|
| 3000 | Next.js (dashboard) | Main web UI |
| 14801 | Direct terminal WebSocket | Used by terminal panel |

**Always free both ports before starting:**

```bash
fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null
```

---

## Mode 1 — Production (recommended, fast)

Production mode serves pre-compiled assets. Pages respond in ~20ms vs ~600ms in dev.

### Step 1: Build

```bash
cd /mnt/e/project/PI/packages/web
npm run build
```

Build takes ~30–40 seconds. It runs `next build` then `tsc -p tsconfig.server.json`.
Both must succeed. If either fails, do not proceed to Step 2.

Expected ending output:
```
✓ Compiled successfully
Route (app) ...
○  (Static) ...
ƒ  (Dynamic) ...
```

### Step 2: Launch

```bash
cd /mnt/e/project/PI/packages/web
fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null
node dist-server/start-all.js
```

`dist-server/start-all.js` starts both Next.js and the terminal WebSocket server.
The working directory **must** be `packages/web/` — the script resolves paths relative to itself.

### Step 3: Verify

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# expects: 200
```

### Background launch (if needed)

```bash
cd /mnt/e/project/PI/packages/web
fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null
node dist-server/start-all.js > /tmp/pi-prod.log 2>&1 &
echo "PID: $!"
# wait for ready:
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null | grep -q 200; do sleep 1; done && echo "ready"
```

---

## Mode 2 — Development (hot reload, slow)

Use this only when actively editing code. Pages take ~600ms per request due to on-demand TypeScript compilation.

### Launch bound to localhost only

```bash
cd /mnt/e/project/PI/packages/web
fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null
npx --no concurrently "next dev --turbopack" "tsx watch server/direct-terminal-ws.ts" > /tmp/pi-dev.log 2>&1 &
```

### Launch bound to all interfaces (LAN access)

```bash
cd /mnt/e/project/PI/packages/web
fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null
npx --no concurrently "next dev --turbopack --hostname 0.0.0.0" "tsx watch server/direct-terminal-ws.ts" > /tmp/pi-dev.log 2>&1 &
```

**Do NOT use `npm run dev -- --hostname 0.0.0.0`** — the `--hostname` flag does not pass through `concurrently`. Use `npx --no concurrently` directly as shown above.

### Check dev logs

```bash
strings /tmp/pi-dev.log | grep -E "Local|Network|error|Error" | tail -10
```

---

## Env Vars (`.env.local`)

Located at `packages/web/.env.local`. Minimum required for LAN access:

```env
PI_PUBLIC_URL=http://<your-LAN-ip>:3000
```

Optional:
```env
DIRECT_TERMINAL_PORT=14801   # default, override if port conflicts
TERMINAL_WS_PATH=            # leave empty unless using a reverse proxy ws path
```

---

## Common Failures and Fixes

### Port already in use (EADDRINUSE)

```
Error: listen EADDRINUSE: address already in use :::3000
```

Fix:
```bash
fuser -k 3000/tcp 2>/dev/null
fuser -k 14801/tcp 2>/dev/null
```

### `dist-server/start-all.js` not found

```
Error: Cannot find module '/path/to/dist-server/start-all.js'
```

Cause: Either wrong working directory, or `npm run build` was not run.

Fix:
```bash
cd /mnt/e/project/PI/packages/web
npm run build
node dist-server/start-all.js   # must be run from packages/web/
```

### Pages feel slow (600ms+) in production

Cause: `.next/` cache is stale or corrupt, falling back to dev-mode behavior.

Fix:
```bash
rm -rf /mnt/e/project/PI/packages/web/.next
cd /mnt/e/project/PI/packages/web && npm run build
```

### `concurrently: command not found`

Do not call `concurrently` directly. Use:
```bash
npx --no concurrently "..." "..."
```

### `npm run dev -- --hostname 0.0.0.0` has no effect

`--hostname` must be passed directly to `next dev`, not through `npm run dev --`.
Use the `npx --no concurrently` form shown in Mode 2 above.

### Relay logs show `PI_RELAY_TOKENS not set`

```
[RelayServer] PI_RELAY_TOKENS not set — relay accepts any connection (dev mode only)
```

This is a security warning. In production add to `.env.local`:
```env
PI_RELAY_TOKENS=<random-token>
```

### Heartbeat/report API taking 500ms+

Cause: Multiple stale pi-agents still connecting. The 410 responses will stop them.
If it persists after 60 seconds, restart the server.

---

## Kill Everything

```bash
fuser -k 3000/tcp 2>/dev/null
fuser -k 14801/tcp 2>/dev/null
pkill -f "next" 2>/dev/null
pkill -f "direct-terminal-ws" 2>/dev/null
echo "all stopped"
```

---

## Quick Reference

| Task | Command (run from `packages/web/`) |
|------|-------------------------------------|
| Install deps | `cd /mnt/e/project/PI && pnpm install` |
| Build | `npm run build` |
| Start production | `node dist-server/start-all.js` |
| Start dev (localhost) | `npx --no concurrently "next dev --turbopack" "tsx watch server/direct-terminal-ws.ts"` |
| Start dev (LAN) | `npx --no concurrently "next dev --turbopack --hostname 0.0.0.0" "tsx watch server/direct-terminal-ws.ts"` |
| Clear build cache | `rm -rf .next` |
| Check if up | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` |
| Kill all | `fuser -k 3000/tcp 2>/dev/null; fuser -k 14801/tcp 2>/dev/null` |
| View prod logs | `tail -f /tmp/pi-prod.log` |
| View dev logs | `strings /tmp/pi-dev.log \| tail -20` |
