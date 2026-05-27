from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

try:
    import websocket
except ImportError:  # pragma: no cover - optional until the remote bridge is reinstalled with relay deps
    websocket = None

try:
    from vi_agent.terminal_relay import TerminalRelayClient, derive_terminal_relay_url
except ImportError:  # pragma: no cover
    TerminalRelayClient = None  # type: ignore[assignment,misc]
    derive_terminal_relay_url = None  # type: ignore[assignment]

AUTH_CONNECTOR_CACHE_SECONDS = 60.0
_auth_connector_cache: tuple[float, list[dict[str, Any]]] | None = None


def normalize_server(server: str) -> str:
    return server.rstrip("/")


def normalize_relay_url(url: str) -> str:
    trimmed = url.rstrip("/")
    if trimmed.startswith("http://"):
        trimmed = "ws://" + trimmed[len("http://") :]
    elif trimmed.startswith("https://"):
        trimmed = "wss://" + trimmed[len("https://") :]
    if not trimmed.endswith("/ws"):
        trimmed = trimmed + "/ws"
    return trimmed


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def iso_from_timestamp(timestamp: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def tail_text(path: Path, max_bytes: int = 24_000) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def first_markdown_heading(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip() or None
    return None


def handoff_enabled() -> bool:
    return os.environ.get("VI_HANDOFF_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}


def ensure_handoff_files(job_id: str, title: str, jobs_dir: Path) -> Path:
    artifact_dir = jobs_dir / job_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if not handoff_enabled():
        return artifact_dir
    state_path = handoff_state_path(artifact_dir)
    if state_path is not None and not state_path.exists():
        save_handoff_state(
            artifact_dir,
            {
                "schema_version": 1,
                "job_id": job_id,
                "title": title,
                "status": "running",
                "objective": title,
                "doing": "",
                "next": [],
                "done_recent": [],
                "blockers": [],
                "decisions": [],
                "resume_prompt": "",
                "updated_at": iso_now(),
                "updated_reason": "started",
                "mechanical": {
                    "last_status": "queued",
                    "last_checkpoint_reason": "started",
                    "last_seen_at": iso_now(),
                },
            },
        )
    templates = {
        "PROGRESS.md": (
            "<!-- VI_MANAGED_HANDOFF -->\n"
            f"# {title}\n\n"
            "## Current goal\n\n"
            "- Not reported yet.\n\n"
            "## Done\n\n"
            "- Nothing recorded yet.\n\n"
            "## Current state\n\n"
            "- Session started.\n\n"
            "## Next step\n\n"
            "- Continue from the current CLI state.\n"
        ),
        "TODO.md": (
            "<!-- VI_MANAGED_HANDOFF -->\n"
            f"# {title} TODO\n\n"
            "- [ ] Continue from the latest remote CLI state.\n"
        ),
        "NOTES.md": (
            "<!-- VI_MANAGED_HANDOFF -->\n"
            f"# {title} Notes\n\n"
            "PI maintains this handoff automatically from session lifecycle and CLI output.\n"
        ),
    }
    for filename, template in templates.items():
        path = artifact_dir / filename
        if not path.exists():
            path.write_text(template, encoding="utf-8")
    return artifact_dir


def handoff_state_path(artifact_dir: Path | None) -> Path | None:
    return None if artifact_dir is None else artifact_dir / "handoff-state.json"


def load_handoff_state(artifact_dir: Path | None) -> dict[str, Any]:
    path = handoff_state_path(artifact_dir)
    if path is None or not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_handoff_state(artifact_dir: Path | None, state: dict[str, Any]) -> None:
    if not handoff_enabled():
        return
    path = handoff_state_path(artifact_dir)
    if path is None:
        return
    write_if_changed(path, json.dumps(state, indent=2, ensure_ascii=False) + "\n")


def write_if_changed(path: Path, text: str) -> None:
    try:
        if path.exists() and path.read_text(encoding="utf-8", errors="replace") == text:
            return
    except OSError:
        pass
    path.write_text(text, encoding="utf-8")


def handoff_file_is_pi_managed(path: Path) -> bool:
    try:
        return path.read_text(encoding="utf-8", errors="replace").lstrip().startswith("<!-- VI_MANAGED_HANDOFF -->")
    except OSError:
        return False


def render_handoff_text(state: dict[str, Any]) -> tuple[str, str, str]:
    title = str(state.get("title") or state.get("objective") or "PI session")
    objective = str(state.get("objective") or "Not reported yet.")
    doing = str(state.get("doing") or "Not reported yet.")
    resume_prompt = str(state.get("resume_prompt") or "Continue from this state.")

    def bullets(values: Any, fallback: str) -> str:
        if isinstance(values, list):
            cleaned = [str(value).strip() for value in values if str(value).strip()]
            if cleaned:
                return "\n".join(f"- {value}" for value in cleaned)
        return f"- {fallback}"

    progress = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title}\n\n"
        "## Objective\n\n"
        f"{objective}\n\n"
        "## Current state\n\n"
        f"{doing}\n\n"
        "## Recent progress\n\n"
        f"{bullets(state.get('done_recent'), 'Not reported yet.')}\n"
    )
    todo = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title} TODO\n\n"
        f"{bullets(state.get('next'), 'Continue from the current CLI state.')}\n"
    )
    notes = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title} Notes\n\n"
        "## Decisions\n\n"
        f"{bullets(state.get('decisions'), 'No decisions recorded yet.')}\n\n"
        "## Blockers\n\n"
        f"{bullets(state.get('blockers'), 'No blockers recorded.')}\n\n"
        "## Resume prompt\n\n"
        f"{resume_prompt}\n"
    )
    return progress, todo, notes


def sync_handoff_markdown_from_state(artifact_dir: Path | None, state: dict[str, Any]) -> None:
    if artifact_dir is None or not handoff_enabled():
        return
    progress_path = artifact_dir / "PROGRESS.md"
    todo_path = artifact_dir / "TODO.md"
    notes_path = artifact_dir / "NOTES.md"
    if not all(handoff_file_is_pi_managed(path) for path in (progress_path, todo_path, notes_path)):
        return
    progress, todo, notes = render_handoff_text(state)
    write_if_changed(progress_path, progress)
    write_if_changed(todo_path, todo)
    write_if_changed(notes_path, notes)


def refresh_handoff_metadata(
    artifact_dir: Path | None,
    *,
    job_id: str,
    title: str,
    status: str,
    updated_at: str,
    reason: str,
) -> None:
    if artifact_dir is None or not handoff_enabled():
        return
    existing = load_handoff_state(artifact_dir)
    state = {
        "schema_version": 1,
        "job_id": job_id,
        "title": title,
        "status": existing.get("status") or status,
        "objective": existing.get("objective") or title,
        "doing": existing.get("doing") or "",
        "next": existing.get("next") if isinstance(existing.get("next"), list) else [],
        "done_recent": existing.get("done_recent") if isinstance(existing.get("done_recent"), list) else [],
        "blockers": existing.get("blockers") if isinstance(existing.get("blockers"), list) else [],
        "decisions": existing.get("decisions") if isinstance(existing.get("decisions"), list) else [],
        "resume_prompt": existing.get("resume_prompt") or "",
        "updated_at": existing.get("updated_at") or updated_at,
        "updated_reason": existing.get("updated_reason") or "started",
        "mechanical": {
            **(existing.get("mechanical") if isinstance(existing.get("mechanical"), dict) else {}),
            "last_status": status,
            "last_checkpoint_reason": reason,
            "last_seen_at": updated_at,
        },
    }
    save_handoff_state(artifact_dir, state)
    sync_handoff_markdown_from_state(artifact_dir, state)


def refresh_managed_handoff_files(
    artifact_dir: Path | None,
    *,
    title: str,
    status: str,
    screen: str,
    updated_at: str,
    reason: str,
) -> None:
    if artifact_dir is None or not handoff_enabled():
        return
    progress_path = artifact_dir / "PROGRESS.md"
    todo_path = artifact_dir / "TODO.md"
    notes_path = artifact_dir / "NOTES.md"
    if not all(handoff_file_is_pi_managed(path) for path in (progress_path, todo_path, notes_path)):
        return

    latest = compact_text(screen, limit=900) or "No CLI output captured yet."
    detected = detect_pi_session_hook_request(screen)
    blocker = detected["title"] if detected else None
    next_step = (
        f"Wait for PI utility session: {blocker}."
        if blocker
        else "Continue from the latest CLI prompt or resume this session on any connected machine."
    )
    progress = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title}\n\n"
        "## Current goal\n\n"
        "- Continue the PI-managed remote coding session.\n\n"
        "## Current state\n\n"
        f"- Status: {status}.\n"
        f"- Checkpoint: {reason}.\n"
        f"- Updated: {updated_at}.\n"
        + (f"- Blocker detected: {blocker}.\n" if blocker else "")
        + "\n## Latest CLI snapshot\n\n"
        f"```text\n{latest}\n```\n\n"
        "## Next step\n\n"
        f"- {next_step}\n"
    )
    todo = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title} TODO\n\n"
        f"- [ ] {next_step}\n"
    )
    notes = (
        "<!-- VI_MANAGED_HANDOFF -->\n"
        f"# {title} Notes\n\n"
        "- This handoff is generated by PI from the wrapper lifecycle and remote CLI output.\n"
        "- If a human or agent removes the VI_MANAGED_HANDOFF marker, PI will stop overwriting this file.\n"
    )
    write_if_changed(progress_path, progress)
    write_if_changed(todo_path, todo)
    write_if_changed(notes_path, notes)


def screen_fingerprint(screen: str) -> str:
    return hashlib.sha256(screen.encode("utf-8", errors="replace")).hexdigest()


def has_compact_checkpoint_marker(screen: str) -> bool:
    lower = screen.lower()
    return any(
        marker in lower
        for marker in (
            "context compact",
            "compacted conversation",
            "conversation compacted",
            "compact complete",
            "resume summary",
            "summarizing conversation",
        )
    )


def handoff_payload(artifact_dir: Path | None) -> dict[str, Any]:
    if artifact_dir is None or not handoff_enabled():
        return {}
    progress = tail_text(artifact_dir / "PROGRESS.md", max_bytes=32_000)
    todo = tail_text(artifact_dir / "TODO.md", max_bytes=24_000)
    notes = tail_text(artifact_dir / "NOTES.md", max_bytes=24_000)
    title = first_markdown_heading(progress) or first_markdown_heading(todo) or first_markdown_heading(notes)
    state = load_handoff_state(artifact_dir)
    return {
        "artifactsDir": str(artifact_dir),
        "progress": progress,
        "todo": todo,
        "notes": notes,
        "handoffTitle": title,
        "handoffState": state if state else None,
    }


def tmux_session_name(job_id: str) -> str:
    safe = "".join(ch if ch.isalnum() else "_" for ch in job_id)
    return f"vi_remote_{safe[:80]}"


def tmux_available() -> bool:
    return shutil.which("tmux") is not None


def is_interactive_remote_command(command: list[str]) -> bool:
    text = " ".join(command).lower()
    return " codex " in f" {text} " or text.endswith(" codex") or " claude " in f" {text} "


