#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import socket
import subprocess


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch Codex CLI through pi-agent.")
    parser.add_argument("--server", default=os.environ.get("PI_SERVER"))
    parser.add_argument("--display-name", default=os.environ.get("PI_AGENT_DISPLAY_NAME") or "Remote Codex")
    parser.add_argument("--project", default=os.environ.get("PI_AGENT_PROJECT") or socket.gethostname())
    parser.add_argument("--state-file", default=os.environ.get("PI_AGENT_STATE_FILE"))
    parser.add_argument("codex_args", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.server:
        raise SystemExit("Missing --server or PI_SERVER")

    command = [
        "pi-agent",
        "run",
        "--server",
        args.server,
        "--display-name",
        args.display_name,
        "--project",
        args.project,
        "--tool",
        "codex-cli",
    ]
    if args.state_file:
        command.extend(["--state-file", args.state_file])
    command.extend(["--", "codex", *([arg for arg in args.codex_args if arg != "--"])])
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
