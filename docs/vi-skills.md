# VI Skill Packs

Skill packs let you bundle reusable prompt instructions and inject them into a session at creation time via `vi session create --skill <name>`. They are plain files — no code, no scripts, no relay changes.

---

## Directory format

```
<skill-dir>/<name>/
├── skill.yaml        # metadata
└── instructions.md   # prompt content
```

A skill requires both files. `instructions.md` is injected verbatim into the session's initial goal.

---

## `skill.yaml`

```yaml
name: code-review
description: Systematic code review focused on correctness, security, and clarity
version: "1.0"
allowedTools:
  - Read
  - Bash
  - WebSearch
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | recommended | Defaults to directory name if absent |
| `description` | recommended | Shown in `vi skills list` |
| `version` | optional | Informational only |
| `allowedTools` | optional | Display only — see Security notes |

---

## `instructions.md`

Free-form markdown. Injected as the start of `VI_INITIAL_GOAL`. Be specific — the agent receives this as its first instruction.

```markdown
You are performing a structured code review. For every file touched in the last commit:

1. Check for correctness issues (logic errors, off-by-one, null dereference).
2. Check for security issues (injection, unvalidated input, exposed secrets).
3. Check for clarity (unclear names, missing edge-case handling).

Report findings as a markdown list grouped by severity: critical / warning / info.
Do not make any edits — read only.
```

---

## Skill search path

Skills are resolved in this order. The first match wins.

| Priority | Location | Source label |
|----------|----------|--------------|
| 1 (highest) | `<nearest git root>/.vi/skills/<name>/` | `project` |
| 2 | `~/.vi/skills/<name>/` | `user` |

Project-level skills override user skills of the same name. This lets a repo ship its own skills that take precedence over personal defaults.

---

## Commands

### `vi skills list`

List all available skills across project and user directories.

```
$ vi skills list
┌──────────────┬─────────┬────────────────────────────────────────────────────────┐
│ Name         │ Source  │ Description                                            │
├──────────────┼─────────┼────────────────────────────────────────────────────────┤
│ code-review  │ user    │ Systematic code review focused on correctness          │
│ test-skill   │ user    │ E2E test skill for vi CLI smoke testing                │
│ ci-debug     │ project │ Diagnose failing CI runs and propose fixes             │
└──────────────┴─────────┴────────────────────────────────────────────────────────┘
```

```bash
vi skills list --json   # machine-readable array
```

---

### `vi skills show <name>`

Show full metadata and an instructions preview for a skill.

```
$ vi skills show code-review
┌───────────────┬──────────────────────────────────────────────────────────────┐
│ Field         │ Value                                                        │
├───────────────┼──────────────────────────────────────────────────────────────┤
│ Name          │ code-review                                                  │
│ Description   │ Systematic code review focused on correctness, security...   │
│ Version       │ 1.0                                                          │
│ Source        │ user                                                         │
│ Path          │ /home/user/.vi/skills/code-review                            │
│ Allowed tools │ Read, Bash, WebSearch  [display only — not enforced]         │
└───────────────┴──────────────────────────────────────────────────────────────┘

--- Instructions preview ---
You are performing a structured code review. For every file touched...
```

```bash
vi skills show code-review --json   # full skill object including instructions
```

---

### `vi skills validate <name>`

Check that a skill parses correctly and warn on potential issues. Always exits `0` — warnings are informational, never blocking.

```
$ vi skills validate code-review
Skill "code-review" is valid.

$ vi skills validate my-skill
Skill "my-skill" — 2 warning(s):
  ⚠  skill.yaml missing 'description' (recommended)
  ⚠  [credential warning] possible GitHub PAT (ghp_...) found — verify this is not a real credential
```

Checks performed:
- `skill.yaml` parses without error
- `name` field present
- `description` field present (recommended)
- `instructions.md` is non-empty
- Instructions scanned for credential-like patterns (see Security notes)

---

## Using a skill when creating a session

### Basic usage

```bash
vi session create \
  --agent rag_47675540-... \
  --skill code-review \
  --goal "review the changes in the last commit"
```

The agent receives `VI_INITIAL_GOAL` composed as:

```
[SKILL: code-review]
You are performing a structured code review...

--- Goal ---
review the changes in the last commit
```

### Skill only, no goal

```bash
vi session create --agent rag_47675540-... --skill code-review
```

The agent receives only the skill header and instructions — no goal separator.

### Without `--skill`

```bash
vi session create --agent rag_47675540-... --goal "review the last commit"
```

Behavior is identical to before skill packs were introduced. `VI_INITIAL_GOAL` contains only the goal string, unchanged.

---

## Multiple skills (stacking)

> Phase 2 — not yet implemented.

When available, skills can be stacked. Each skill's instructions are appended in order, separated by a divider:

```bash
vi session create \
  --agent rag_47675540-... \
  --skill code-review \
  --skill security-audit \
  --goal "review auth changes"
```

Composed result:
```
[SKILL: code-review]
<code-review instructions>

---

[SKILL: security-audit]
<security-audit instructions>

--- Goal ---
review auth changes
```

---

## Security notes

### Prompt-only

Skills are plain text files. They are injected as prompt content — nothing more. No skill file is executed, sourced, or interpreted as code by the CLI.

### No script execution

`skill.yaml` and `instructions.md` are read as static files. There is no `run:`, `exec:`, or scripting field. A skill cannot cause the CLI to run shell commands.

### `allowedTools` is display-only

The `allowedTools` field in `skill.yaml` is shown in `vi skills show` as a hint to the author and reviewer. It is **never** passed to the relay, **never** injected into the session environment, and **does not affect approval policy**. The agent's actual tool permissions come from the relay configuration, not the skill file.

This design prevents skills from being an implicit privilege escalation path.

### Credential warnings are warnings

`vi skills validate` scans `instructions.md` for patterns that look like real credentials (GitHub PATs, AWS key IDs, OpenAI keys, PEM headers). A match prints a warning but the command still exits `0`.

This is intentional: documentation examples legitimately contain token-like strings (e.g., `ghp_XXXXXXXXXXXX` in a tutorial). The warning asks you to double-check; it does not block the workflow.

**Never put real credentials in a skill file.** They would be sent to the relay as part of `VI_INITIAL_GOAL` and stored in the relay's job record.

---

## Creating your first skill

```bash
# 1. Create the skill directory
mkdir -p ~/.vi/skills/my-skill

# 2. Write the metadata
cat > ~/.vi/skills/my-skill/skill.yaml << 'EOF'
name: my-skill
description: Short description shown in vi skills list
version: "1.0"
EOF

# 3. Write the instructions
cat > ~/.vi/skills/my-skill/instructions.md << 'EOF'
<your instructions here>
EOF

# 4. Validate
vi skills validate my-skill

# 5. Use it
vi session create --agent <agentId> --skill my-skill --goal "your goal here"
```
