# VI Orchestrator — MVP Milestone

**Date:** 2026-05-29  
**HEAD:** `71ef013`  
**Repo:** `JozzyAI/Vibe_Interface` · branch `main`

This document summarises what the VI orchestrator can do at this milestone,
the golden-path commands, known limitations, safety guarantees, and what to
build next. It is a companion to `HANDOFF.md` (architecture) and
`docs/vi-orchestrator.md` (daily usage).

---

## What works

### Web dashboard (`packages/web`)

| Feature | Notes |
|---------|-------|
| Machines page | Lists connected agents, connection state, pending approvals |
| Sessions page | All jobs with status, provider state, log tail |
| Session detail + terminal | Live PTY stream via relay WebSocket |
| Create session form | Machine picker, model, thinking effort, workspace browser |
| Multi-skill selector | Chip-based add/remove, order preserved, up to N skills |
| Approval queue | List open requests; approve/reject with reason |
| Cloud + local modes | Toggle via `VI_RELAY_BASE_URL` + `VI_RELAY_VI_TOKEN`; no code change |
| Polling hierarchy | 3-tier (L1/L2/background) → 83–100% fewer relay calls |

### VI CLI (`packages/vi-cli`, binary `vi`)

**Config**
```
vi config set --base-url <url> --token <token>
vi config show
vi config clear
```

**Read-only relay**
```
vi overview
vi machines [--status <status>] [--json]
vi sessions [--agent <id>] [--status <status>] [--json]
vi session get <jobId> [--json]
vi session logs <jobId>
vi approvals [--status all|open|approved|rejected] [--json]
```

**Write (session lifecycle)**
```
vi session create --agent <id> --cwd <path> --goal "<text>" [--skill a] [--skill b] [--model <m>]
vi session create --agent <id> --auto-skill --goal "<text>" [--yes]
vi session send <jobId> "<text>" [--no-submit] [--key escape]
vi session wait <jobId> --until <states> [--timeout <s>]
vi approve <requestId> [--response "<text>"]
vi reject  <requestId> [--response "<text>"]
```

**Skill management**
```
vi skills init <name>                          # scaffold local skill
vi skills list [--json]
vi skills show <name> [--json]
vi skills validate <name>
vi skills add <url> [--name <n>] [--yes]       # import from git repo
vi skills sync [<name>]                        # re-fetch, update lock
vi skills remove <name> [--force]
```

**Skill discovery**
```
vi skills recommend --task "<text>" [--top <n>] [--json]
vi skills search "<query>" [--json]
vi skills index refresh | clear | status
```

**Task planning**
```
vi task plan --goal "<text>" [--json] [--yaml]
```

---

## Golden path

### 1. Start a session with auto-skill

```bash
# List connected machines
vi machines

# Recommend skills for your task
vi skills recommend --task "debug ROCm SGLang RDMA fallback"

# Create session (TTY: prompts to confirm; --yes to skip)
vi session create \
  --agent <agentId> \
  --cwd /home/amd/project \
  --auto-skill \
  --goal "the SGLang RDMA fallback triggers on ROCm 6.2 — find root cause"

# Wait for agent response
vi session wait $JOB --until waiting_input,busy,completed,failed --timeout 600

# Read output
vi session logs $JOB

# Handle approvals if needed
vi approvals
vi approve <requestId>
```

### 2. Multi-skill + subtask decomposition

```bash
# Decompose a goal and see which skills match each subtask
vi task plan \
  --goal "Fix dashboard polling latency and implement GitHub skill import"

# Install recommended skills
vi skills add https://github.com/addyosmani/agent-skills/tree/main/frontend-debug

# Run the sessions the planner suggested
vi session create \
  --agent <id> \
  --skill frontend-debug \
  --skill relay-debug \
  --goal "Fix dashboard polling latency"
```

### 3. GitHub skill discovery

```bash
# Search curated sources (report only — no install)
vi skills search "electron rendering debug"

# Review the suggested URL, then explicitly install
vi skills add https://github.com/addyosmani/agent-skills/tree/main/electron-debug

# Confirm it's pinned
vi skills show electron-debug    # shows Origin, Pinned commit, Fetched at
```

