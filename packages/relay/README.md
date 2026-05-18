# PI Relay

The PI Cloud Control Plane. A lightweight Node.js server that stores agent state in SQLite and relays messages between the PI dashboard and remote pi-agents.

Both the dashboard and pi-agents connect outbound to the relay — neither side needs a public IP or open inbound port.

For the full setup guide and token rotation runbook see [docs/cloud-control-plane.md](../../docs/cloud-control-plane.md).

---

## Routes

| Path | Auth | Caller |
|------|------|--------|
| `POST /v1/daemon/register` | daemon token | pi-agent |
| `POST /v1/daemon/heartbeat` | daemon token | pi-agent |
| `GET /v1/daemon/agents/:id/poll` | daemon token | pi-agent |
| `POST /v1/daemon/jobs/report` | daemon token | pi-agent |
| `POST /v1/daemon/requests` | daemon token | pi-agent |
| `POST /api/remote-agents/enrollments/consume` | none (enrollment code) | pi-agent pair |
| `GET /v1/pi/overview` | pi token | dashboard |
| `POST /v1/pi/jobs` | pi token | dashboard |
| `POST /v1/pi/approvals/:id/respond` | pi token | dashboard |
| `POST /v1/pi/enrollments` | pi token | dashboard |
| `GET /health` | none | monitoring |
| `GET /presence` | pi token | dashboard |
| `WS /ws` | token | job dispatch, approvals |
| `WS /pi-agent-relay` | token | terminal stream |

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
fly volumes create pi_relay_data --size 1 --region sin --app <your-app-name>
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
openssl rand -hex 32   # run again → PI_TOKEN
```

Set them on Fly (replace placeholders with real values):

```bash
fly secrets set \
  PI_RELAY_TOKENS="<DAEMON_TOKEN>:daemon:local-daemon,<PI_TOKEN>:pi:local-pi" \
  PI_RELAY_OWNER_TOKEN="<PI_TOKEN>" \
  PI_RELAY_PUBLIC_WS_URL="wss://<your-app-name>.fly.dev" \
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

PI_RELAY_PORT=8788 \
PI_RELAY_TOKENS="daemon-test:daemon:dev,pi-test:pi:dev" \
PI_RELAY_OWNER_TOKEN="pi-test" \
PI_RELAY_DB_PATH=/tmp/pi-relay-dev.db \
node dist/index.js
```

Health check: `curl http://localhost:8788/health`

Point the dashboard at it:

```bash
# packages/web/.env.local  — local dev only, these tokens are not secret
PI_RELAY_BASE_URL=http://localhost:8788
PI_RELAY_PI_TOKEN=pi-test
PI_RELAY_DAEMON_TOKEN=daemon-test
PI_RELAY_PUBLIC_WS_URL=ws://localhost:8788
```

> These are short dev-only placeholder tokens for local testing. Use `openssl rand -hex 32` for production.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PI_RELAY_TOKENS` | Yes | `token:kind:label,...` — auth tokens. `kind` is `daemon` or `pi` |
| `PI_RELAY_OWNER_TOKEN` | Yes | Bootstrap token for default owner row (same value as PI_TOKEN) |
| `PI_RELAY_PUBLIC_WS_URL` | Yes | Public WebSocket URL baked into enrollment pair commands |
| `PI_RELAY_DB_PATH` | Optional | SQLite path (default `./pi-relay.db`; use `/data/pi-relay.db` on Fly) |
| `PI_RELAY_PORT` | Optional | HTTP listen port (default `8787`) |
| `PI_RELAY_HOST` | Optional | Bind host (default `0.0.0.0`) |

---

## Token format

`PI_RELAY_TOKENS` is a comma-separated list of `token:kind:label` entries:

```
<token1>:daemon:my-machine,<token2>:pi:dashboard
```

- `daemon` — used by pi-agent (heartbeat, register, report, enrollment consume)
- `pi` — used by the dashboard (overview, jobs, approvals, enrollments)

---

## Security

- Never commit `.env.local` or print tokens in terminal output.
- If a token is exposed, rotate immediately — see the [token rotation runbook](../../docs/cloud-control-plane.md#token-rotation).
- After rotating, re-pair all pi-agents (their stored daemon token is now invalid).
- The volume `pi_relay_data` must exist before first deploy. If missing, all agent/enrollment/job data is wiped on every redeploy.