def tmux_has_session(session_name: str) -> bool:
    return (
        subprocess.run(
            ["tmux", "has-session", "-t", session_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )


def tmux_capture(session_name: str, lines: int = 220) -> str:
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", session_name, "-p", "-S", f"-{lines}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.decode("utf-8", errors="replace")


def detect_pi_session_hook_request(screen: str) -> dict[str, str] | None:
    """Detect host-side blockers that should be handled by a PI utility session."""
    lower = screen.lower()
    if (
        "requires a newer version of codex" in lower
        or "please upgrade to the latest app or cli" in lower
        or ("update ran successfully" in lower and "please restart codex" in lower)
    ):
        return {
            "title": "Update Codex CLI",
            "message": (
                "The remote Codex CLI is blocked by a version/restart requirement. "
                "Run the host-side Codex update in a separate PI utility session, then resume this work."
            ),
            "command": "npm install -g @openai/codex && codex --version",
            "risk": "medium",
            "actionKind": "codex_update",
        }
    github_auth_missing = (
        "github auth is missing" in lower
        or "authentication failed" in lower
        or "could not read username" in lower
        or ("gh auth" in lower and ("not logged" in lower or "unauthorized" in lower))
    )
    if github_auth_missing:
        return {
            "title": "Complete GitHub auth",
            "message": (
                "The remote session is blocked because GitHub credentials are missing on this machine. "
                "Run GitHub CLI authentication in a separate PI utility session."
            ),
            "command": "gh auth status || gh auth login",
            "risk": "medium",
            "actionKind": "github_auth",
        }
    return None


def detect_provider_state(screen: str, *, provider: str | None = None) -> dict[str, Any]:
    """Return a provider-neutral state from hook data first, then PTY fallback.

    The bridge owns the PTY fallback today. Provider-specific official hooks can
    write structured event files later and this adapter can consume them without
    changing auto-approval or Ralph logic.
    """
    text = screen or ""
    lower = text.lower()
    stripped = text.rstrip()
    provider_name = (provider or "unknown").lower()

    if not stripped:
        return {
            "state": "unknown",
            "confidence": 0.1,
            "reason": "empty_screen",
            "source": "pty",
            "provider": provider_name,
        }

    if detect_pi_session_hook_request(text):
        return {
            "state": "waiting_approval",
            "confidence": 0.9,
            "reason": "pi_utility_session_request",
            "source": "pty",
            "provider": provider_name,
        }

    approval_markers = (
        "would you like to make the following edits?",
        "press enter to confirm or esc to cancel",
        "press enter to continue",
        "do you trust the contents of this directory?",
        "yes, proceed",
        "yes, continue",
        "no, quit",
        "no, and tell codex what to do differently",
    )
    if any(marker in lower for marker in approval_markers):
        return {
            "state": "waiting_approval",
            "confidence": 0.86,
            "reason": "interactive_choice_prompt",
            "source": "pty",
            "provider": provider_name,
        }

    busy_markers = (
        "working (",
        "waiting for background terminal",
        "running ",
        "cloning into ",
        "installing ",
        "fetching ",
        "building ",
        "compiling ",
    )
    if any(marker in lower for marker in busy_markers):
        return {
            "state": "busy",
            "confidence": 0.75,
            "reason": "busy_marker",
            "source": "pty",
            "provider": provider_name,
        }

    # Codex prompt line, e.g. "gpt-5.4 low · /mnt/e/project".
    if re.search(r"(?m)^\s*gpt-[\w.\-]+(?:\s+[\w.\-]+)?\s+[·•]\s+/.+\s*$", stripped):
        return {
            "state": "waiting_input",
            "confidence": 0.82,
            "reason": "codex_prompt_returned",
            "source": "pty",
            "provider": provider_name or "codex",
        }

    blocked_markers = (
        "blocked on",
        "waiting on pi",
        "waiting for pi",
        "need user",
        "needs user",
        "need approval",
        "requires approval",
        "cannot continue",
    )
    if any(marker in lower for marker in blocked_markers):
        return {
            "state": "blocked",
            "confidence": 0.7,
            "reason": "blocked_language",
            "source": "pty",
            "provider": provider_name,
        }

    # Claude Code workspace trust dialog — new/untrusted directories show a safety check
    # before starting. PI-managed sessions should auto-accept (the user already chose the cwd).
    if provider_name == "claude" and (
        "yes, i trust this folder" in lower
        or "quick safety check" in lower
        or ("is this a project you created" in lower)
    ):
        return {
            "state": "waiting_approval",
            "confidence": 0.90,
            "reason": "claude_trust_prompt",
            "source": "pty",
            "provider": "claude",
        }

    # Claude Code interactive REPL — box-drawing prompt corners (╭─ / ╰─) are unique to
    # Claude Code's TUI and indicate the input box is rendered and waiting for input.
    if provider_name == "claude" and ("╰─" in stripped or "╭─" in stripped):
        return {
            "state": "waiting_input",
            "confidence": 0.85,
            "reason": "claude_repl_prompt",
            "source": "pty",
            "provider": "claude",
        }

    return {
        "state": "unknown",
        "confidence": 0.35,
        "reason": "no_provider_signal",
        "source": "pty",
        "provider": provider_name,
    }


def add_provider_state_stability(
    job_state: dict[str, Any],
    provider_state: dict[str, Any],
    screen: str,
) -> dict[str, Any]:
    """Attach screen stability so fallback detectors do not spam idle nudges."""
    now = time.time()
    fingerprint = screen_fingerprint(screen)
    if job_state.get("providerStateFingerprint") != fingerprint:
        job_state["providerStateFingerprint"] = fingerprint
        job_state["providerStateChangedAt"] = now
    changed_at = float(job_state.get("providerStateChangedAt") or now)
    return {
        **provider_state,
        "stableForSeconds": round(max(0.0, now - changed_at), 1),
    }


def tmux_send_input(session_name: str, text: str, submit: bool = True) -> bool:
    if text:
        literal = subprocess.run(
            ["tmux", "send-keys", "-t", session_name, "-l", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if literal.returncode != 0:
            return False
    if submit:
        # Codex's TUI reliably treats carriage return as submit inside tmux.
        # tmux's named "Enter" key can leave text sitting in the composer.
        if text:
            time.sleep(0.05)
        enter = subprocess.run(
            ["tmux", "send-keys", "-t", session_name, "C-m"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return enter.returncode == 0
    return True


def tmux_send_key(session_name: str, key: str) -> bool:
    tmux_key = {"escape": "Escape"}.get(key)
    if not tmux_key:
        return False
    result = subprocess.run(
        ["tmux", "send-keys", "-t", session_name, tmux_key],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def codex_sessions_root() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home).expanduser() / "sessions"
    return Path.home() / ".codex" / "sessions"


def session_id_from_path(path: Path) -> str:
    stem = path.stem
    if len(stem) >= 36:
        candidate = stem[-36:]
        if candidate.count("-") == 4:
            return candidate
    return stem


def compact_text(text: str, limit: int = 180) -> str:
    compacted = " ".join(text.split())
    if len(compacted) <= limit:
        return compacted
    return compacted[: limit - 1].rstrip() + "..."


def text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                value = item.get("text") or item.get("input_text") or item.get("output_text")
                if isinstance(value, str):
                    parts.append(value)
        return "\n".join(parts)
    if isinstance(content, dict):
        value = content.get("text") or content.get("input_text") or content.get("output_text")
        return value if isinstance(value, str) else ""
    return ""


def is_session_noise(text: str) -> bool:
    lower = text.lower()
    noise_markers = [
        "# agents.md instructions",
        "<environment_context>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<skills_instructions>",
        "pi approval channel is available",
        "you are an ai coding agent managed by the agent orchestrator",
        "you are codex, a coding agent",
        "full project context, architecture, conventions",
        "filesystem sandboxing defines",
        "approval policy is currently",
    ]
    return any(marker in lower for marker in noise_markers)


def session_preview_data(path: Path) -> tuple[str | None, str | None, int, str | None]:
    task_preview: str | None = None
    last_activity_preview: str | None = None
    event_count = 0
    model: str | None = None
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            event_count += 1
            try:
                event = json.loads(line)
            except Exception:
                continue
            payload = event.get("payload", {}) if isinstance(event, dict) else {}
            if isinstance(payload, dict) and not model and isinstance(payload.get("model"), str):
                model = payload.get("model")
            if not isinstance(payload, dict):
                continue

            text = ""
            if payload.get("type") == "message":
                text = compact_text(text_from_content(payload.get("content")))
                if payload.get("role") == "user" and text and not is_session_noise(text) and task_preview is None:
                    task_preview = text
            elif event.get("type") == "event_msg" and isinstance(payload.get("message"), str):
                text = compact_text(payload.get("message", ""))

            if text and not is_session_noise(text):
                last_activity_preview = text

    return task_preview, last_activity_preview, event_count, model


def collect_codex_session_history(limit: int = 12) -> list[dict[str, Any]]:
    root = codex_sessions_root()
    if not root.exists():
        return []

    sessions: list[dict[str, Any]] = []
    for path in root.rglob("*.jsonl"):
        try:
            stat = path.stat()
            first_line = path.open("r", encoding="utf-8", errors="replace").readline()
            first_event = json.loads(first_line) if first_line else {}
            payload = first_event.get("payload", {}) if isinstance(first_event, dict) else {}
            if not isinstance(payload, dict):
                payload = {}
            session_id = str(payload.get("id") or session_id_from_path(path))
            message_preview, last_activity_preview, event_count, model = session_preview_data(path)
            sessions.append(
                {
                    "sessionId": session_id,
                    "label": path.stem,
                    "path": str(path),
                    "messagePreview": message_preview,
                    "lastActivityPreview": last_activity_preview,
                    "cwd": payload.get("cwd"),
                    "createdAt": payload.get("timestamp") or first_event.get("timestamp"),
                    "updatedAt": iso_from_timestamp(stat.st_mtime),
                    "source": payload.get("source") or payload.get("originator"),
                    "cliVersion": payload.get("cli_version"),
                    "model": model,
                    "eventCount": event_count,
                }
            )
        except Exception:
            continue

    sessions.sort(key=lambda entry: str(entry.get("updatedAt") or ""), reverse=True)
    return sessions[:limit]


def collect_auth_connectors() -> list[dict[str, Any]]:
    global _auth_connector_cache
    now = time.monotonic()
    if _auth_connector_cache and now - _auth_connector_cache[0] < AUTH_CONNECTOR_CACHE_SECONDS:
        return [dict(connector) for connector in _auth_connector_cache[1]]

    connectors: list[dict[str, Any]] = []
    gh_path = shutil.which("gh")
    if not gh_path:
        connectors.append(
            {
                "connectorId": "github-cli",
                "kind": "github",
                "label": "GitHub CLI",
                "status": "missing",
                "detail": "gh is not installed on this machine.",
                "checkedAt": iso_now(),
            }
        )
        _auth_connector_cache = (now, connectors)
        return [dict(connector) for connector in connectors]

    try:
        result = subprocess.run(
            ["gh", "auth", "status", "--hostname", "github.com"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
            check=False,
        )
        output = "\n".join(part for part in [result.stdout, result.stderr] if part).strip()
        compact = compact_text(output, 220)
        account: str | None = None
        for line in output.splitlines():
            marker = "Logged in to github.com account "
            if marker in line:
                account = line.split(marker, 1)[1].split()[0].strip()
                break
        connectors.append(
            {
                "connectorId": "github-cli",
                "kind": "github",
                "label": "GitHub CLI",
                "status": "connected" if result.returncode == 0 else "disconnected",
                "detail": compact or ("Ready" if result.returncode == 0 else "Run gh auth login on this machine."),
                "account": account,
                "checkedAt": iso_now(),
            }
        )
    except Exception as exc:
        connectors.append(
            {
                "connectorId": "github-cli",
                "kind": "github",
                "label": "GitHub CLI",
                "status": "unknown",
                "detail": compact_text(str(exc), 160),
                "checkedAt": iso_now(),
            }
        )
    _auth_connector_cache = (now, connectors)
    return [dict(connector) for connector in connectors]


def should_allocate_pty(command: list[str]) -> bool:
    joined = " ".join(command)
    return " vi_agent.cli codex" in joined or " vi_agent.cli claude" in joined


def command_with_optional_pty(command: list[str]) -> list[str]:
    if not should_allocate_pty(command):
        return command
    if not shutil.which("script"):
        return command
    return ["script", "-qfec", shlex.join(command), "/dev/null"]


def request_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    data = None
    headers = dict(extra_headers or {})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict) and payload.get("shouldStop"):
                return payload
            raise RuntimeError(payload.get("error") or f"Request failed ({exc.code})") from exc
        except json.JSONDecodeError:
            raise RuntimeError(f"Request failed ({exc.code}): {raw}") from exc


def env_or(args: argparse.Namespace, key: str, env_key: str, default: str | None = None) -> str | None:
    value = getattr(args, key, None)
    if value:
        return value
    value = os.environ.get(env_key)
    if value:
        return value
    return default


# ---------------------------------------------------------------------------
# Claude Code PreToolUse hook installation
# ---------------------------------------------------------------------------

# Tools that need VI approval routing via the hook
_CLAUDE_HOOK_TOOL_MATCHER = "Write|Edit|MultiEdit|Bash|NotebookEdit"

# permissions.allow entries that bypass the native "Do you want to proceed?"
# prompt for every tool in the matcher.  The PreToolUse hook (vi-approve) is
# the actual gate; the native prompt must be suppressed so it never fires first.
_CLAUDE_HOOK_ALLOWED_TOOLS = [
    "Bash(*)",
    "Write(*)",
    "Edit(*)",
    "MultiEdit(*)",
    "NotebookEdit(*)",
]

# Timeout for the hook process: 1 hour in ms (allows time for human approval)
_CLAUDE_HOOK_TIMEOUT_MS = 3_600_000


def _claude_approval_hooks_enabled() -> bool:
    """Return True only when VI_ENABLE_CLAUDE_APPROVAL_HOOKS=1 is explicitly set.
    Default is disabled — the Claude Code hook system is not yet reliable enough
    for production use (hooks are killed after ~2-3 seconds by Claude Code 2.1.138+).
    """
    return os.environ.get("VI_ENABLE_CLAUDE_APPROVAL_HOOKS", "0").strip() == "1"


def _inject_skip_permissions(command: list[str]) -> list[str]:
    """Insert --dangerously-skip-permissions right after the binary name in a Claude command.
    Position matters: Claude Code must see the flag before any positional arguments.
    Only called when approval hooks are disabled and permission mode is always_allow.
    """
    if not command or "--dangerously-skip-permissions" in command:
        return list(command)
    return [command[0], "--dangerously-skip-permissions", *command[1:]]


def _find_pi_approve() -> str:
    """Return the vi-approve executable path, falling back to python -m invocation."""
    found = shutil.which("vi-approve")
    if found:
        return found
    return f"{sys.executable} -m vi_agent.hooks.pi_approve"


def install_claude_hook(cwd: str) -> None:
    """Write/merge hook config + permissions into <cwd>/.claude/settings.json.

    Writes two things:
      1. PreToolUse hook → vi-approve (the actual permission gate).
         Claude Code runs the hook BEFORE evaluating permission rules, so the
         hook fires for every matched tool call regardless of what the allow
         list says.  Exit 0 = proceed; exit 2 + JSON reason = block.

      2. permissions.allow → all gated tools.
         After the hook exits 0, Claude Code checks the allow list.  Having the
         tool in allow suppresses the native "Do you want to proceed?" prompt
         that would otherwise appear as a second confirmation after the hook
         already approved.  This is NOT a bypass of the hook — it only
         prevents the redundant terminal prompt.

    Important: do NOT launch Claude with --dangerously-skip-permissions.
    That flag bypasses the hook entirely; the hook never fires and PI never
    sees the approval request.  permissions.allow is the correct mechanism
    for suppressing the terminal prompt while keeping the hook active.

    Called before launching any Claude Code session managed by vi-agent.
    """
    claude_dir = Path(cwd) / ".claude"
    settings_path = claude_dir / "settings.json"
    claude_dir.mkdir(parents=True, exist_ok=True)

    hook_command = _find_pi_approve()
    hook_entry = {
        "type": "command",
        "command": hook_command,
        "timeout": _CLAUDE_HOOK_TIMEOUT_MS,
    }
    new_hook_block = {
        "matcher": _CLAUDE_HOOK_TOOL_MATCHER,
        "hooks": [hook_entry],
    }

    # Read existing settings, preserving any other config the user has
    existing: dict[str, Any] = {}
    if settings_path.exists():
        try:
            with settings_path.open() as f:
                existing = json.load(f)
        except Exception:
            existing = {}

    # --- PreToolUse hook ---
    hooks = existing.setdefault("hooks", {})
    pre_tool = hooks.setdefault("PreToolUse", [])

    # Remove any stale vi-approve entry (identified by command containing vi-approve or pi_approve)
    pre_tool = [
        block for block in pre_tool
        if not any(
            "vi-approve" in h.get("command", "") or "pi_approve" in h.get("command", "")
            for h in block.get("hooks", [])
        )
    ]
    pre_tool.append(new_hook_block)
    hooks["PreToolUse"] = pre_tool
    existing["hooks"] = hooks

    # --- permissions.allow: bypass native prompt so the hook is the sole gate ---
    permissions = existing.setdefault("permissions", {})
    allowed: list[str] = permissions.setdefault("allow", [])
    for tool_perm in _CLAUDE_HOOK_ALLOWED_TOOLS:
        if tool_perm not in allowed:
            allowed.append(tool_perm)

    with settings_path.open("w") as f:
        json.dump(existing, f, indent=2)
        f.write("\n")


def require(value: str | None, label: str) -> str:
    if not value:
        raise RuntimeError(f"Missing required value: {label}")
    return value


def slugify(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value)
    collapsed = "-".join(part for part in cleaned.split("-") if part)
    return collapsed or "default"


def default_state_file_from_values(project: str, tool: str, display_name: str) -> str:
    base_dir = Path.home() / ".config" / "vi-agent"
    name_parts = [project, tool, display_name]
    filename = f"{'-'.join(slugify(part) for part in name_parts)}.json"
    return str(base_dir / filename)


def default_state_file(args: argparse.Namespace) -> str:
    return default_state_file_from_values(
        env_or(args, "project", "VI_AGENT_PROJECT", "default-project") or "default-project",
        env_or(args, "tool", "VI_AGENT_TOOL", "agent") or "agent",
        env_or(args, "display_name", "VI_AGENT_DISPLAY_NAME", "remote") or "remote",
    )


def resolve_state_file(args: argparse.Namespace) -> Path:
    explicit = env_or(args, "state_file", "VI_AGENT_STATE_FILE")
    path = Path(explicit) if explicit else Path(default_state_file(args))
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def pid_file_path(state_path: Path) -> Path:
    return state_path.with_suffix(".pid")


def log_file_path(state_path: Path) -> Path:
    return state_path.with_suffix(".log")


# ── Debug logging ──────────────────────────────────────────────────────────────

_DEBUG_LOG_PATH = Path.home() / ".config" / "vi-agent" / "debug.log"

# Env var names whose values should be redacted in debug output.
_SECRET_KEY_RE = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.IGNORECASE)

# Env vars relevant to Claude/Codex that we include in debug child-env snapshots.
_RELEVANT_ENV_PREFIXES = ("ANTHROPIC_", "CLAUDE_", "OPENAI_", "VI_", "CODEX_")
_RELEVANT_ENV_KEYS = {"PATH", "HOME", "USER", "SHELL", "TERM"}


def _redact_value(key: str, value: str) -> str:
    return "<redacted>" if _SECRET_KEY_RE.search(key) else value


def _sanitize_env(env: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, val in sorted(env.items()):
        if key in _RELEVANT_ENV_KEYS or any(key.startswith(p) for p in _RELEVANT_ENV_PREFIXES):
            out[key] = _redact_value(key, val)
    return out


class DebugLogger:
    """Structured debug logger for vi-agent foreground mode.

    Writes JSON-lines to stdout and appends to ~/.config/vi-agent/debug.log.
    Instantiate with enabled=False (the default) and all methods become no-ops.
    """

    def __init__(self, enabled: bool = False) -> None:
        self.enabled = enabled
        self._handle = None
        if enabled:
            _DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            self._handle = _DEBUG_LOG_PATH.open("a", encoding="utf-8")
            self._emit("debug_session_start", logFile=str(_DEBUG_LOG_PATH))

    def log(self, event: str, **data: Any) -> None:
        if not self.enabled:
            return
        self._emit(event, **data)

    def _emit(self, event: str, **data: Any) -> None:
        entry = {"ts": iso_now(), "event": event, **data}
        line = json.dumps(entry, default=str)
        print(f"[debug] {line}", flush=True)
        if self._handle:
            try:
                self._handle.write(line + "\n")
                self._handle.flush()
            except OSError:
                pass

    def close(self) -> None:
        if self._handle:
            try:
                self._handle.close()
            except OSError:
                pass
            self._handle = None


_claude_info_cache: dict[str, Any] | None = None


def _claude_debug_info(cwd: str | None = None) -> dict[str, Any]:
    """Return cached Claude binary + env + settings info for debug output.

    Runs `claude --version` once and caches the result for the process lifetime.
    Reading claude settings.json is per-call (cwd-dependent).
    """
    global _claude_info_cache
    if _claude_info_cache is None:
        claude_bin = shutil.which("claude")
        version: str | None = None
        if claude_bin:
            try:
                r = subprocess.run(
                    [claude_bin, "--version"],
                    capture_output=True, text=True, timeout=5,
                )
                version = (r.stdout or r.stderr).strip().splitlines()[0] if r.returncode == 0 else "error"
            except Exception as exc:
                version = f"error: {exc}"
        _claude_info_cache = {"binary": claude_bin, "version": version}

    env = os.environ
    info: dict[str, Any] = dict(_claude_info_cache)

    # Claude Code model env vars (these override the configured default)
    info["envModel"] = {
        "ANTHROPIC_MODEL": env.get("ANTHROPIC_MODEL"),
        "ANTHROPIC_DEFAULT_SONNET_MODEL": env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        "ANTHROPIC_DEFAULT_OPUS_MODEL": env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
        "ANTHROPIC_AVI_KEY": "present" if env.get("ANTHROPIC_AVI_KEY") else "not set",
    }

    # Claude settings.json model config (project-level then global)
    settings_model: str | None = None
    settings_sources: list[str] = []
    for settings_dir in filter(None, [
        cwd and str(Path(cwd) / ".claude"),
        env.get("CLAUDE_CONFIG_DIR"),
        str(Path.home() / ".claude"),
    ]):
        p = Path(settings_dir) / "settings.json"
        if p.exists():
            try:
                cfg = json.loads(p.read_text(encoding="utf-8"))
                m = cfg.get("model")
                if m and not settings_model:
                    settings_model = str(m)
                settings_sources.append(f"{p}: model={m!r}")
            except Exception:
                settings_sources.append(f"{p}: (parse error)")

    info["settingsModel"] = settings_model
    info["settingsSources"] = settings_sources
    return info


# ── /Debug logging ─────────────────────────────────────────────────────────────


def load_state_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}


def nested_get(payload: dict[str, Any], *keys: str) -> Any:
    current: Any = payload
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def load_paired_config(path: Path) -> dict[str, Any]:
    paired = load_state_file(path).get("pairedConfig")
    return paired if isinstance(paired, dict) else {}


def config_value(
    args: argparse.Namespace,
    key: str,
    env_key: str,
    *,
    state_path: Path | None = None,
    paired_key: str | None = None,
    default: str | None = None,
) -> str | None:
    value = getattr(args, key, None)
    if value:
        return value

    env_value = os.environ.get(env_key)
    if env_value:
        return env_value

    if state_path is not None and paired_key:
        state = load_state_file(state_path)
        paired_value = nested_get(load_paired_config(state_path), *paired_key.split("."))
        if isinstance(paired_value, str) and paired_value:
            return paired_value
        agent_value = nested_get(state, "agent", *paired_key.split("."))
        if isinstance(agent_value, str) and agent_value:
            return agent_value

    return default


def write_state_file(path: Path, payload: dict[str, Any]) -> None:
    existing = load_state_file(path)
    if "pairedConfig" not in payload and isinstance(existing.get("pairedConfig"), dict):
        payload["pairedConfig"] = existing["pairedConfig"]
    if "pairedAt" not in payload and isinstance(existing.get("pairedAt"), str):
        payload["pairedAt"] = existing["pairedAt"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def update_state_file(path: Path, **updates: Any) -> dict[str, Any]:
    current = load_state_file(path)
    current.update({key: value for key, value in updates.items() if value is not None})
    write_state_file(path, current)
    return current


def read_pid(path: Path) -> int | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        return int(raw) if raw else None
    except (FileNotFoundError, ValueError):
        return None


def process_is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def remove_file_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def normalize_remainder_command(raw: list[str] | None) -> list[str]:
    command = list(raw or [])
    if command and command[0] == "--":
        return command[1:]
    return command


def command_for_display(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def normalize_bridge_command(command: list[str]) -> list[str]:
    if command and command[0] == "vi-agent":
        return [sys.executable, "-m", "vi_agent.cli", *command[1:]]
    return command


def classify_command_event(command_text: str | None) -> str:
    normalized = (command_text or "").strip().lower()
    if not normalized:
        return "generic"
    if (
        normalized.startswith("wget ")
        or normalized.startswith("curl ")
        or " http://" in normalized
        or " https://" in normalized
    ):
        return "network_access"
    if (
        normalized.startswith("npm install")
        or normalized.startswith("pnpm add")
        or normalized.startswith("yarn add")
        or normalized.startswith("pip install")
        or normalized.startswith("uv pip install")
        or normalized.startswith("brew install")
        or normalized.startswith("apt install")
        or normalized.startswith("apt-get install")
        or normalized.startswith("docker pull")
    ):
        return "dependency_install"
    if normalized.startswith("git push"):
        return "git_push"
    if (
        normalized.startswith("rm ")
        or normalized.startswith("rm -")
        or normalized.startswith("del ")
        or normalized.startswith("rmdir ")
        or normalized.startswith("remove-item ")
    ):
        return "delete_operation"
    return "command"


def serialize_service_status(args: argparse.Namespace) -> dict[str, Any]:
    state_path = resolve_state_file(args)
    pid_path = pid_file_path(state_path)
    log_path = log_file_path(state_path)
    pid = read_pid(pid_path)
    state = load_state_file(state_path)
    return {
        "running": process_is_alive(pid),
        "pid": pid,
        "stateFile": str(state_path),
        "pidFile": str(pid_path),
        "logFile": str(log_path),
        "state": state,
    }


def serialize_bridge_context(args: argparse.Namespace) -> dict[str, Any]:
    state_path = resolve_state_file(args)
    state = load_state_file(state_path)
    agent = state.get("agent", {})
    paired = load_paired_config(state_path)
    return {
        "server": config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
        "stateFile": str(state_path),
        "agentId": agent.get("agentId"),
        "displayName": agent.get("displayName")
        or config_value(args, "display_name", "VI_AGENT_DISPLAY_NAME", state_path=state_path, paired_key="displayName"),
        "project": agent.get("projectLabel")
        or config_value(args, "project", "VI_AGENT_PROJECT", state_path=state_path, paired_key="projectLabel"),
        "tool": agent.get("toolType")
        or config_value(args, "tool", "VI_AGENT_TOOL", state_path=state_path, paired_key="toolType"),
        "host": agent.get("hostLabel")
        or config_value(args, "host", "VI_AGENT_HOST", state_path=state_path, paired_key="hostLabel"),
        "repoRoot": agent.get("repoRoot")
        or config_value(args, "repo_root", "VI_AGENT_REPO_ROOT", state_path=state_path, paired_key="repoRoot"),
        "worktree": agent.get("worktree")
        or config_value(args, "worktree", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree"),
        "status": agent.get("status")
        or config_value(args, "status", "VI_AGENT_STATUS", state_path=state_path, paired_key="status"),
        "permissionMode": agent.get("permissionMode"),
        "timeoutSeconds": agent.get("timeoutSeconds"),
        "lastSeenAt": agent.get("lastSeenAt"),
        "relayUrl": nested_get(paired, "relay", "url"),
    }


def resolve_agent_id(args: argparse.Namespace) -> str:
    direct = env_or(args, "agent_id", "VI_AGENT_ID")
    if direct:
        return direct

    state = load_state_file(resolve_state_file(args))
    agent_id = state.get("agent", {}).get("agentId")
    if isinstance(agent_id, str) and agent_id:
        return agent_id

    raise RuntimeError("Missing required value: --agent-id (or provide a state file with a registered daemon identity)")


def relay_http_base(args: argparse.Namespace) -> str | None:
    relay_url = config_value(
        args,
        "relay_url",
        "VI_RELAY_URL",
        state_path=resolve_state_file(args),
        paired_key="relay.url",
    )
    if not relay_url:
        return None
    trimmed = relay_url.rstrip("/")
    if trimmed.startswith("ws://"):
        trimmed = "http://" + trimmed[len("ws://") :]
    elif trimmed.startswith("wss://"):
        trimmed = "https://" + trimmed[len("wss://") :]
    if trimmed.endswith("/ws"):
        trimmed = trimmed[: -len("/ws")]
    return trimmed.rstrip("/")


def relay_headers(args: argparse.Namespace) -> dict[str, str] | None:
    token = config_value(
        args,
        "relay_token",
        "VI_RELAY_TOKEN",
        state_path=resolve_state_file(args),
        paired_key="relay.token",
    )
    if not token:
        return None
    return {"Authorization": f"Bearer {token}"}


class RelayClient:
    def __init__(self, relay_url: str, relay_token: str, peer_id: str, label: str | None = None):
        if websocket is None:
            raise RuntimeError(
                "Relay support requires websocket-client. Reinstall vi-agent so the relay dependency is available."
            )
        self.relay_url = normalize_relay_url(relay_url)
        self.relay_token = relay_token
        self.peer_id = peer_id
        self.label = label
        self.socket: Any | None = None
        self._messages: deque[dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._running = False

    def connect(self) -> dict[str, Any]:
        self.socket = websocket.create_connection(self.relay_url, timeout=15)
        self.socket.settimeout(1.0)
        self.send(
            {
                "type": "hello",
                "sentAt": iso_now(),
                "payload": {
                    "peerId": self.peer_id,
                    "kind": "daemon",
                    "label": self.label,
                    "token": self.relay_token,
                },
            }
        )
        raw = self.socket.recv()
        message = json.loads(raw)
        if message.get("type") != "hello_ack":
            payload = message.get("payload") or {}
            raise RuntimeError(payload.get("message") or "Relay did not acknowledge daemon hello")
        self._running = True
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()
        return message

    def send(self, payload: dict[str, Any]) -> None:
        if not self.socket:
            raise RuntimeError("Relay socket is not connected")
        self.socket.send(json.dumps(payload))

    def heartbeat(self) -> dict[str, Any]:
        self.send(
            {
                "type": "heartbeat",
                "from": self.peer_id,
                "sentAt": iso_now(),
                "payload": {"peerId": self.peer_id},
            }
        )
        return {"ok": True}

    def _reader_loop(self) -> None:
        if not self.socket:
            return
        while self._running and self.socket is not None:
            try:
                raw = self.socket.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException:
                break
            except Exception:
                break

            if not raw:
                continue

            try:
                message = json.loads(raw)
            except Exception:
                continue

            with self._lock:
                self._messages.append(message)

    def drain_messages(self) -> list[dict[str, Any]]:
        with self._lock:
            drained = list(self._messages)
            self._messages.clear()
        return drained

    def close(self) -> None:
        self._running = False
        if self.socket is not None:
            try:
                self.socket.close()
            except Exception:
                pass
            self.socket = None
        if self._reader is not None:
            self._reader.join(timeout=1.0)
            self._reader = None


def register_agent(args: argparse.Namespace) -> dict[str, Any]:
    state_path = resolve_state_file(args)
    state = load_state_file(state_path)
    tool_type = require(
        config_value(args, "tool", "VI_AGENT_TOOL", state_path=state_path, paired_key="toolType"),
        "--tool",
    )
    payload = {
        "agentId": env_or(args, "agent_id", "VI_AGENT_ID"),
        "displayName": require(
            config_value(args, "display_name", "VI_AGENT_DISPLAY_NAME", state_path=state_path, paired_key="displayName"),
            "--display-name",
        ),
        "projectLabel": require(
            config_value(args, "project", "VI_AGENT_PROJECT", state_path=state_path, paired_key="projectLabel"),
            "--project",
        ),
        "toolType": tool_type,
        "hostLabel": config_value(
            args,
            "host",
            "VI_AGENT_HOST",
            state_path=state_path,
            paired_key="hostLabel",
            default=socket.gethostname(),
        ),
        "repoRoot": config_value(
            args,
            "repo_root",
            "VI_AGENT_REPO_ROOT",
            state_path=state_path,
            paired_key="repoRoot",
            default=os.getcwd(),
        ),
        "branch": config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
        "worktree": config_value(
            args,
            "worktree",
            "VI_AGENT_WORKTREE",
            state_path=state_path,
            paired_key="worktree",
            default=os.getcwd(),
        ),
        "status": config_value(
            args,
            "status",
            "VI_AGENT_STATUS",
            state_path=state_path,
            paired_key="status",
            default="running",
        ),
        "connectionState": state.get("connectionState", "connected"),
        "consecutiveFailures": state.get("consecutiveFailures", 0),
        "lastError": state.get("lastError"),
        "nextRetryAt": state.get("nextRetryAt"),
        "relay": state.get("relay"),
        "stateFile": str(state_path),
        "logFile": str(log_file_path(state_path)),
        "sessionHistory": collect_codex_session_history() if "codex" in tool_type.lower() else [],
        "authConnectors": collect_auth_connectors(),
    }
    relay_base = relay_http_base(args)
    if relay_base and relay_headers(args):
        return request_json(
            f"{relay_base}/v1/daemon/register",
            method="POST",
            payload=payload,
            extra_headers=relay_headers(args),
        )

    server = normalize_server(
        require(config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"), "--server")
    )
    return request_json(f"{server}/api/remote-agents/register", method="POST", payload=payload)


def heartbeat_agent(args: argparse.Namespace) -> dict[str, Any]:
    state_path = resolve_state_file(args)
    state = load_state_file(state_path)
    tool_type = config_value(args, "tool", "VI_AGENT_TOOL", state_path=state_path, paired_key="toolType") or ""
    payload = {
        "agentId": resolve_agent_id(args),
        "status": config_value(args, "status", "VI_AGENT_STATUS", state_path=state_path, paired_key="status"),
        "branch": config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
        "worktree": config_value(
            args,
            "worktree",
            "VI_AGENT_WORKTREE",
            state_path=state_path,
            paired_key="worktree",
            default=os.getcwd(),
        ),
        "repoRoot": config_value(
            args,
            "repo_root",
            "VI_AGENT_REPO_ROOT",
            state_path=state_path,
            paired_key="repoRoot",
            default=os.getcwd(),
        ),
        "connectionState": state.get("connectionState", "connected"),
        "consecutiveFailures": state.get("consecutiveFailures", 0),
        "lastError": state.get("lastError"),
        "nextRetryAt": state.get("nextRetryAt"),
        "relay": state.get("relay"),
        "stateFile": str(state_path),
        "logFile": str(log_file_path(state_path)),
        "sessionHistory": collect_codex_session_history() if "codex" in tool_type.lower() else [],
        "authConnectors": collect_auth_connectors(),
    }
    relay_base = relay_http_base(args)
    if relay_base and relay_headers(args):
        return request_json(
            f"{relay_base}/v1/daemon/heartbeat",
            method="POST",
            payload=payload,
            extra_headers=relay_headers(args),
        )

    server = normalize_server(
        require(config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"), "--server")
    )
    return request_json(f"{server}/api/remote-agents/heartbeat", method="POST", payload=payload)


def poll_agent(args: argparse.Namespace) -> dict[str, Any]:
    agent_id = urllib.parse.quote(resolve_agent_id(args))
    relay_base = relay_http_base(args)
    if relay_base and relay_headers(args):
        return request_json(
            f"{relay_base}/v1/daemon/agents/{agent_id}/poll",
            extra_headers=relay_headers(args),
        )

    server = normalize_server(
        require(
            config_value(args, "server", "VI_SERVER", state_path=resolve_state_file(args), paired_key="server"),
            "--server",
        )
    )
    return request_json(f"{server}/api/remote-agents/agents/{agent_id}/poll")


def report_job(args: argparse.Namespace, job_id: str, status: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "agentId": resolve_agent_id(args),
        "jobId": job_id,
        "status": status,
        **{key: value for key, value in extra.items() if value is not None},
    }
    relay_base = relay_http_base(args)
    if relay_base and relay_headers(args):
        return request_json(
            f"{relay_base}/v1/daemon/jobs/report",
            method="POST",
            payload=payload,
            extra_headers=relay_headers(args),
        )

    server = normalize_server(
        require(
            config_value(args, "server", "VI_SERVER", state_path=resolve_state_file(args), paired_key="server"),
            "--server",
        )
    )
    return request_json(f"{server}/api/remote-agents/jobs/report", method="POST", payload=payload)


def handoff_update(args: argparse.Namespace) -> dict[str, Any]:
    job_id = require(
        config_value(args, "job_id", "VI_REMOTE_JOB_ID", state_path=resolve_state_file(args), paired_key=None),
        "--job-id",
    )
    if not handoff_enabled():
        return report_job(args, job_id, "running")
    artifact_dir_value = config_value(args, "session_dir", "VI_SESSION_DIR", state_path=resolve_state_file(args), paired_key=None)
    artifact_dir = Path(artifact_dir_value) if artifact_dir_value else None
    now = iso_now()
    existing = load_handoff_state(artifact_dir)

    def repeated(values: list[str] | None) -> list[str]:
        return [value.strip() for value in (values or []) if value and value.strip()]

    state = {
        **existing,
        "updated_at": now,
        "updated_reason": args.reason,
        **({"status": args.handoff_status} if args.handoff_status else {}),
        **({"objective": args.objective.strip()} if args.objective and args.objective.strip() else {}),
        **({"doing": args.doing.strip()} if args.doing and args.doing.strip() else {}),
        **({"resume_prompt": args.resume_prompt.strip()} if args.resume_prompt and args.resume_prompt.strip() else {}),
    }
    for key, values in {
        "next": repeated(args.next),
        "done_recent": repeated(args.done),
        "blockers": repeated(args.blocker),
        "decisions": repeated(args.decision),
    }.items():
        if values:
            current = existing.get(key)
            merged = [*([item for item in current if isinstance(item, str)] if isinstance(current, list) else []), *values]
            state[key] = merged[-5:]
    save_handoff_state(artifact_dir, state)
    sync_handoff_markdown_from_state(artifact_dir, state)
    return report_job(args, job_id, "running", handoffState=state, artifactsDir=str(artifact_dir) if artifact_dir else None)


def request_approval(args: argparse.Namespace) -> dict[str, Any]:
    agent_id = resolve_agent_id(args)
    state_path = resolve_state_file(args)
    server = normalize_server(
        require(config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"), "--server")
    )
    payload = {
        "agentId": agent_id,
        "parentJobId": getattr(args, "parent_job_id", None) or env_or(args, "parent_job_id", "VI_REMOTE_JOB_ID"),
        "title": require(args.title, "--title"),
        "message": require(args.message, "--message"),
        "riskLevel": args.risk or "medium",
        "command": args.command,
        "actionKind": getattr(args, "action_kind", None),
        "suggestedCommand": getattr(args, "suggested_command", None),
        "helperPrompt": getattr(args, "helper_prompt", None),
        "eventType": args.event_type or classify_command_event(args.command),
        "primaryAction": args.primary_action or ("approve" if args.command else "reply"),
    }
    relay_base = relay_http_base(args)
    if relay_base and relay_headers(args):
        created = request_json(
            f"{relay_base}/v1/daemon/requests",
            method="POST",
            payload=payload,
            extra_headers=relay_headers(args),
        )
    else:
        created = request_json(f"{server}/api/remote-agents/requests", method="POST", payload=payload)
    request_id = created["approvalRequest"]["requestId"]

    while True:
        polled = poll_agent(args)
        for bucket in ("pendingRequests", "resolvedRequests"):
            for entry in polled.get(bucket, []):
                if entry.get("requestId") == request_id and entry.get("status") != "open":
                    return entry
        time.sleep(1.5)


def ensure_registered_agent(args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    state_path = resolve_state_file(args)
    state = load_state_file(state_path)
    existing_agent_id = state.get("agent", {}).get("agentId")
    registration_args = argparse.Namespace(**vars(args))
    if existing_agent_id and not getattr(registration_args, "agent_id", None):
        registration_args.agent_id = existing_agent_id

    registration = register_agent(registration_args)
    write_state_file(
        state_path,
        {
            "registeredAt": state.get("registeredAt") or iso_now(),
            "agent": registration.get("agent", {}),
            "lastHeartbeat": None,
            "lastPoll": None,
            "pendingRequests": [],
            "resolvedRequests": [],
            "connectionState": "connected",
            "consecutiveFailures": 0,
            "lastError": None,
            "nextRetryAt": None,
            "pairedConfig": state.get("pairedConfig"),
        },
    )
    return registration, state_path


def pair_bridge(args: argparse.Namespace) -> int:
    server = normalize_server(require(env_or(args, "server", "VI_SERVER"), "--server"))
    code = require(args.code, "--code").strip().upper()
    result = request_json(
        f"{server}/api/remote-agents/enrollments/consume",
        method="POST",
        payload={"code": code},
    )
    config = result.get("config", {})
    if not isinstance(config, dict):
        raise RuntimeError("Enrollment response did not include config")

    explicit_state = env_or(args, "state_file", "VI_AGENT_STATE_FILE")
    if explicit_state:
        state_path = Path(explicit_state)
    else:
        state_path = Path(
            default_state_file_from_values(
                str(config.get("projectLabel") or "default-project"),
                str(config.get("toolType") or "agent"),
                str(config.get("displayName") or "remote"),
            )
        )

    current = load_state_file(state_path)
    current["pairedAt"] = iso_now()
    current["pairedConfig"] = {
        "server": server,
        "displayName": config.get("displayName"),
        "projectLabel": config.get("projectLabel"),
        "toolType": config.get("toolType"),
        "relay": {
            "url": config.get("relayUrl"),
            "token": config.get("relayToken"),
        },
    }
    write_state_file(state_path, current)
    result: dict[str, Any] = {
        "paired": True,
        "stateFile": str(state_path),
        "displayName": config.get("displayName"),
        "projectLabel": config.get("projectLabel"),
        "toolType": config.get("toolType"),
        "nextCommand": f"vi-agent start-daemon --state-file {shlex.quote(str(state_path))}",
    }
    if getattr(args, "start", False):
        start_args = argparse.Namespace(
            server=None,
            agent_id=None,
            display_name=None,
            project=None,
            tool=None,
            host=None,
            repo_root=None,
            branch=None,
            worktree=None,
            status=None,
            state_file=str(state_path),
            relay_url=None,
            relay_token=None,
            heartbeat_ms=getattr(args, "heartbeat_ms", None),
            debug=getattr(args, "debug", False),
        )
        start_exit = start_daemon(start_args)
        result["started"] = start_exit == 0
        result["startExitCode"] = start_exit
    print(json.dumps(result, indent=2))
    return 0


def run_wrapped(args: argparse.Namespace) -> int:
    state_path = resolve_state_file(args)
    server = normalize_server(
        require(config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"), "--server")
    )
    command = normalize_remainder_command(args.command)
    if not command:
        raise RuntimeError("run requires a command after --")

    registration, state_path = ensure_registered_agent(args)
    agent_id = registration["agent"]["agentId"]
    heartbeat_ms = int(env_or(args, "heartbeat_ms", "VI_AGENT_HEARTBEAT_MS", "5000") or "5000")
    interval_s = max(2.0, heartbeat_ms / 1000.0)
    consecutive_failures = 0

    launch_cwd = config_value(args, "cwd", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree", default=os.getcwd()) or os.getcwd()
    launch_tool = config_value(args, "tool", "VI_AGENT_TOOL", state_path=state_path, paired_key="toolType", default="") or ""

    is_claude_command = "claude" in launch_tool.lower() or (command and "claude" in str(command[0]).lower())
    if is_claude_command:
        if _claude_approval_hooks_enabled():
            try:
                install_claude_hook(launch_cwd)
            except Exception as hook_err:
                print(f"[vi-agent] Warning: could not install Claude hook: {hook_err}", file=sys.stderr)
        else:
            # Hooks disabled: inject --dangerously-skip-permissions for always_allow mode
            launch_permission_mode = registration.get("agent", {}).get("permissionMode") or ""
            if launch_permission_mode == "always_allow":
                command = _inject_skip_permissions(list(command))

    process = subprocess.Popen(
        command,
        cwd=launch_cwd,
        env={
            **os.environ,
            "VI_AGENT_ID": agent_id,
            "VI_SERVER": server,
            "VI_AGENT_STATE_FILE": str(state_path),
            "VI_AGENT_DISPLAY_NAME": config_value(args, "display_name", "VI_AGENT_DISPLAY_NAME", state_path=state_path, paired_key="displayName", default="") or "",
            "VI_AGENT_PROJECT": config_value(args, "project", "VI_AGENT_PROJECT", state_path=state_path, paired_key="projectLabel", default="") or "",
            "VI_AGENT_TOOL": launch_tool,
        },
    )

    def sync_provider_heartbeat(status_value: str) -> None:
        nonlocal consecutive_failures
        heartbeat_args = argparse.Namespace(
            server=server,
            agent_id=agent_id,
            status=status_value,
            branch=config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
            worktree=config_value(
                args,
                "worktree",
                "VI_AGENT_WORKTREE",
                state_path=state_path,
                paired_key="worktree",
                default=os.getcwd(),
            ),
            repo_root=config_value(
                args,
                "repo_root",
                "VI_AGENT_REPO_ROOT",
                state_path=state_path,
                paired_key="repoRoot",
                default=os.getcwd(),
            ),
        )
        try:
            heartbeat = heartbeat_agent(heartbeat_args)
            consecutive_failures = 0
            write_state_file(
                state_path,
                {
                    "registeredAt": iso_now(),
                    "agent": heartbeat.get("agent", registration.get("agent", {})),
                    "lastHeartbeat": iso_now(),
                    "lastPoll": None,
                    "pendingRequests": [],
                    "resolvedRequests": [],
                    "connectionState": "connected",
                    "consecutiveFailures": 0,
                    "lastError": None,
                    "nextRetryAt": None,
                },
            )
        except Exception as error:
            consecutive_failures += 1
            update_state_file(
                state_path,
                connectionState="disconnected",
                consecutiveFailures=consecutive_failures,
                lastError=str(error),
            )
            # Do not print provider heartbeat failures into the wrapped CLI's
            # pseudo-terminal. The daemon already reports job status, and
            # writing bridge diagnostics into Codex/Claude output makes PI
            # mistake the agent UI for a broken session.
            return

    status = "running"
    try:
        while True:
            code = process.poll()
            if code is not None:
                status = "completed" if code == 0 else "failed"
                sync_provider_heartbeat(status)
                return code

            sync_provider_heartbeat(status)
            time.sleep(interval_s)
    except KeyboardInterrupt:
        status = "paused"
        process.terminate()
        sync_provider_heartbeat(status)
        return 130


def run_provider(
    args: argparse.Namespace,
    *,
    tool: str,
    binary: str,
    default_display_name: str,
) -> int:
    provider_args = normalize_remainder_command(getattr(args, "provider_args", []))
    command = [getattr(args, "binary", None) or binary, *provider_args]
    payload = argparse.Namespace(**vars(args))
    payload.command = command
    if not getattr(payload, "tool", None):
        payload.tool = tool
    if not getattr(payload, "display_name", None):
        payload.display_name = default_display_name
    return run_wrapped(payload)


def approve_command(args: argparse.Namespace) -> int:
    command = normalize_remainder_command(args.command)
    if not command:
        raise RuntimeError("approve-command requires a command after --")

    command_text = command_for_display(command)
    title = args.title or f"Approve command: {command[0]}"
    message = args.message or f"Allow this command on {socket.gethostname()}?"
    decision = request_approval(
        argparse.Namespace(
            server=env_or(args, "server", "VI_SERVER"),
            agent_id=env_or(args, "agent_id", "VI_AGENT_ID"),
            state_file=env_or(args, "state_file", "VI_AGENT_STATE_FILE"),
            title=title,
            message=message,
            command=command_text,
            risk=args.risk or "medium",
            event_type=classify_command_event(command_text),
            primary_action="approve",
        )
    )

    print(json.dumps({"decision": decision, "command": command_text}, indent=2), file=sys.stderr)
    if decision.get("status") == "rejected":
        return 2

    return subprocess.call(
        command,
        cwd=env_or(args, "cwd", "VI_AGENT_WORKTREE", os.getcwd()),
        env=os.environ.copy(),
    )


def run_daemon(args: argparse.Namespace) -> int:
    dbg = DebugLogger(enabled=getattr(args, "debug", False))
    registration, state_path = ensure_registered_agent(args)
    pid_path = pid_file_path(state_path)
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    agent = registration["agent"]
    agent_id = agent["agentId"]
    heartbeat_ms = int(env_or(args, "heartbeat_ms", "VI_AGENT_HEARTBEAT_MS", "5000") or "5000")
    interval_s = max(2.0, heartbeat_ms / 1000.0)
    seen_resolved: set[str] = set()
    requested_runtime_hooks: set[str] = set()
    handoff_checkpoints: dict[str, dict[str, Any]] = {}
    handoff_idle_seconds = max(60, int(os.environ.get("VI_HANDOFF_IDLE_SECONDS", "600") or "600"))
    launched_jobs: dict[str, dict[str, Any]] = {}
    consecutive_failures = 0
    relay_url = config_value(args, "relay_url", "VI_RELAY_URL", state_path=state_path, paired_key="relay.url")
    relay_token = config_value(args, "relay_token", "VI_RELAY_TOKEN", state_path=state_path, paired_key="relay.token")
    relay_client: RelayClient | None = None
    next_sync_at = 0.0

    # Terminal relay — optional, starts a background thread for PTY-over-WebSocket
    _pi_server = config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server") or ""
    _explicit_terminal_relay_url = config_value(
        args, "terminal_relay_url", "VI_TERMINAL_RELAY_URL", state_path=state_path, paired_key=None
    )
    terminal_relay_url: str | None = (
        derive_terminal_relay_url(_pi_server, _explicit_terminal_relay_url)
        if derive_terminal_relay_url is not None
        else None
    )
    terminal_relay_token: str = relay_token or ""
    terminal_relay_client: Any | None = None
    if terminal_relay_url and TerminalRelayClient is not None:
        terminal_relay_client = TerminalRelayClient(
            relay_url=terminal_relay_url,
            agent_id=agent_id,
            token=terminal_relay_token,
        )
        terminal_relay_client.start()
        print(json.dumps({
            "event": "terminal_relay_starting",
            "agentId": agent_id,
            "url": terminal_relay_url,
        }))

    dbg.log(
        "daemon_startup",
        agentId=agent_id,
        displayName=agent.get("displayName"),
        toolType=agent.get("toolType"),
        hostLabel=agent.get("hostLabel"),
        server=_pi_server,
        relayUrl=terminal_relay_url,
        permissionMode=agent.get("permissionMode"),
        stateFile=str(state_path),
        pid=os.getpid(),
    )

    def refresh_registration() -> None:
        nonlocal registration, agent, agent_id
        registration, _ = ensure_registered_agent(args)
        agent = registration["agent"]
        agent_id = agent["agentId"]
        dbg.log("daemon_reregistered", agentId=agent_id)
        print(json.dumps({"event": "daemon_reregistered", "agentId": agent_id}, indent=2))

    update_state_file(
        state_path,
        registeredAt=load_state_file(state_path).get("registeredAt") or iso_now(),
        agent=agent,
        lastHeartbeat=None,
        lastPoll=None,
        pendingRequests=[],
        resolvedRequests=[],
        pendingJobs=[],
        jobs=[],
        connectionState="connected",
        consecutiveFailures=0,
        lastError=None,
        nextRetryAt=None,
        relay={
            "url": relay_url,
            "peerId": agent_id,
            "connected": False,
            "lastHelloAt": None,
            "lastHeartbeatAt": None,
            "lastError": None,
        },
    )

    print(json.dumps({"event": "daemon_started", "agentId": agent_id, "stateFile": str(state_path)}, indent=2))

    def _handle_stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    def safe_relay_state(state: dict[str, Any]) -> dict[str, Any]:
        relay_state = state.get("relay")
        return relay_state if isinstance(relay_state, dict) else {}

    report_failure_state: dict[str, dict[str, Any]] = {}

    def safe_report_job(job_id: str, status: str, **extra: Any) -> bool:
        failure_key = f"{job_id}:{status}"
        now_ts = time.time()
        failure_state = report_failure_state.get(failure_key)
        if failure_state and now_ts < float(failure_state.get("nextRetryAt", 0)):
            return False
        dbg.log("job_status", jobId=job_id, status=status, **{k: v for k, v in extra.items() if k != "logTail"})
        try:
            response = report_job(args, job_id, status, **extra)
            if isinstance(response, dict) and response.get("shouldStop"):
                dbg.log("job_report_stop_requested", jobId=job_id, status=status)
                launched_jobs.pop(job_id, None)
                return False
            report_failure_state.pop(failure_key, None)
            return True
        except Exception as error:
            count = int((failure_state or {}).get("count", 0)) + 1
            retry_in = min(60.0, max(interval_s, 2.0 ** min(count, 5)))
            report_failure_state[failure_key] = {
                "count": count,
                "nextRetryAt": now_ts + retry_in,
                "error": str(error),
            }
            dbg.log("job_report_failed", jobId=job_id, status=status, error=str(error), count=count, retryIn=retry_in)
            if count in {1, 2, 3} or count % 5 == 0:
                print(
                    json.dumps(
                        {
                            "event": "remote_job_report_failed",
                            "jobId": job_id,
                            "status": status,
                            "error": str(error),
                            "retryInSeconds": round(retry_in, 1),
                        },
                        indent=2,
                    )
                )
            return False

    def request_pi_utility_session_from_runtime(job_id: str, screen: str) -> None:
        detected = detect_pi_session_hook_request(screen)
        if detected is None:
            return
        key = f"{job_id}:{detected['title']}:{detected['command']}"
        if key in requested_runtime_hooks:
            return
        requested_runtime_hooks.add(key)
        payload = {
            "agentId": agent_id,
            "parentJobId": job_id,
            "title": detected["title"],
            "message": detected["message"],
            "riskLevel": detected.get("risk") or "medium",
            "command": None,
            "actionKind": detected.get("actionKind") or "other",
            "suggestedCommand": detected["command"],
            "helperPrompt": "Runtime hook detected a host-side blocker and requested a PI utility session.",
            "eventType": "external_action",
            "primaryAction": "approve",
        }
        try:
            relay_base = relay_http_base(args)
            headers = relay_headers(args)
            if relay_base and headers:
                request_json(
                    f"{relay_base}/v1/daemon/requests",
                    method="POST",
                    payload=payload,
                    extra_headers=headers,
                )
            else:
                server = normalize_server(
                    require(
                        config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
                        "--server",
                    )
                )
                request_json(f"{server}/api/remote-agents/requests", method="POST", payload=payload)
            print(
                json.dumps(
                    {
                        "event": "runtime_pi_session_requested",
                        "jobId": job_id,
                        "title": detected["title"],
                    },
                    indent=2,
                )
            )
        except Exception as error:
            print(
                json.dumps(
                    {
                        "event": "runtime_pi_session_request_failed",
                        "jobId": job_id,
                        "title": detected["title"],
                        "error": str(error),
                    },
                    indent=2,
                )
            )

    def maybe_send_ralph_nudge(
        job_id: str,
        job_state: dict[str, Any],
        job: dict[str, Any],
        provider_state: dict[str, Any],
        screen: str,
    ) -> str | None:
        env = job.get("env") if isinstance(job.get("env"), dict) else {}
        if env.get("VI_RALPH_ENABLED") != "1":
            return None
        if provider_state.get("state") != "waiting_input":
            return None
        if float(provider_state.get("confidence") or 0.0) < 0.75:
            return None
        if float(provider_state.get("stableForSeconds") or 0.0) < 3.0:
            return None
        if job.get("pendingInputs"):
            return None

        now = time.time()
        signature = screen_fingerprint(f"{job_id}:{provider_state.get('reason')}:{screen}")[:24]
        if job_state.get("ralphLastSignature") == signature:
            return None
        if now - float(job_state.get("ralphLastSentAt") or 0.0) < 120:
            return None

        session_name = job_state.get("sessionName")
        if not isinstance(session_name, str) or not session_name:
            return None

        prompt = (
            "Ralph mode: continue autonomously from the current state. "
            "Pick the next useful step, make progress, and only ask PI when you are blocked or need approval."
        )
        if tmux_send_input(session_name, prompt, True):
            job_state["ralphLastSignature"] = signature
            job_state["ralphLastSentAt"] = now
            return prompt
        return None

    def maybe_handoff_checkpoint(
        job_id: str,
        artifact_dir: Path | None,
        *,
        title: str,
        status: str,
        screen: str,
        force_reason: str | None = None,
    ) -> None:
        if artifact_dir is None or not handoff_enabled():
            return
        now = time.time()
        fingerprint = screen_fingerprint(screen)
        checkpoint = handoff_checkpoints.setdefault(
            job_id,
            {
                "fingerprint": fingerprint,
                "changedAt": now,
                "lastCheckpointAt": 0.0,
                "compactFingerprint": None,
            },
        )
        if checkpoint.get("fingerprint") != fingerprint:
            checkpoint["fingerprint"] = fingerprint
            checkpoint["changedAt"] = now

        reason = force_reason
        if reason is None and has_compact_checkpoint_marker(screen) and checkpoint.get("compactFingerprint") != fingerprint:
            reason = "context compact"
            checkpoint["compactFingerprint"] = fingerprint
        if reason is None:
            idle_for = now - float(checkpoint.get("changedAt") or now)
            since_checkpoint = now - float(checkpoint.get("lastCheckpointAt") or 0.0)
            if idle_for >= handoff_idle_seconds and since_checkpoint >= handoff_idle_seconds:
                reason = f"idle {int(idle_for)}s"
        if reason is None:
            return

        checkpoint["lastCheckpointAt"] = now
        refresh_handoff_metadata(
            artifact_dir,
            job_id=job_id,
            title=title,
            status=status,
            updated_at=iso_now(),
            reason=reason,
        )

    def launch_remote_job(job: dict[str, Any]) -> None:
        job_id = job.get("jobId")
        command = job.get("command")
        if not isinstance(job_id, str) or job_id in launched_jobs:
            return
        if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
            safe_report_job(job_id, "failed", error="Remote job command must be a string array")
            return

        jobs_dir = state_path.parent / "jobs"
        jobs_dir.mkdir(parents=True, exist_ok=True)
        log_path = jobs_dir / f"{job_id}.log"
        title = job.get("title") if isinstance(job.get("title"), str) and job.get("title") else job_id
        artifact_dir = ensure_handoff_files(job_id, str(title), jobs_dir)
        cwd = job.get("cwd") if isinstance(job.get("cwd"), str) and job.get("cwd") else os.getcwd()
        Path(cwd).mkdir(parents=True, exist_ok=True)
        child_env = os.environ.copy()
        child_env.update(
            {
                "VI_SERVER": normalize_server(
                    require(
                        config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
                        "--server",
                    )
                ),
                "VI_AGENT_ID": agent_id,
                "VI_AGENT_STATE_FILE": str(state_path),
                "VI_REMOTE_JOB_ID": job_id,
                "VI_HOOK_REQUEST_EXTERNAL": "vi-agent request-external-action",
                "VI_HOOK_REQUEST_SESSION": "vi-agent request-vi-session",
                "VI_SESSION_DIR": str(artifact_dir),
            }
        )
        if handoff_enabled():
            child_env.update(
                {
                    "VI_HOOK_HANDOFF_UPDATE": "vi-agent handoff-update",
                    "VI_HANDOFF_STATE_FILE": str(artifact_dir / "handoff-state.json"),
                    "VI_PROGRESS_FILE": str(artifact_dir / "PROGRESS.md"),
                    "VI_TODO_FILE": str(artifact_dir / "TODO.md"),
                    "VI_NOTES_FILE": str(artifact_dir / "NOTES.md"),
                }
            )
        if isinstance(job.get("env"), dict):
            child_env.update({str(key): str(value) for key, value in job["env"].items()})

        command = normalize_bridge_command(command)
        command_text = " ".join(command).lower()
        provider = (
            "claude"
            if " claude " in f" {command_text} " or command_text.endswith(" claude")
            else "codex"
            if " codex " in f" {command_text} " or command_text.endswith(" codex")
            else str(job.get("toolType") or "unknown")
        )

        # Extract model from provider_args (everything after the "--" separator in the command)
        _sep_idx = next((i for i, p in enumerate(command) if p == "--"), None)
        _provider_args = command[_sep_idx + 1:] if _sep_idx is not None else []
        _model_val: str | None = None
        if "--model" in _provider_args:
            _mi = _provider_args.index("--model")
            if _mi + 1 < len(_provider_args):
                _model_val = _provider_args[_mi + 1]
        # --dangerously-skip-permissions is injected by the inner process for always_allow
        # when hooks are disabled; predict it here from the current permission mode.
        _current_permission_mode = agent.get("permissionMode") or ""
        _skip_perms_predicted = (
            _current_permission_mode == "always_allow" and not _claude_approval_hooks_enabled()
        ) if provider == "claude" else "--dangerously-skip-permissions" in command

        dbg.log(
            "job_received",
            jobId=job_id,
            title=title,
            provider=provider,
            cwd=cwd,
            command=command,
            hasModel=_model_val is not None,
            model=_model_val,
            hasSkipPerms=_skip_perms_predicted,
            permissionMode=_current_permission_mode,
            childEnv=_sanitize_env(child_env),
        )

        if provider == "claude" and dbg.enabled:
            _ci = _claude_debug_info(cwd)
            dbg.log(
                "claude_job",
                jobId=job_id,
                finalCommandOuter=command,
                hasModel=_model_val is not None,
                model=_model_val,
                hasSkipPerms=_skip_perms_predicted,
                permissionMode=_current_permission_mode,
                claudeBinary=_ci.get("binary"),
                claudeVersion=_ci.get("version"),
                envModel=_ci.get("envModel"),
                settingsModel=_ci.get("settingsModel"),
                settingsSources=_ci.get("settingsSources"),
                note=(
                    "ANTHROPIC_MODEL or settingsModel can override --model; "
                    "if an unexpected hardcoded Claude model appears, check envModel and settingsSources above"
                ),
            )

        if provider == "claude":
            if _claude_approval_hooks_enabled():
                try:
                    install_claude_hook(cwd)
                except Exception as hook_err:
                    dbg.log("claude_hook_install_warning", jobId=job_id, error=str(hook_err))
                    print(json.dumps({
                        "event": "claude_hook_install_warning",
                        "jobId": job_id,
                        "error": str(hook_err),
                    }), indent=2)
            # When hooks are disabled, --dangerously-skip-permissions is injected
            # by run_wrapped inside the inner vi-agent process, not here.
            # Injecting here would target the outer vi-agent command, not claude.

        force_interactive = child_env.get("VI_REMOTE_INTERACTIVE") == "1"
        if tmux_available() and (force_interactive or is_interactive_remote_command(command)):
            session_name = tmux_session_name(job_id)
            dbg.log("tmux_session", jobId=job_id, sessionName=session_name, cwd=cwd)
            remote_env = {
                "VI_SERVER": child_env["VI_SERVER"],
                "VI_AGENT_ID": agent_id,
                "VI_AGENT_STATE_FILE": str(state_path),
                "VI_REMOTE_JOB_ID": job_id,
                "VI_HOOK_REQUEST_EXTERNAL": "vi-agent request-external-action",
                "VI_HOOK_REQUEST_SESSION": "vi-agent request-vi-session",
                "VI_SESSION_DIR": str(artifact_dir),
                # Carry the current PATH so vi-approve is findable inside tmux
                # (tmux inherits from the server start environment, not the
                # current shell, so conda/pyenv paths can be missing).
                "PATH": os.environ.get("PATH", ""),
            }
            # Pass relay credentials so the inner vi_agent.cli process can reach
            # the relay for registration and heartbeats (cloud mode).
            _relay_url = child_env.get("VI_RELAY_URL", "")
            _relay_token = child_env.get("VI_RELAY_TOKEN", "")
            if _relay_url:
                remote_env["VI_RELAY_URL"] = _relay_url
            if _relay_token:
                remote_env["VI_RELAY_TOKEN"] = _relay_token
            if handoff_enabled():
                remote_env.update(
                    {
                        "VI_HOOK_HANDOFF_UPDATE": "vi-agent handoff-update",
                        "VI_HANDOFF_STATE_FILE": str(artifact_dir / "handoff-state.json"),
                        "VI_PROGRESS_FILE": str(artifact_dir / "PROGRESS.md"),
                        "VI_TODO_FILE": str(artifact_dir / "TODO.md"),
                        "VI_NOTES_FILE": str(artifact_dir / "NOTES.md"),
                    }
                )
            if isinstance(job.get("env"), dict):
                remote_env.update({str(key): str(value) for key, value in job["env"].items()})
            shell_command = "exec " + " ".join(
                shlex.quote(part)
                for part in [
                    "env",
                    *[f"{key}={value}" for key, value in remote_env.items()],
                    *command,
                ]
            )
            subprocess.run(
                ["tmux", "kill-session", "-t", session_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            result = subprocess.run(
                ["tmux", "new-session", "-d", "-s", session_name, "-c", cwd, shell_command],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if result.returncode != 0:
                safe_report_job(
                    job_id,
                    "failed",
                    error=result.stderr.decode("utf-8", errors="replace") or "Failed to start tmux session",
                    logFile=str(log_path),
                )
                return
            screen = tmux_capture(session_name)
            provider_state = detect_provider_state(screen, provider=provider)
            request_pi_utility_session_from_runtime(job_id, screen)
            maybe_handoff_checkpoint(
                job_id,
                artifact_dir,
                title=str(title),
                status="running",
                screen=screen,
                force_reason="started",
            )
            log_path.write_text(screen, encoding="utf-8", errors="replace")
            # VI_INITIAL_GOAL: clean user prompt injected as /plan for Claude (no hook instructions).
            # VI_INITIAL_PROMPT: legacy fallback for sessions created before VI_INITIAL_GOAL existed.
            _initial_prompt = (
                child_env.get("VI_INITIAL_GOAL", "")
                or child_env.get("VI_INITIAL_PROMPT", "")
            ).strip()
            launched_jobs[job_id] = {
                "kind": "tmux",
                "sessionName": session_name,
                "logPath": log_path,
                "artifactDir": artifact_dir,
                "provider": provider,
                "initialPrompt": _initial_prompt if _initial_prompt else None,
                "initialPromptSent": False,
            }
            safe_report_job(
                job_id,
                "running",
                logFile=str(log_path),
                logTail=screen,
                tmuxSession=session_name,
                providerState=provider_state,
                **handoff_payload(artifact_dir),
            )
            print(
                json.dumps(
                    {
                        "event": "remote_job_started",
                        "jobId": job_id,
                        "tmuxSession": session_name,
                        "command": command,
                        "logFile": str(log_path),
                    },
                    indent=2,
                )
            )
            # Announce this tmux session to the terminal relay so the browser
            # can open a live interactive terminal for this job.
            if terminal_relay_client is not None:
                terminal_relay_client.announce(session_name)
            return

        command = command_with_optional_pty(command)

        try:
            log_handle = log_path.open("ab")
            process = subprocess.Popen(
                command,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                env=child_env,
                start_new_session=(os.name != "nt"),
            )
            log_handle.close()
            launched_jobs[job_id] = {
                "kind": "process",
                "process": process,
                "logPath": log_path,
                "artifactDir": artifact_dir,
            }
            log_tail = tail_text(log_path)
            provider_state = detect_provider_state(log_tail, provider=provider)
            request_pi_utility_session_from_runtime(job_id, log_tail)
            maybe_handoff_checkpoint(
                job_id,
                artifact_dir,
                title=str(title),
                status="running",
                screen=log_tail,
                force_reason="started",
            )
            safe_report_job(
                job_id,
                "running",
                pid=process.pid,
                logFile=str(log_path),
                logTail=log_tail,
                providerState=provider_state,
                **handoff_payload(artifact_dir),
            )
            print(
                json.dumps(
                    {
                        "event": "remote_job_started",
                        "jobId": job_id,
                        "pid": process.pid,
                        "command": command,
                        "logFile": str(log_path),
                    },
                    indent=2,
                )
            )
        except Exception as error:
            safe_report_job(
                job_id,
                "failed",
                error=str(error),
                logFile=str(log_path),
                logTail=tail_text(log_path),
                **handoff_payload(artifact_dir),
            )

    def send_pending_inputs(job: dict[str, Any], job_state: dict[str, Any]) -> list[str]:
        if job_state.get("kind") != "tmux":
            return []
        inputs = job.get("pendingInputs")
        if not isinstance(inputs, list):
            return []
        job_id = job.get("jobId", "unknown")
        session_name = str(job_state["sessionName"])
        sent_ids: list[str] = []
        for entry in inputs:
            if not isinstance(entry, dict):
                continue
            input_id = entry.get("inputId")
            text = entry.get("text")
            submit = entry.get("submit")
            key = entry.get("key")
            if not isinstance(input_id, str) or not isinstance(text, str):
                continue
            if isinstance(key, str):
                sent = tmux_send_key(session_name, key)
            else:
                sent = tmux_send_input(session_name, text, submit if isinstance(submit, bool) else True)
            print(
                json.dumps(
                    {
                        "event": "input_delivered",
                        "jobId": job_id,
                        "inputId": input_id,
                        "textLength": len(text),
                        "key": key if isinstance(key, str) else None,
                        "status": "sent" if sent else "failed",
                    }
                )
            )
            if sent:
                sent_ids.append(input_id)
        return sent_ids

    try:
        while True:
            try:
                if relay_url and relay_token and relay_client is None:
                    relay_client = RelayClient(
                        relay_url=relay_url,
                        relay_token=relay_token,
                        peer_id=agent_id,
                        label=agent.get("displayName") or env_or(args, "display_name", "VI_AGENT_DISPLAY_NAME"),
                    )
                    relay_client.connect()
                    current_state = load_state_file(state_path)
                    relay_state = safe_relay_state(current_state)
                    relay_state.update(
                        {
                            "url": relay_url,
                            "peerId": agent_id,
                            "connected": True,
                            "lastHelloAt": iso_now(),
                            "lastError": None,
                        }
                    )
                    update_state_file(state_path, relay=relay_state)
            except Exception as error:
                consecutive_failures += 1
                retry_seconds = min(60, max(interval_s, 2**min(consecutive_failures, 5)))
                next_retry_at = time.time() + retry_seconds
                if relay_client is not None:
                    relay_client.close()
                    relay_client = None
                current_state = load_state_file(state_path)
                relay_state = safe_relay_state(current_state)
                relay_state.update(
                    {
                        "url": relay_url,
                        "peerId": agent_id,
                        "connected": False,
                        "lastError": str(error),
                    }
                )
                update_state_file(
                    state_path,
                    connectionState="disconnected",
                    consecutiveFailures=consecutive_failures,
                    lastError=str(error),
                    nextRetryAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(next_retry_at)),
                    relay=relay_state,
                )
                print(
                    json.dumps(
                        {
                            "event": "daemon_connection_error",
                            "agentId": agent_id,
                            "error": str(error),
                            "consecutiveFailures": consecutive_failures,
                            "retryInSeconds": retry_seconds,
                        },
                        indent=2,
                    )
                )
                time.sleep(retry_seconds)
                continue

            heartbeat: dict[str, Any] = {"agent": agent}
            polled: dict[str, Any] = {
                "pendingRequests": [],
                "resolvedRequests": [],
                "pendingJobs": [],
                "jobs": [],
            }

            if time.time() >= next_sync_at:
                try:
                    heartbeat_args = argparse.Namespace(
                        server=config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
                        relay_url=relay_url,
                        relay_token=relay_token,
                        agent_id=agent_id,
                        status=config_value(args, "status", "VI_AGENT_STATUS", state_path=state_path, paired_key="status", default="running"),
                        branch=config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
                        worktree=config_value(args, "worktree", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree", default=os.getcwd()),
                        repo_root=config_value(args, "repo_root", "VI_AGENT_REPO_ROOT", state_path=state_path, paired_key="repoRoot", default=os.getcwd()),
                    )
                    heartbeat = heartbeat_agent(heartbeat_args)
                    if heartbeat.get("shouldStop"):
                        print(json.dumps({
                            "event": "daemon_stop_requested",
                            "agentId": agent_id,
                            "reason": "Agent paused in PI — stop signal received from server",
                        }, indent=2))
                        dbg.log("daemon_stop_requested", agentId=agent_id, reason="paused_in_pi")
                        raise KeyboardInterrupt
                    polled = poll_agent(heartbeat_args)
                    if polled.get("shouldStop"):
                        print(json.dumps({
                            "event": "daemon_stop_requested",
                            "agentId": agent_id,
                            "reason": "Agent removed or disconnected in PI",
                        }, indent=2), flush=True)
                        dbg.log("daemon_stop_requested", agentId=agent_id, reason="poll_should_stop")
                        raise KeyboardInterrupt
                    dbg.log(
                        "heartbeat",
                        agentId=agent_id,
                        permissionMode=heartbeat.get("agent", {}).get("permissionMode"),
                        pendingJobs=len(polled.get("pendingJobs", [])),
                        pendingRequests=len(polled.get("pendingRequests", [])),
                    )
                    for command in polled.get("controlCommands", []):
                        if not isinstance(command, dict):
                            continue
                        if command.get("type") != "restart_daemon":
                            continue
                        print(json.dumps({
                            "event": "daemon_restart_requested",
                            "agentId": agent_id,
                            "commandId": command.get("commandId"),
                            "reason": "Restart connection requested from PI",
                        }, indent=2), flush=True)
                        dbg.log(
                            "daemon_restart_requested",
                            agentId=agent_id,
                            commandId=command.get("commandId"),
                        )
                        dbg.close()
                        if relay_client is not None:
                            relay_client.close()
                            relay_client = None
                        if terminal_relay_client is not None:
                            terminal_relay_client.stop()
                            terminal_relay_client = None
                        restart_args = [
                            sys.executable,
                            __file__,
                            "daemon",
                            "--state-file",
                            str(state_path),
                            "--heartbeat-ms",
                            str(heartbeat_ms),
                        ]
                        os.execv(sys.executable, restart_args)
                    if relay_client is not None:
                        relay_client.heartbeat()
                        current_state = load_state_file(state_path)
                        relay_state = safe_relay_state(current_state)
                        relay_state.update(
                            {
                                "url": relay_url,
                                "peerId": agent_id,
                                "connected": True,
                                "lastHeartbeatAt": iso_now(),
                                "lastError": None,
                            }
                        )
                        update_state_file(state_path, relay=relay_state)
                    consecutive_failures = 0
                    next_sync_at = time.time() + interval_s
                except Exception as error:
                    if "Unknown remote agent" in str(error):
                        try:
                            refresh_registration()
                            consecutive_failures = 0
                            next_sync_at = 0.0
                            time.sleep(1.0)
                            continue
                        except Exception as register_error:
                            error = register_error
                    consecutive_failures += 1
                    retry_seconds = min(60, max(interval_s, 2**min(consecutive_failures, 5)))
                    next_retry_at = time.time() + retry_seconds
                    if relay_client is not None:
                        relay_client.close()
                        relay_client = None
                    current_state = load_state_file(state_path)
                    relay_state = safe_relay_state(current_state)
                    relay_state.update(
                        {
                            "url": relay_url,
                            "peerId": agent_id,
                            "connected": False,
                            "lastError": str(error),
                        }
                    )
                    update_state_file(
                        state_path,
                        connectionState="disconnected",
                        consecutiveFailures=consecutive_failures,
                        lastError=str(error),
                        nextRetryAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(next_retry_at)),
                        relay=relay_state,
                    )
                    print(
                        json.dumps(
                            {
                                "event": "daemon_connection_error",
                                "agentId": agent_id,
                                "error": str(error),
                                "consecutiveFailures": consecutive_failures,
                                "retryInSeconds": retry_seconds,
                            },
                            indent=2,
                        )
                    )
                    next_sync_at = next_retry_at
                    time.sleep(1.0)
                    continue

            relay_resolved_requests: list[dict[str, Any]] = []
            relay_pending_jobs: list[dict[str, Any]] = []
            if relay_client is not None:
                for message in relay_client.drain_messages():
                    message_type = message.get("type")
                    payload = message.get("payload")
                    if message_type == "approval_decision" and isinstance(payload, dict):
                        request_id = payload.get("requestId")
                        if isinstance(request_id, str) and request_id not in seen_resolved:
                            seen_resolved.add(request_id)
                            relay_resolved_requests.append(payload)
                            print(json.dumps({"event": "relay_decision", "request": payload}, indent=2))
                    elif message_type == "job_request" and isinstance(payload, dict):
                        relay_pending_jobs.append(payload)

            for job in relay_pending_jobs:
                launch_remote_job(job)

            for job in polled.get("pendingJobs", []):
                launch_remote_job(job)

            removed_job_ids = {
                str(job_id)
                for job_id in polled.get("removedJobIds", [])
                if isinstance(job_id, str) and job_id
            }
            for job_id in list(removed_job_ids):
                job_state = launched_jobs.pop(job_id, None)
                if not job_state:
                    continue
                if job_state.get("kind") == "tmux":
                    subprocess.run(
                        ["tmux", "kill-session", "-t", str(job_state.get("sessionName", ""))],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                else:
                    process = job_state.get("process")
                    if process is not None:
                        try:
                            process.terminate()
                        except Exception:
                            pass
                print(
                    json.dumps(
                        {
                            "event": "remote_job_removed",
                            "jobId": job_id,
                            "reason": "removed_in_pi",
                        },
                        indent=2,
                    )
                )

            for job in polled.get("jobs", []):
                job_id = job.get("jobId")
                log_file = job.get("logFile")
                session_name = tmux_session_name(job_id) if isinstance(job_id, str) else ""
                if (
                    isinstance(job_id, str)
                    and job_id not in launched_jobs
                    and job.get("status") == "running"
                    and isinstance(log_file, str)
                ):
                    log_path = Path(log_file)
                    artifact_value = job.get("artifactsDir")
                    artifact_dir = (
                        Path(artifact_value)
                        if isinstance(artifact_value, str) and artifact_value
                        else log_path.parent / job_id
                    )
                    if session_name and tmux_has_session(session_name):
                        launched_jobs[job_id] = {
                            "kind": "tmux",
                            "sessionName": session_name,
                            "logPath": log_path,
                            "artifactDir": artifact_dir,
                        }
                        # Re-announce to the relay so the browser can reconnect
                        # after PI server or vi-agent restarts. Without this,
                        # the relay has no record of the session and every
                        # TerminalManager.open() fails with "not found on relay".
                        if terminal_relay_client is not None:
                            terminal_relay_client.announce(session_name)
                        # Immediately re-report with tmuxSession so the server's
                        # JSON is current even if the earlier report was lost.
                        safe_report_job(
                            job_id,
                            "running",
                            logFile=str(log_path),
                            logTail=tail_text(log_path),
                            tmuxSession=session_name,
                            **handoff_payload(artifact_dir),
                        )
                    elif log_path.exists():
                        safe_report_job(
                            job_id,
                            "running",
                            logFile=str(log_path),
                            logTail=tail_text(log_path),
                            **handoff_payload(artifact_dir),
                        )

            jobs_by_id = {
                job.get("jobId"): job
                for job in polled.get("jobs", [])
                if isinstance(job, dict) and isinstance(job.get("jobId"), str)
            }

            for job_id, job_state in list(launched_jobs.items()):
                log_path = job_state["logPath"]
                artifact_dir = job_state.get("artifactDir")
                if not isinstance(artifact_dir, Path):
                    artifact_dir = None
                if job_state.get("kind") == "tmux":
                    session_name = str(job_state["sessionName"])
                    if tmux_has_session(session_name):
                        sent_input_ids = send_pending_inputs(jobs_by_id.get(job_id, {}), job_state)
                        screen = tmux_capture(session_name)
                        provider_state = add_provider_state_stability(
                            job_state,
                            detect_provider_state(
                                screen,
                                provider=str(job_state.get("provider") or "unknown"),
                            ),
                            screen,
                        )
                        request_pi_utility_session_from_runtime(job_id, screen)

                        # Inject VI_INITIAL_PROMPT into the Claude REPL once after startup.
                        # The prompt must NOT be a positional CLI arg (triggers one-shot exit).
                        # Instead we wait for the REPL to be ready, then send via tmux.
                        _ip = job_state.get("initialPrompt")
                        if _ip and not job_state.get("initialPromptSent") and screen.strip():
                            _ps = provider_state.get("state")
                            _stable = float(provider_state.get("stableForSeconds") or 0.0)
                            # Fire on explicit waiting_input signal OR after 4s of stable screen
                            # (Claude loading animation stops once the REPL prompt appears).
                            if _ps == "waiting_input" or (
                                _stable >= 4.0 and _ps not in ("busy", "waiting_approval")
                            ):
                                # For Claude sessions, inject as /plan so Claude treats the prompt
                                # as the session plan.  /plan takes a single-line description,
                                # so collapse newlines to spaces.
                                # For Codex, keep the prompt as-is (no /plan support).
                                _is_claude = (
                                    str(job_state.get("provider") or "unknown").lower() == "claude"
                                )
                                if _is_claude:
                                    _goal_text = " ".join(_ip.split())
                                    _to_send = f"/plan {_goal_text}"
                                else:
                                    _to_send = _ip
                                if tmux_send_input(session_name, _to_send, True):
                                    job_state["initialPromptSent"] = True
                                    screen = tmux_capture(session_name)
                                    provider_state = add_provider_state_stability(
                                        job_state,
                                        detect_provider_state(
                                            screen,
                                            provider=str(job_state.get("provider") or "unknown"),
                                        ),
                                        screen,
                                    )

                        # Claude: auto-accept workspace trust prompt for PI-managed sessions.
                        # The user already chose this cwd when starting the session, so trust
                        # is implied. Sending "1" selects "Yes, I trust this folder".
                        if (
                            str(job_state.get("provider") or "unknown").lower() == "claude"
                            and provider_state.get("state") == "waiting_approval"
                            and provider_state.get("reason") == "claude_trust_prompt"
                        ):
                            _trust_fp = screen_fingerprint(screen)
                            if job_state.get("lastTrustPromptFingerprint") != _trust_fp:
                                job_state["lastTrustPromptFingerprint"] = _trust_fp
                                tmux_send_input(session_name, "1", True)

                        # Codex-only: auto-approve diff confirmation prompts when always_allow.
                        # Claude Code approvals are handled by the PreToolUse hook (vi-approve),
                        # not by tmux key injection.
                        if str(job_state.get("provider") or "unknown").lower() == "codex":
                            current_permission_mode = heartbeat.get("agent", agent).get("permissionMode") or agent.get("permissionMode")
                            if (
                                current_permission_mode == "always_allow"
                                and provider_state.get("state") == "waiting_approval"
                                and provider_state.get("reason") == "interactive_choice_prompt"
                            ):
                                last_auto = job_state.get("lastAutoApprovalFingerprint")
                                current_fingerprint = screen_fingerprint(screen)
                                if last_auto != current_fingerprint:
                                    job_state["lastAutoApprovalFingerprint"] = current_fingerprint
                                    tmux_send_input(session_name, "", True)

                        ralph_prompt = maybe_send_ralph_nudge(
                            job_id,
                            job_state,
                            jobs_by_id.get(job_id, {}),
                            provider_state,
                            screen,
                        )
                        if ralph_prompt:
                            screen = tmux_capture(session_name)
                            provider_state = add_provider_state_stability(
                                job_state,
                                detect_provider_state(
                                    screen,
                                    provider=str(job_state.get("provider") or "unknown"),
                                ),
                                screen,
                            )
                        job_title = jobs_by_id.get(job_id, {}).get("title")
                        maybe_handoff_checkpoint(
                            job_id,
                            artifact_dir,
                            title=str(job_title) if isinstance(job_title, str) and job_title else job_id,
                            status="running",
                            screen=screen,
                        )
                        log_path.write_text(screen, encoding="utf-8", errors="replace")
                        safe_report_job(
                            job_id,
                            "running",
                            logFile=str(log_path),
                            logTail=screen,
                            tmuxSession=session_name,
                            sentInputIds=sent_input_ids or None,
                            providerState=provider_state,
                            ralphLastNudge=ralph_prompt,
                            **handoff_payload(artifact_dir),
                        )
                        continue
                    screen = tail_text(log_path)
                    job_title = jobs_by_id.get(job_id, {}).get("title")
                    maybe_handoff_checkpoint(
                        job_id,
                        artifact_dir,
                        title=str(job_title) if isinstance(job_title, str) and job_title else job_id,
                        status="completed",
                        screen=screen,
                        force_reason="completed",
                    )
                    safe_report_job(
                        job_id,
                        "completed",
                        logFile=str(log_path),
                        logTail=screen,
                        tmuxSession=session_name,
                        providerState={
                            **detect_provider_state(
                                screen,
                                provider=str(job_state.get("provider") or "unknown"),
                            ),
                            "state": "completed",
                            "reason": "tmux_session_ended",
                        },
                        **handoff_payload(artifact_dir),
                    )
                    print(
                        json.dumps(
                            {
                                "event": "remote_job_finished",
                                "jobId": job_id,
                                "tmuxSession": session_name,
                                "logFile": str(log_path),
                            },
                            indent=2,
                        )
                    )
                    del launched_jobs[job_id]
                    continue

                process = job_state["process"]
                code = process.poll()
                if code is None:
                    log_tail = tail_text(log_path)
                    provider_state = add_provider_state_stability(
                        job_state,
                        detect_provider_state(
                            log_tail,
                            provider=str(job_state.get("provider") or "unknown"),
                        ),
                        log_tail,
                    )
                    request_pi_utility_session_from_runtime(job_id, log_tail)
                    job_title = jobs_by_id.get(job_id, {}).get("title")
                    maybe_handoff_checkpoint(
                        job_id,
                        artifact_dir,
                        title=str(job_title) if isinstance(job_title, str) and job_title else job_id,
                        status="running",
                        screen=log_tail,
                    )
                    safe_report_job(
                        job_id,
                        "running",
                        logFile=str(log_path),
                        logTail=log_tail,
                        providerState=provider_state,
                        **handoff_payload(artifact_dir),
                    )
                    continue
                log_tail = tail_text(log_path)
                job_title = jobs_by_id.get(job_id, {}).get("title")
                maybe_handoff_checkpoint(
                    job_id,
                    artifact_dir,
                    title=str(job_title) if isinstance(job_title, str) and job_title else job_id,
                    status="completed" if code == 0 else "failed",
                    screen=log_tail,
                    force_reason="completed" if code == 0 else "failed",
                )
                safe_report_job(
                    job_id,
                    "completed" if code == 0 else "failed",
                    exitCode=code,
                    logFile=str(log_path),
                    logTail=log_tail,
                    providerState={
                        **detect_provider_state(
                            log_tail,
                            provider=str(job_state.get("provider") or "unknown"),
                        ),
                        "state": "completed" if code == 0 else "blocked",
                        "reason": "process_exited",
                    },
                    **handoff_payload(artifact_dir),
                )
                print(
                    json.dumps(
                        {
                            "event": "remote_job_finished",
                            "jobId": job_id,
                            "exitCode": code,
                            "logFile": str(log_path),
                        },
                        indent=2,
                    )
                )
                del launched_jobs[job_id]

            resolved_requests = polled.get("resolvedRequests", [])
            for entry in relay_resolved_requests:
                request_id = entry.get("requestId")
                if not isinstance(request_id, str):
                    continue
                if not any(existing.get("requestId") == request_id for existing in resolved_requests):
                    resolved_requests.insert(0, entry)
            persisted_resolved = load_state_file(state_path).get("resolvedRequests", [])
            if isinstance(persisted_resolved, list):
                for entry in persisted_resolved:
                    request_id = entry.get("requestId") if isinstance(entry, dict) else None
                    if not isinstance(request_id, str):
                        continue
                    if not any(existing.get("requestId") == request_id for existing in resolved_requests):
                        resolved_requests.append(entry)
            for entry in resolved_requests:
                request_id = entry.get("requestId")
                if not isinstance(request_id, str) or request_id in seen_resolved:
                    continue
                seen_resolved.add(request_id)
                print(json.dumps({"event": "decision", "request": entry}, indent=2))

            write_state_file(
                state_path,
                {
                    "registeredAt": iso_now(),
                    "agent": heartbeat.get("agent", agent),
                    "lastHeartbeat": iso_now(),
                    "lastPoll": iso_now(),
                    "pendingRequests": polled.get("pendingRequests", []),
                    "resolvedRequests": resolved_requests,
                    "pendingJobs": polled.get("pendingJobs", []),
                    "jobs": polled.get("jobs", []),
                    "connectionState": "connected",
                    "consecutiveFailures": 0,
                    "lastError": None,
                    "nextRetryAt": None,
                    "relay": load_state_file(state_path).get("relay"),
                },
            )

            time.sleep(0.5)
    except KeyboardInterrupt:
        dbg.log("daemon_interrupted", agentId=agent_id)
        dbg.close()
        if relay_client is not None:
            relay_client.close()
            relay_client = None
        if terminal_relay_client is not None:
            terminal_relay_client.stop()
            terminal_relay_client = None
        heartbeat_agent(
            argparse.Namespace(
                server=config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
                agent_id=agent_id,
                status="paused",
                branch=config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
                worktree=config_value(args, "worktree", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree", default=os.getcwd()),
                repo_root=config_value(args, "repo_root", "VI_AGENT_REPO_ROOT", state_path=state_path, paired_key="repoRoot", default=os.getcwd()),
            )
        )
        print(json.dumps({"event": "daemon_stopped", "agentId": agent_id}, indent=2))
        update_state_file(
            state_path,
            connectionState="stopped",
            lastError=None,
            nextRetryAt=None,
        )
        remove_file_if_exists(pid_path)
        return 130


def start_daemon(args: argparse.Namespace) -> int:
    debug = getattr(args, "debug", False)

    # In debug mode run the daemon in the foreground of the current terminal.
    if debug:
        print(json.dumps({
            "started": True,
            "mode": "foreground_debug",
            "logFile": str(_DEBUG_LOG_PATH),
            "note": "Running in foreground. Ctrl+C to stop.",
        }, indent=2), flush=True)
        daemon_ns = vars(args).copy()
        daemon_ns["command"] = "daemon"
        daemon_args = argparse.Namespace(**daemon_ns)
        return run_daemon(daemon_args)

    state_path = resolve_state_file(args)
    pid_path = pid_file_path(state_path)
    log_path = log_file_path(state_path)
    existing_pid = read_pid(pid_path)
    if process_is_alive(existing_pid):
        print(
            json.dumps(
                {
                    "started": False,
                    "reason": "already_running",
                    "pid": existing_pid,
                    "stateFile": str(state_path),
                    "pidFile": str(pid_path),
                    "logFile": str(log_path),
                },
                indent=2,
            )
        )
        return 0

    remove_file_if_exists(pid_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("ab")
    env = os.environ.copy()

    resolved_values = {
        "VI_SERVER": config_value(args, "server", "VI_SERVER", state_path=state_path, paired_key="server"),
        "VI_AGENT_ID": env_or(args, "agent_id", "VI_AGENT_ID"),
        "VI_AGENT_DISPLAY_NAME": config_value(args, "display_name", "VI_AGENT_DISPLAY_NAME", state_path=state_path, paired_key="displayName"),
        "VI_AGENT_PROJECT": config_value(args, "project", "VI_AGENT_PROJECT", state_path=state_path, paired_key="projectLabel"),
        "VI_AGENT_TOOL": config_value(args, "tool", "VI_AGENT_TOOL", state_path=state_path, paired_key="toolType"),
        "VI_AGENT_HOST": config_value(args, "host", "VI_AGENT_HOST", state_path=state_path, paired_key="hostLabel"),
        "VI_AGENT_REPO_ROOT": config_value(args, "repo_root", "VI_AGENT_REPO_ROOT", state_path=state_path, paired_key="repoRoot"),
        "VI_AGENT_BRANCH": config_value(args, "branch", "VI_AGENT_BRANCH", state_path=state_path, paired_key="branch"),
        "VI_AGENT_WORKTREE": config_value(args, "worktree", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree"),
        "VI_AGENT_STATUS": config_value(args, "status", "VI_AGENT_STATUS", state_path=state_path, paired_key="status"),
        "VI_AGENT_STATE_FILE": str(state_path),
        "VI_RELAY_URL": config_value(args, "relay_url", "VI_RELAY_URL", state_path=state_path, paired_key="relay.url"),
        "VI_RELAY_TOKEN": config_value(args, "relay_token", "VI_RELAY_TOKEN", state_path=state_path, paired_key="relay.token"),
    }
    for key, value in resolved_values.items():
        if value:
            env[key] = value

    if not load_paired_config(state_path) and resolved_values.get("VI_SERVER"):
        update_state_file(
            state_path,
            pairedConfig={
                "server": resolved_values.get("VI_SERVER"),
                "displayName": resolved_values.get("VI_AGENT_DISPLAY_NAME"),
                "projectLabel": resolved_values.get("VI_AGENT_PROJECT"),
                "toolType": resolved_values.get("VI_AGENT_TOOL"),
                "relay": {
                    "url": resolved_values.get("VI_RELAY_URL"),
                    "token": resolved_values.get("VI_RELAY_TOKEN"),
                },
            },
        )

    command = [
        sys.executable,
        __file__,
        "daemon",
        "--state-file",
        str(state_path),
    ]
    heartbeat_ms = env_or(args, "heartbeat_ms", "VI_AGENT_HEARTBEAT_MS")
    if heartbeat_ms:
        command.extend(["--heartbeat-ms", heartbeat_ms])

    popen_kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "env": env,
        "cwd": config_value(args, "worktree", "VI_AGENT_WORKTREE", state_path=state_path, paired_key="worktree", default=os.getcwd()),
        "close_fds": True,
    }
    if os.name == "nt":
        creationflags = 0
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        popen_kwargs["creationflags"] = creationflags
    else:
        popen_kwargs["start_new_session"] = True

    process = subprocess.Popen(command, **popen_kwargs)
    log_handle.close()
    time.sleep(1.0)

    if process.poll() is not None:
        print(
            json.dumps(
                {
                    "started": False,
                    "reason": "exited_early",
                    "exitCode": process.returncode,
                    "stateFile": str(state_path),
                    "pidFile": str(pid_path),
                    "logFile": str(log_path),
                },
                indent=2,
            )
        )
        return int(process.returncode or 1)

    print(
        json.dumps(
            {
                "started": True,
                "pid": process.pid,
                "stateFile": str(state_path),
                "pidFile": str(pid_path),
                "logFile": str(log_path),
            },
            indent=2,
        )
    )
    return 0


def stop_daemon(args: argparse.Namespace) -> int:
    state_path = resolve_state_file(args)
    pid_path = pid_file_path(state_path)
    pid = read_pid(pid_path)
    if not process_is_alive(pid):
        remove_file_if_exists(pid_path)
        print(
            json.dumps(
                {
                    "stopped": False,
                    "reason": "not_running",
                    "stateFile": str(state_path),
                    "pidFile": str(pid_path),
                },
                indent=2,
            )
        )
        return 0

    sig = signal.SIGTERM if os.name != "nt" else signal.SIGTERM
    os.kill(pid, sig)

    deadline = time.time() + 10
    while time.time() < deadline:
        if not process_is_alive(pid):
            remove_file_if_exists(pid_path)
            print(
                json.dumps(
                    {
                        "stopped": True,
                        "pid": pid,
                        "stateFile": str(state_path),
                        "pidFile": str(pid_path),
                    },
                    indent=2,
                )
            )
            return 0
        time.sleep(0.25)

    print(
        json.dumps(
            {
                "stopped": False,
                "reason": "timeout",
                "pid": pid,
                "stateFile": str(state_path),
                "pidFile": str(pid_path),
            },
            indent=2,
        )
    )
    return 1


def restart_daemon(args: argparse.Namespace) -> int:
    """Hard restart the local daemon from its saved pairing state."""
    stop_result = stop_daemon(args)
    if stop_result != 0:
        return stop_result
    return start_daemon(args)


def kill_tmux_session_if_present(session_name: str) -> bool:
    if not session_name or not tmux_available() or not tmux_has_session(session_name):
        return False
    subprocess.run(
        ["tmux", "kill-session", "-t", session_name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return True


def cleanup_daemon(args: argparse.Namespace) -> int:
    """Clean local vi-agent state after a broken or stale connection."""
    state_path = resolve_state_file(args)
    pid_path = pid_file_path(state_path)
    state = load_state_file(state_path)
    pid = read_pid(pid_path)
    stale_pid_removed = False
    if pid and not process_is_alive(pid):
        remove_file_if_exists(pid_path)
        stale_pid_removed = True

    killed_sessions: list[str] = []
    if getattr(args, "kill_jobs", False):
        # Kill only PI-owned tmux sessions. This is intentionally scoped to the
        # deterministic prefix created by tmux_session_name(), not arbitrary tmux.
        if tmux_available():
            result = subprocess.run(
                ["tmux", "list-sessions", "-F", "#{session_name}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if result.returncode == 0:
                for raw in result.stdout.decode("utf-8", errors="replace").splitlines():
                    session_name = raw.strip()
                    if session_name.startswith("vi_remote_") and kill_tmux_session_if_present(session_name):
                        killed_sessions.append(session_name)

    cleared_jobs = False
    if getattr(args, "clear_jobs", False):
        state["pendingJobs"] = []
        state["jobs"] = []
        state["pendingRequests"] = []
        state["resolvedRequests"] = []
        state["connectionState"] = "stopped"
        state["lastError"] = None
        state["nextRetryAt"] = None
        write_state_file(state_path, state)
        cleared_jobs = True

    print(
        json.dumps(
            {
                "cleaned": True,
                "stateFile": str(state_path),
                "pidFile": str(pid_path),
                "stalePidRemoved": stale_pid_removed,
                "killedTmuxSessions": killed_sessions,
                "clearedLocalJobCache": cleared_jobs,
            },
            indent=2,
        )
    )
    return 0


def status_daemon(args: argparse.Namespace) -> int:
    print(json.dumps(serialize_service_status(args), indent=2))
    return 0


def context_bridge(args: argparse.Namespace) -> int:
    print(json.dumps(serialize_bridge_context(args), indent=2))
    return 0


def debug_env(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Print sanitized environment and tool info for debugging."""
    claude_bin = shutil.which("claude")
    codex_bin = shutil.which("codex")

    claude_version: str | None = None
    if claude_bin:
        try:
            result = subprocess.run(
                [claude_bin, "--version"], capture_output=True, text=True, timeout=5
            )
            claude_version = (result.stdout or result.stderr).strip().splitlines()[0] if result.returncode == 0 else "error"
        except Exception as exc:
            claude_version = f"error: {exc}"

    codex_version: str | None = None
    if codex_bin:
        try:
            result = subprocess.run(
                [codex_bin, "--version"], capture_output=True, text=True, timeout=5
            )
            codex_version = (result.stdout or result.stderr).strip().splitlines()[0] if result.returncode == 0 else "error"
        except Exception as exc:
            codex_version = f"error: {exc}"

    # Claude config file locations
    claude_config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    claude_settings = Path(claude_config_dir) / "settings.json"

    # State files
    state_dir = Path.home() / ".config" / "vi-agent"
    state_files = sorted(state_dir.glob("*.json")) if state_dir.exists() else []

    info: dict[str, Any] = {
        "claude": {
            "binary": claude_bin,
            "version": claude_version,
            "configDir": claude_config_dir,
            "settingsFile": str(claude_settings),
            "settingsExists": claude_settings.exists(),
        },
        "codex": {
            "binary": codex_bin,
            "version": codex_version,
        },
        "env": {
            "PATH": os.environ.get("PATH"),
            "ANTHROPIC_AVI_KEY": "present" if os.environ.get("ANTHROPIC_AVI_KEY") else "not set",
            "ANTHROPIC_MODEL": os.environ.get("ANTHROPIC_MODEL"),
            "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
            "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
            "CLAUDE_CONFIG_DIR": os.environ.get("CLAUDE_CONFIG_DIR"),
        },
        "piAgent": {
            "stateDir": str(state_dir),
            "stateFiles": [str(p) for p in state_files],
            "debugLog": str(_DEBUG_LOG_PATH),
            "debugLogExists": _DEBUG_LOG_PATH.exists(),
        },
    }
    print(json.dumps(info, indent=2))
    return 0


def debug_last_job(args: argparse.Namespace) -> int:
    """Print the last received job payload from the debug log or state file."""
    state_path = resolve_state_file(args)
    last_job_event: dict[str, Any] | None = None
    last_status_event: dict[str, Any] | None = None

    # Try debug log first (most detailed)
    if _DEBUG_LOG_PATH.exists():
        try:
            for line in _DEBUG_LOG_PATH.read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(line)
                    if entry.get("event") == "job_received":
                        last_job_event = entry
                    elif entry.get("event") == "job_status":
                        last_status_event = entry
                except json.JSONDecodeError:
                    continue
        except OSError:
            pass

    # Fall back to state file
    state_jobs: list[dict[str, Any]] = []
    try:
        state = load_state_file(state_path)
        state_jobs = state.get("jobs", [])
    except Exception:
        pass

    result: dict[str, Any] = {
        "source": "debug_log" if last_job_event else ("state_file" if state_jobs else "none"),
        "lastJobEvent": last_job_event,
        "lastStatusEvent": last_status_event,
        "stateFileJobs": [
            {
                "jobId": j.get("jobId"),
                "title": j.get("title"),
                "status": j.get("status"),
                "command": j.get("command"),
                "model": j.get("model"),
                "tmuxSession": j.get("tmuxSession"),
            }
            for j in state_jobs[-3:]
        ],
    }
    print(json.dumps(result, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vi-agent")
    subparsers = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--server")
    common.add_argument("--agent-id")
    common.add_argument("--display-name")
    common.add_argument("--project")
    common.add_argument("--tool")
    common.add_argument("--host")
    common.add_argument("--repo-root")
    common.add_argument("--branch")
    common.add_argument("--worktree")
    common.add_argument("--status")
    common.add_argument("--state-file")
    common.add_argument("--relay-url")
    common.add_argument("--relay-token")

    subparsers.add_parser("register", parents=[common])
    subparsers.add_parser("heartbeat", parents=[common])
    subparsers.add_parser("poll", parents=[common])
    pair = subparsers.add_parser("pair", parents=[common])
    pair.add_argument("--code", required=True)
    pair.add_argument("--start", action="store_true")
    pair.add_argument("--heartbeat-ms")
    pair.add_argument("--debug", action="store_true", help="Run daemon in foreground with verbose debug output")

    approval = subparsers.add_parser("request-approval", parents=[common])
    approval.add_argument("--title", required=True)
    approval.add_argument("--message", required=True)
    approval.add_argument("--command")
    approval.add_argument("--risk")
    approval.add_argument("--event-type")
    approval.add_argument("--primary-action", choices=("approve", "reply"))
    approval.add_argument("--parent-job-id")
    approval.add_argument("--action-kind")
    approval.add_argument("--suggested-command")
    approval.add_argument("--helper-prompt")

    external_action = subparsers.add_parser("request-external-action", parents=[common])
    external_action.add_argument("--title", required=True)
    external_action.add_argument("--message", required=True)
    external_action.add_argument(
        "--kind",
        choices=("github_auth", "codex_update", "install_tool", "open_browser_login", "run_host_setup", "other"),
        default="other",
    )
    external_action.add_argument("--risk", default="medium")
    external_action.add_argument("--suggested-command")
    external_action.add_argument("--helper-prompt")
    external_action.add_argument("--parent-job-id")

    pi_session = subparsers.add_parser("request-vi-session", parents=[common])
    pi_session.add_argument("--title", required=True)
    pi_session.add_argument("--message", required=True)
    pi_session.add_argument("--command", dest="session_command", required=True)
    pi_session.add_argument("--risk", default="medium")
    pi_session.add_argument("--parent-job-id")

    handoff = subparsers.add_parser("handoff-update", parents=[common])
    handoff.add_argument("--job-id")
    handoff.add_argument("--session-dir")
    handoff.add_argument("--handoff-status", choices=("running", "blocked", "final", "handoff"))
    handoff.add_argument("--reason", choices=("blocked", "final", "handoff", "major_change", "long_plan", "manual"), required=True)
    handoff.add_argument("--objective")
    handoff.add_argument("--doing")
    handoff.add_argument("--next", action="append")
    handoff.add_argument("--done", action="append")
    handoff.add_argument("--blocker", action="append")
    handoff.add_argument("--decision", action="append")
    handoff.add_argument("--resume-prompt")

    run = subparsers.add_parser("run", parents=[common])
    run.add_argument("--heartbeat-ms")
    run.add_argument("--cwd")
    run.add_argument("command", nargs=argparse.REMAINDER)

    codex = subparsers.add_parser("codex", parents=[common])
    codex.add_argument("--heartbeat-ms")
    codex.add_argument("--cwd")
    codex.add_argument("--binary")
    codex.add_argument("provider_args", nargs=argparse.REMAINDER)

    claude = subparsers.add_parser("claude", parents=[common])
    claude.add_argument("--heartbeat-ms")
    claude.add_argument("--cwd")
    claude.add_argument("--binary")
    claude.add_argument("provider_args", nargs=argparse.REMAINDER)

    approve = subparsers.add_parser("approve-command", parents=[common])
    approve.add_argument("--title")
    approve.add_argument("--message")
    approve.add_argument("--risk")
    approve.add_argument("--cwd")
    approve.add_argument("command", nargs=argparse.REMAINDER)

    daemon = subparsers.add_parser("daemon", parents=[common])
    daemon.add_argument("--heartbeat-ms")
    daemon.add_argument("--debug", action="store_true", help="Stream verbose debug output to stdout")

    start_daemon_parser = subparsers.add_parser("start-daemon", parents=[common])
    start_daemon_parser.add_argument("--heartbeat-ms")
    start_daemon_parser.add_argument("--debug", action="store_true", help="Run daemon in foreground with verbose debug output")

    restart_daemon_parser = subparsers.add_parser("restart-daemon", parents=[common])
    restart_daemon_parser.add_argument("--heartbeat-ms")
    restart_daemon_parser.add_argument("--debug", action="store_true", help="Restart into foreground debug mode")

    subparsers.add_parser("stop-daemon", parents=[common])
    cleanup_parser = subparsers.add_parser("cleanup", parents=[common])
    cleanup_parser.add_argument("--kill-jobs", action="store_true", help="Kill local PI-owned tmux job sessions")
    cleanup_parser.add_argument("--clear-jobs", action="store_true", help="Clear cached local job/request state")
    subparsers.add_parser("status", parents=[common])
    subparsers.add_parser("context", parents=[common])

    debug_parser = subparsers.add_parser("debug", parents=[common], help="Debug helpers")
    debug_parser.add_argument(
        "debug_subcommand",
        choices=["env", "last-job"],
        help="env: print sanitized tool/env info; last-job: print last received job payload",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "register":
        result = register_agent(args)
        print(json.dumps(result, indent=2))
        return
    if args.command == "heartbeat":
        result = heartbeat_agent(args)
        print(json.dumps(result, indent=2))
        return
    if args.command == "poll":
        result = poll_agent(args)
        print(json.dumps(result, indent=2))
        return
    if args.command == "request-approval":
        result = request_approval(args)
        print(json.dumps(result, indent=2))
        if result.get("status") == "rejected":
            raise SystemExit(2)
        return
    if args.command == "request-external-action":
        args.command = None
        args.event_type = "external_action"
        args.primary_action = "approve"
        args.action_kind = args.kind
        result = request_approval(args)
        print(json.dumps(result, indent=2))
        if result.get("status") == "rejected":
            raise SystemExit(2)
        return
    if args.command == "request-vi-session":
        args.suggested_command = args.session_command
        args.command = None
        args.event_type = "external_action"
        args.primary_action = "approve"
        args.action_kind = "other"
        args.helper_prompt = "Start a separate PI utility session for this host-side action."
        result = request_approval(args)
        print(json.dumps(result, indent=2))
        if result.get("status") == "rejected":
            raise SystemExit(2)
        return
    if args.command == "handoff-update":
        result = handoff_update(args)
        print(json.dumps(result, indent=2))
        return
    if args.command == "pair":
        raise SystemExit(pair_bridge(args))
    if args.command == "run":
        raise SystemExit(run_wrapped(args))
    if args.command == "codex":
        raise SystemExit(
            run_provider(
                args,
                tool="codex-cli",
                binary="codex",
                default_display_name="Remote Codex",
            )
        )
    if args.command == "claude":
        raise SystemExit(
            run_provider(
                args,
                tool="claude-code",
                binary="claude",
                default_display_name="Remote Claude",
            )
        )
    if args.command == "approve-command":
        raise SystemExit(approve_command(args))
    if args.command == "daemon":
        raise SystemExit(run_daemon(args))
    if args.command == "start-daemon":
        raise SystemExit(start_daemon(args))
    if args.command == "restart-daemon":
        raise SystemExit(restart_daemon(args))
    if args.command == "stop-daemon":
        raise SystemExit(stop_daemon(args))
    if args.command == "cleanup":
        raise SystemExit(cleanup_daemon(args))
    if args.command == "status":
        raise SystemExit(status_daemon(args))
    if args.command == "context":
        raise SystemExit(context_bridge(args))
    if args.command == "debug":
        if args.debug_subcommand == "env":
            raise SystemExit(debug_env(args))
        if args.debug_subcommand == "last-job":
            raise SystemExit(debug_last_job(args))

    parser.print_help()
    raise SystemExit(1)


if __name__ == "__main__":
    main()
