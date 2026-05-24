# VI Relay

The VI Cloud Control Plane. A lightweight Node.js server that stores agent state in SQLite and relays messages between the VI dashboard and remote vi-agents.

Both the dashboard and vi-agents connect outbound to the relay — neither side needs a public IP or open inbound port.

For the full setup guide and token rotation runbook see [docs/cloud-control-plane.md](../../docs/cloud-control-plane.md).

---

## Routes

| Path | Auth | Caller |
|------|------|--------|
| `POST /v1/daemon/register` | daemon token | vi-agent |
| `POST /v1/daemon/heartbeat` | daemon token | vi-agent |
| `GET /v1/daemon/agents/:id/poll` | daemon token | vi-agent |
| `POST /v1/daemon/jobs/report` | daemon token | vi-agent |
| `POST /v1/daemon/requests` | daemon token | vi-agent |
| `POST /api/remote-agents/enrollments/consume` | none (enrollment code) | vi-agent pair |
| `GET /v1/vi/overview` | vi token | dashboard |
| `POST /v1/vi/jobs` | vi token | dashboard |
| `POST /v1/vi/approvals/:id/respond` | vi token | dashboard |
| `POST /v1/vi/enrollments` | vi token | dashboard |
| `GET /health` | none | monitoring |
| `GET /presence` | vi token | dashboard |
| `WS /ws` | token | job dispatch, approvals |
| `WS /vi-agent-relay` | token | terminal stream |

---

## Deploy on Fly.io (recommended)

### Prerequisites

- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated
- A Fly account

### 1. Create the app

```bash
cd packages/relay
fly launch --no-deploy --name <your-app-name> --region sin
```

Or if the app already exists, just add the remote:

```bash
fly apps create <your-app-name>
```

### 2. Create a persistent volume (required before first deploy)

> Without this, the SQLite database lives on Fly's ephemeral filesystem and is **wiped on every deploy**.

```bash
fly volumes create vi_relay_data --size 1 --region sin --app <your-app-name>
```

Verify: `fly volumes list --app <your-app-name>`

### 3. Deploy

```bash
fly deploy --ha=false --app <your-app-name>
```

`--ha=false` creates one machine (no redundancy needed for personal use).

### 4. Set secrets

Generate tokens — do not use these placeholder values:

```bash
openssl rand -hex 32   # run once → DAEMON_TOKEN
openssl rand -hex 32   # run again → VI_TOKEN
```

Set them on Fly (replace placeholders with real values):

```bash
fly secrets set \
  VI_RELAY_TOKENS="<DAEMON_TOKEN>:daemon:local-daemon,<VI_TOKEN>:vi:local-vi" \
  VI_RELAY_OWNER_TOKEN="<VI_TOKEN>" \
  VI_RELAY_PUBLIC_WS_URL="wss://<your-app-name>.fly.dev" \
  --app <your-app-name>
```

Setting secrets triggers an automatic redeploy.

### 5. Verify

```bash
curl https://<your-app-name>.fly.dev/health
# → {"status":"ok"}

curl -s -o /dev/null -w "%{http_code}" https://<your-app-name>.fly.dev/presence
# → 401  (no token — expected)
```

---

## Run locally (dev/test)

```bash
cd packages/relay
npm install
npm run build

VI_RELAY_PORT=8788 \
VI_RELAY_TOKENS="daemon-test:daemon:dev,vi-test:vi:dev" \
VI_RELAY_OWNER_TOKEN="vi-test" \
VI_RELAY_DB_PATH=/tmp/vi-relay-dev.db \
node dist/index.js
```

Health check: `curl http://localhost:8788/health`

Point the dashboard at it:

```bash
# packages/web/.env.local  — local dev only, these tokens are not secret
VI_RELAY_BASE_URL=http://localhost:8788
VI_RELAY_VI_TOKEN=vi-test
VI_RELAY_DAEMON_TOKEN=daemon-test
VI_RELAY_PUBLIC_WS_URL=ws://localhost:8788
```

> These are short dev-only placeholder tokens for local testing. Use `openssl rand -hex 32` for production.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VI_RELAY_TOKENS` | Yes | `token:kind:label,...` — auth tokens. `kind` is `daemon` or `vi` |
| `VI_RELAY_OWNER_TOKEN` | Yes | Bootstrap token for default owner row (same value as VI_TOKEN) |
| `VI_RELAY_PUBLIC_WS_URL` | Yes | Public WebSocket URL baked into enrollment pair commands |
| `VI_RELAY_DB_PATH` | Optional | SQLite path (default `./vi-relay.db`; use `/data/vi-relay.db` on Fly) |
| `VI_RELAY_PORT` | Optional | HTTP listen port (default `8787`) |
| `VI_RELAY_HOST` | Optional | Bind host (default `0.0.0.0`) |

---

## Token format

`VI_RELAY_TOKENS` is a comma-separated list of `token:kind:label` entries:

```
<token1>:daemon:my-machine,<token2>:vi:dashboard
```

- `daemon` — used by vi-agent (heartbeat, register, report, enrollment consume)
- `pi` — used by the dashboard (overview, jobs, approvals, enrollments)

---

## Security

- Never commit `.env.local` or print tokens in terminal output.
- If a token is exposed, rotate immediately — see the [token rotation runbook](../../docs/cloud-control-plane.md#token-rotation).
- After rotating, re-pair all vi-agents (their stored daemon token is now invalid).
- The volume `vi_relay_data` must exist before first deploy. If missing, all agent/enrollment/job data is wiped on every redeploy.
