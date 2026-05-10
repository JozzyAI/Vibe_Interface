#!/usr/bin/env python3
"""
PreToolUse hook for Claude Code.

Claude Code calls this before executing any matched tool.
The hook reads the PI permission policy from the agent state file and
routes the approval decision:

  always_allow  -> exit 0 immediately (no prompt, no network call)
  manual        -> POST to PI approval API, block until human decides
  timeout_allow -> POST to PI approval API, block until decided or timeout, then auto-approve

Exit codes:
  0 -> Claude Code proceeds with the tool call
  2 -> Claude Code blocks the tool; stdout JSON {"reason": "..."} is shown to the AI

Environment variables expected (set by pi-agent before launching Claude Code):
  PI_AGENT_STATE_FILE  - path to the pi-agent state JSON
  PI_SERVER            - PI dashboard URL
  PI_AGENT_ID          - agent ID
  PI_REMOTE_JOB_ID     - job ID (optional, for linking approval to the job)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


# Tools that are safe to skip approval on even in manual mode
# (read-only, no side effects)
SAFE_TOOLS = frozenset(
    {
        "Read",
        "Glob",
        "Grep",
        "LS",
        "TodoRead",
        "WebFetch",
        "WebSearch",
        "NotebookRead",
    }
)

POLL_INTERVAL = 2  # seconds between PI polls


def _deny(reason: str) -> None:
    print(json.dumps({"reason": reason}))
    sys.exit(2)


def _read_state(state_file: str) -> dict[str, Any]:
    try:
        with open(state_file) as f:
            return json.load(f)
    except Exception:
        return {}


def _post_json(url: str, payload: dict[str, Any], timeout: int = 10) -> dict[str, Any]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _get_json(url: str, timeout: int = 10) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _create_approval_request(
    server: str,
    agent_id: str,
    job_id: str,
    tool_name: str,
    tool_input: dict[str, Any],
) -> str | None:
    """Create a PI approval request and return requestId, or None on failure."""
    # Build a human-readable summary of the tool call
    if tool_name == "Write":
        path = tool_input.get("file_path", "?")
        preview = (tool_input.get("content") or "")[:120]
        message = f"Write file: {path}\n\n{preview}{'…' if len(str(tool_input.get('content', ''))) > 120 else ''}"
    elif tool_name in ("Edit", "MultiEdit"):
        path = tool_input.get("file_path", "?")
        message = f"Edit file: {path}"
    elif tool_name == "Bash":
        cmd = tool_input.get("command", "?")
        message = f"Run command: {cmd}"
    elif tool_name == "NotebookEdit":
        path = tool_input.get("notebook_path", "?")
        message = f"Edit notebook: {path}"
    else:
        message = f"{tool_name}: {json.dumps(tool_input)[:200]}"

    payload: dict[str, Any] = {
        "agentId": agent_id,
        "title": f"Claude Code: {tool_name}",
        "message": message,
        "eventType": "generic",
        "primaryAction": "approve",
    }
    if job_id:
        payload["parentJobId"] = job_id

    try:
        result = _post_json(f"{server}/api/remote-agents/requests", payload)
        request = result.get("approvalRequest") or result.get("request") or {}
        return request.get("requestId")
    except Exception as exc:
        print(f"[pi-approve] Failed to create approval request: {exc}", file=sys.stderr)
        return None


def _poll_decision(
    server: str,
    agent_id: str,
    request_id: str,
    deadline: float,
) -> str | None:
    """Poll PI until the request is resolved. Returns 'approved', 'rejected', or None (timeout)."""
    poll_url = f"{server}/api/remote-agents/agents/{urllib.parse.quote(agent_id)}/poll"
    while time.time() < deadline:
        try:
            data = _get_json(poll_url)
            resolved = data.get("resolvedRequests") or []
            for req in resolved:
                if req.get("requestId") == request_id:
                    status = req.get("status", "")
                    if status == "approved":
                        return "approved"
                    if status in ("rejected", "denied"):
                        return "rejected"
        except Exception:
            pass
        time.sleep(POLL_INTERVAL)
    return None


def main() -> None:
    # Read tool call from stdin (Claude Code sends JSON)
    try:
        raw = sys.stdin.read()
        input_data: dict[str, Any] = json.loads(raw) if raw.strip() else {}
    except Exception:
        # Can't parse input — allow (fail open)
        sys.exit(0)

    tool_name: str = input_data.get("tool_name", "")
    tool_input: dict[str, Any] = input_data.get("tool_input") or {}

    # Read PI configuration from state file
    state_file = os.environ.get("PI_AGENT_STATE_FILE", "")
    server = os.environ.get("PI_SERVER", "").rstrip("/")
    agent_id = os.environ.get("PI_AGENT_ID", "")
    job_id = os.environ.get("PI_REMOTE_JOB_ID", "")

    state = _read_state(state_file) if state_file else {}
    agent = state.get("agent") or {}

    permission_mode: str = agent.get("permissionMode") or "manual"
    timeout_seconds: int = int(agent.get("timeoutSeconds") or 300)

    # always_allow: approve immediately without any network call
    if permission_mode == "always_allow":
        sys.exit(0)

    # Safe read-only tools: always allow regardless of mode
    if tool_name in SAFE_TOOLS:
        sys.exit(0)

    # manual / timeout_allow: route through PI approval API
    if not server or not agent_id:
        # Missing PI configuration — fail closed for mutating tools so that an
        # unconfigured hook never silently allows writes/commands.
        # Read-only tools already returned above via the SAFE_TOOLS check.
        _deny(
            f"PI approval not configured (missing PI_SERVER or PI_AGENT_ID). "
            f"{tool_name} is blocked. Check that pi-agent set the required env vars."
        )

    request_id = _create_approval_request(server, agent_id, job_id, tool_name, tool_input)
    if not request_id:
        # PI server unreachable — fail closed for all modes.
        # The user never saw the request, so they never had a chance to cancel.
        # Treating unreachability as "silence" (and auto-approving) would be
        # indistinguishable from the server being down during a malicious op.
        _deny(f"PI approval server unreachable. {tool_name} blocked. Check the PI dashboard.")

    deadline = time.time() + (timeout_seconds if permission_mode == "timeout_allow" else 86400)
    decision = _poll_decision(server, agent_id, request_id, deadline)

    if decision == "approved":
        sys.exit(0)
    elif decision == "rejected":
        _deny(f"PI rejected this {tool_name} operation.")
    else:
        # Timeout
        if permission_mode == "timeout_allow":
            # Auto-approve after timeout
            sys.exit(0)
        else:
            _deny(f"PI approval timed out for {tool_name}. No decision received.")


if __name__ == "__main__":
    main()