### 4. Full orchestrator script

See `scripts/vi-orchestrator-smoke.sh` and `docs/vi-orchestrator.md` §7 for a
complete shell script: machines → create with skill → wait → logs → send → approve.

---

## Known limitations

| Area | Limitation |
|------|------------|
| **Skills are prompt-only** | `allowedTools` in `skill.yaml` is displayed in `vi skills show` but not enforced. Skills inject only text context into `VI_INITIAL_GOAL` — they do not constrain which tools the agent is allowed to call. |
| **GitHub skills: report/preview/import only** | `vi skills search` is read-only; it never installs. `vi skills add` is explicit and previews before writing. No skill file except `skill.yaml` + `instructions.md` is copied. Scripts in the source repo are never executed. |
| **Search depends on GitHub availability** | `vi skills index refresh` and on-demand fetch use the unauthenticated GitHub API (60 req/hr). Rate limits cause partial fetches; the cache is used with a stale warning. `vi skills recommend` is fully local and unaffected. |
| **GitHub API coverage is partial** | 3 of 8 curated sources (hashicorp/agent-skills, supabase/agent-skills, shakacode/...) rate-limited during development. Their skills are not yet in the default index. `vi skills index refresh` at a later time will pick them up. |
| **Skill matching is keyword-only** | `vi skills recommend` uses token overlap (name/description/instructions) with no semantic understanding. Close synonyms or paraphrases will not match if they share no tokens. |
| **Task decomposition is heuristic** | `vi task plan` splits on "and"/"then"/";"/newlines. Complex multi-clause goals may not split cleanly. No LLM is called. |
| **Electron desktop — WSLg rendering** | `apps/desktop` builds and DOM mounts correctly, but WSLg's GPU compositor may show a blank window after a GPU process crash. Recovery: `wsl --shutdown` in Windows PowerShell, then restart. Code is correct; this is a WSLg session state issue. |
| **Mobile app — MVP only** | `apps/mobile` (Expo) supports approval hub and basic session view. Send-input, terminal streaming, and skill UI are not implemented. |
| **Single shared token auth** | The dashboard uses `VI_ACCESS_TOKEN` — one shared secret. Fine for personal use; not suitable for multi-user deployment without NextAuth or equivalent. |
| **SQLite single-instance relay** | Suitable for personal/team use. Not horizontally scalable. Migration to Postgres requires only `db.ts` + `store.ts` changes. |

---

## Safety guarantees

These constraints are enforced in code and verified at every release.

| Guarantee | How it is enforced |
|-----------|--------------------|
| **No auto-install of remote skills** | `vi skills search` and `vi skills recommend` are read-only. `vi skills add` requires an explicit URL argument and previews `skill.yaml` + `instructions.md` before writing. |
| **No script execution from skill repos** | `vi skills add` copies only `skill.yaml` and `instructions.md`. All other files in the cloned repo are ignored. `git clone --depth 1` is used; no `npm install`, no `make`, no shell scripts are run. |
| **Skills inject text only** | Skill content is placed in `VI_INITIAL_GOAL` as plain text. No code is evaluated, no env vars are set from skill content, no tool permissions are changed. |
| **Credential scan at add/sync time** | `warnCredentials()` scans `instructions.md` for GitHub PATs, AWS keys, OpenAI keys, and PEM headers. Findings are printed as warnings to stderr; the operation is never hard-failed (a match in docs/examples is acceptable). |
| **Relay auth is unchanged** | `packages/relay` was not modified in any skill-related commit. Relay tokens, daemon auth, and the `/v1/vi/*` API surface are identical to the pre-skill baseline. |
| **Tokens never logged** | `vi config show` always prints `(set)` or `(set via env)` — the token value is never written to stdout, stderr, or any file. The skill index cache (`~/.vi/skill-index.json`) contains only GitHub metadata (skill names, descriptions, URLs). |
| **`~/.vi/skill-index.json` is local only** | This file is never committed to git (confirmed by `git ls-files`). It contains no auth credentials. |
| **`VI_CLI_READ_ONLY=1` enforced** | All write commands (`session create`, `session send`, `approve`, `reject`) exit 4 when this env var is set. Read-only commands (`recommend`, `search`, `task plan`, `list`, `show`, `logs`) are always permitted. |

