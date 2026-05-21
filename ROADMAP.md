# PI Roadmap

## Product Overview

PI is a multi-user remote agent management platform with three core components:

```
[vi-agent] ──connects──► [relay / GCP] ◄──polls── [dashboard]
   PyPI                    auth + routing           web / iOS / Android / desktop
   user account            per-user                 multi-user
```

---

## The Three Components

### 1. vi-agent (PyPI client)
- Installed on any machine the user wants to control
- `pip install vi-agent` → `vi-agent login` → `vi-agent start`
- Authenticates with a user token tied to their account
- Connects outbound to the relay — no inbound ports needed on the client machine

### 2. Relay (GCP)
- Runs on a Google Cloud e2-micro instance (Always Free tier)
- Routes traffic between vi-agent instances and the dashboard
- Per-user routing: each vi-agent connection is tied to a GitHub user account
- HTTPS + WSS, public domain

### 3. Dashboard (multi-platform)
- **Web**: Next.js (exists today)
- **Mobile**: React Native — iOS + Android from one codebase
- **Desktop**: Tauri — Windows + Mac from one codebase
- All clients talk to a shared REST/WebSocket API layer

---

## Architecture Decisions

### Auth: GitHub OAuth + invite-only whitelist
- GitHub OAuth for login (no password management)
- Whitelist controlled via env var: `VI_ALLOWED_GITHUB_USERS=JozzyAI,user2,user3`
- Any GitHub user not on the list gets a 403 — no self-serve signup
- Simple to manage: add a name to the env var to grant access

### Data: per-user isolation
- Current single-user flat JSON files need to become per-user
- Short-term: per-user directory (`~/.pi/users/<github_username>/`)
- Long-term: migrate to a proper database (PostgreSQL or SQLite)

### API layer
- Current dashboard reads files directly in server components
- Must be refactored into a clean REST/WebSocket API before mobile/desktop clients can be built
- All clients (web, mobile, desktop) call the same API

---

## Security Hardening (required before any public exposure)

Current status: **zero authentication** — anyone with the URL has full access.

| Item | Status | Fix |
|------|--------|-----|
| Dashboard auth | ❌ None | GitHub OAuth + middleware |
| API route auth | ❌ None | Session token check on all `/api/*` |
| Relay auth | ❌ Open (`VI_RELAY_TOKENS` not set) | Per-user tokens |
| Terminal WebSocket (14801) | ❌ Open | Bind to localhost only, proxy through Next.js |
| HTTPS | ❌ HTTP only | Caddy/nginx reverse proxy on GCP |

---

## Phased Plan

### Phase 1 — Auth + Security (Week 1–2)
- [ ] GitHub OAuth App registration
- [ ] NextAuth.js integration
- [ ] Whitelist middleware protecting all pages and API routes
- [ ] `VI_RELAY_TOKENS` — generate per-user tokens, validate on relay connect
- [ ] Bind port 14801 to localhost only

### Phase 2 — GCP Relay Deploy (Week 2–3)
- [ ] Provision GCP e2-micro (us-central1, Always Free)
- [ ] Deploy relay server
- [ ] Domain name + Caddy for HTTPS/WSS
- [ ] Per-user relay routing
- [ ] vi-agent connects to GCP relay instead of local

### Phase 3 — vi-agent PyPI (Week 3–4)
- [ ] `pip install vi-agent` packaging
- [ ] `vi-agent login` — OAuth device flow, stores token locally
- [ ] `vi-agent start` — connects to GCP relay with user token
- [ ] `vi-agent status` / `vi-agent stop`
- [ ] Publish to PyPI

### Phase 4 — Web Dashboard Production (Week 4–5)
- [ ] Deploy dashboard to GCP (or Vercel)
- [ ] Per-user data isolation
- [ ] HTTPS public URL
- [ ] Migrate from server-component file reads to REST API layer

### Phase 5 — Mobile + Desktop (Month 2–3)
- [ ] Extract clean REST/WebSocket API (prerequisite for all native clients)
- [ ] React Native app (iOS + Android)
- [ ] Tauri app (Windows + Mac)

---

## GCP Setup Notes

- **Instance**: e2-micro, us-central1, 30GB disk
- **Always Free**: 1 instance per account, 1GB egress/month free
- **Ports to open**: 443 (HTTPS), 80 (redirect), WSS on same port via Caddy
- **Relay internal port**: 14801 (not exposed publicly, proxied)

---

## Key Dependencies

```
GitHub OAuth App
      ↓
NextAuth.js (web auth)
      ↓
Per-user tokens (relay auth)
      ↓
GCP deploy (relay + dashboard)
      ↓
PyPI packaging (vi-agent login)
      ↓
API layer refactor (mobile/desktop prerequisite)
      ↓
React Native + Tauri
```

---

## Immediate Next Step

Register GitHub OAuth App:
1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL: `http://localhost:3000` (update after GCP deploy)
3. Callback URL: `http://localhost:3000/api/auth/callback/github`
4. Add `Client ID` and `Client Secret` to `.env.local`
