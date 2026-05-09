# PI Architecture

## Goal

Transform AO from a strong parallel execution layer into a full operating system for idea intake, human approval, and recoverable long-running work.

## Layering

### AO stays as the execution backbone

- tracker plugins
- agent plugins
- runtime plugins
- workspace and SCM integration
- PR, CI, review reaction loop

### PI adds the missing control plane

- Idea Intake Service
- Budget-Aware Scheduler
- Human-in-the-Loop State Machine
- Context Persistence Layer
- Dashboard extensions
- optional notifier layer

## Package plan

### `packages/core`

Owns:

- idea normalization
- idea to issue expansion
- queued session creation
- budget and rate-limit scheduling
- human request objects and session state transitions
- recovery snapshots and handoff persistence
- AO command generation for spawn, send, and restore

### `packages/intake-api`

Owns:

- dashboard or external submit endpoint
- intake payload validation
- conversion to GitHub issue payloads
- queuing work for the scheduler

### `packages/web`

Owns:

- inbox view
- backlog view
- active agents view
- recovery view
- approve/reject/reply actions

## State model

Sessions can move through:

- `queued`
- `running`
- `awaiting_user_input`
- `awaiting_approval`
- `blocked`
- `review_ready`
- `merged`
- `failed`

## Persistence contract

Every session gets a recoverable handoff bundle:

- `session-summary.md`
- `pending-questions.json`
- `execution-state.json`

## AO mapping

| PI capability | AO package target |
| --- | --- |
| queue, scheduler, budget gates | `packages/core` |
| question and approval events | `packages/core` |
| persistence hooks | `packages/core` |
| inbox, backlog, recovery UI | `packages/web` |
| intake API or bot | new `packages/intake-*` |
| Slack or Telegram nudges | new `packages/plugins/notifier-*` |