---

## Next suggested work

### Tier 1 — Highest value, low complexity

| Item | Why |
|------|-----|
| **Curated starter skill packs** | Ship 3–5 well-tested skills (e.g. `code-review`, `security-audit`, `debug-general`) as the default content for `vi skills index`. Currently the search index depends entirely on third-party repos with variable quality. |
| **Dashboard skill recommendation UI** | Show `vi skills recommend`-style suggestions in the Create Session form when the user types a goal. Uses the same scoring as the CLI; no new backend needed. |
| **`vi skills add` from GitHub tree URL (verified)** | The URL parser and `cloneAndCopy` already work; needs a documented list of known-good skill URLs to surface to users in README/docs. |

### Tier 2 — High value, moderate effort

| Item | Why |
|------|-----|
| **Better single-job relay endpoints** | `getRemoteApprovalOverview()` returns the full state of all jobs on every call. All CLI commands filter client-side. A `GET /v1/vi/jobs/:id` endpoint would make `vi session get`, `vi session logs`, and `vi session wait` faster and cheaper on the relay. |
| **`vi task plan` with LLM decomposition** | Replace the heuristic splitter with a structured prompt to a remote Claude session. Would dramatically improve subtask quality for complex multi-part goals. Requires a connected agent. |
| **Semantic skill matching** | Replace token-overlap scoring with embedding-based similarity. Could run locally via a small embedding model or call the relay's Claude instance. Improves recall for synonym-heavy queries (`ROCm` ↔ `GPU`, `latency` ↔ `slow`). |
| **Skill allowedTools enforcement** | Use `allowedTools` from `skill.yaml` to restrict which tools an agent session is permitted to call. Needs relay-side permission policy integration. Currently display-only. |

### Tier 3 — Infrastructure / hardening

| Item | Why |
|------|-----|
| **Production deployment hardening** | Rate-limit the no-auth enrollment endpoint; add IP-based throttle. Add structured logging to relay. Document token rotation runbook end-to-end. |
| **Electron desktop — verify after WSLg restart** | Run `wsl --shutdown`, relaunch `apps/desktop`, confirm Setup screen renders. Once confirmed, remove `playwright-core` devDep, complete IPC layer for live relay data. |
| **Mobile send-input + terminal stream** | `apps/mobile` is approval-only. Adding session send and terminal view (WebView or custom) would make it a full mobile orchestrator client. |
| **Multi-user auth** | Replace `VI_ACCESS_TOKEN` with invite-based accounts (NextAuth.js + GitHub OAuth is the recommended path). Do not start until deployment hardening is complete. |

---

## Commit history (milestone window)

```
71ef013  fix: skillIndex — skip dotfile dirs (.claude, .claude-plugin, etc.)
dbd7c9d  feat: skill recommendation, search, auto-skill, and task planning
c7f01fe  feat: dashboard multi-skill selector — chip UI, multi-skill composition
ff32cf2  feat: vi skills add/sync/remove — remote skill management via git
3ab6d69  docs: rewrite vi-orchestrator.md — complete daily usage guide
f31a73e  feat: daily usage doc + dashboard skill selector + skills API
f8b8939  feat(vi-cli): add vi skills init; fix wait negative timeout; smoke test
909b9d0  docs: add vi-orchestrator-smoke.sh — golden-path smoke test script
9cd003a  docs: add vi-skills.md — skill pack guide
0cf0f54  feat(vi-cli): add skill pack system — vi skills + vi session create
```

---

## References

| Document | Contents |
|----------|----------|
| `docs/HANDOFF.md` | Architecture deep-dive, file map, environment variables, do-not-do list |
| `docs/vi-orchestrator.md` | Daily usage guide — setup, sessions, approvals, full script, troubleshooting |
| `docs/vi-skills.md` | Skill pack format, `skill.yaml` reference, security notes |
| `docs/vi-cli.md` | Full CLI reference |
| `scripts/vi-orchestrator-smoke.sh` | Golden-path smoke test script |
