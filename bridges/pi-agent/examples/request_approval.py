#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Example hook that reuses a pi-agent daemon identity to ask PI for approval."
    )
    parser.add_argument("--server", default=os.environ.get("PI_SERVER"))
    parser.add_argument("--state-file", default=os.environ.get("PI_AGENT_STATE_FILE"))
    parser.add_argument("--title", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--command")
    parser.add_argument("--risk", default="medium")
    parser.add_argument("--event-type")
    parser.add_argument("--primary-action", choices=("approve", "reply"))
    return parser


def run_bridge(*bridge_args: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["pi-agent", *bridge_args],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout or "{}")


def main() -> int:
    args = build_parser().parse_args()
    if not args.server:
        raise SystemExit("Missing --server or PI_SERVER")
    if not args.state_file:
        raise SystemExit("Missing --state-file or PI_AGENT_STATE_FILE")

    context = run_bridge(
        "context",
        "--server",
        args.server,
        "--state-file",
        args.state_file,
    )
    if not context.get("agentId"):
        raise SystemExit("The bridge state file does not contain a registered daemon identity yet.")

    decision = run_bridge(
        "request-approval",
        "--server",
        args.server,
        "--state-file",
        args.state_file,
        "--title",
        args.title,
        "--message",
        args.message,
        "--risk",
        args.risk,
        *(["--event-type", args.event_type] if args.event_type else []),
        *(["--primary-action", args.primary_action] if args.primary_action else []),
        *(["--command", args.command] if args.command else []),
    )
    print(json.dumps({"context": context, "decision": decision}, indent=2))
    return 0 if decision.get("status") != "rejected" else 2


if __name__ == "__main__":
    raise SystemExit(main())
