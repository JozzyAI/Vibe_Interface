# Project Interface (PI)

PI is a thin control plane that upgrades Agent Orchestrator (AO) from a parallel coding-agent runner into:

- a 24/7 idea factory
- a human approval and clarification inbox
- a recoverable long-running session system
- a GitHub-native issue to PR workflow hub

This repository starts with an MVP scaffold that mirrors the areas you called out:

- `packages/core`: idea intake, queue scheduling, human-in-the-loop state, recovery persistence, AO command adapters
- `packages/intake-api`: lightweight API layer that turns raw ideas into issue plans and queued sessions
- `packages/web`: dashboard prototype for inbox, backlog, active agents, and recovery

## MVP scope

The current implementation is intentionally AO-adjacent instead of patching AO directly. It gives us a local reference implementation for:

1. turning ideas into GitHub-ready issue payloads
2. gating work with concurrency and rate-limit budgets
3. exposing `awaiting_user_input` and `awaiting_approval` as first-class dashboard states
4. persisting `session-summary.md`, `pending-questions.json`, and `execution-state.json`
5. surfacing restore actions in the dashboard model

## Run locally

Start the intake API:

```bash
node ./packages/intake-api/src/server.js
```

Start the dashboard prototype:

```bash
node ./packages/web/src/server.js
```

Inspect the core demo flow:

```bash
node ./packages/core/src/demo.js
```

## Design principles

PI is designed as a standalone control plane reference implementation:

- **Zero dependencies** — all three servers run with plain `node`, no `npm install` required.
- **Flat persistence** — each session writes a recoverable bundle to `./data/sessions/<session-id>/` (`session-summary.md`, `pending-questions.json`, `execution-state.json`).
- **AO-compatible** — the AO adapter in `packages/core` emits structured spawn/restore command plans that map directly to `ao` CLI calls, making it easy to wire PI into any AO-compatible execution backend.

## Contributing

PRs and issues welcome. The packages are intentionally small and self-contained — each one can be read in a single sitting.
