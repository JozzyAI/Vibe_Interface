"""
PI Terminal Relay Client — vi-agent side.

Connects to the PI server's /vi-agent-relay WebSocket endpoint and serves
interactive terminal access to local tmux sessions. PI routes all frames;
no direct connection from PI to this machine is ever needed.

Protocol (outbound, vi-agent → PI):
  hello          { type, agentId, token }
  announce       { type, sessions: [str] }
  terminal_data  { type, sessionId, data: str (base64) }
  terminal_exited{ type, sessionId, exitCode: int }
  ping           { type }

Protocol (inbound, PI → vi-agent):
  hello_ack      { type, agentId }
  hello_error    { type, message }
  terminal_open  { type, sessionId, cols, rows }
  terminal_input { type, sessionId, data: str (base64) }
  terminal_resize{ type, sessionId, cols, rows }
  terminal_close { type, sessionId }
  pong           { type }

Each terminal_open causes this client to:
  1. Run: tmux attach-session -t <sessionId>  (in a PTY)
  2. Stream PTY output back as terminal_data frames
  3. Forward terminal_input to the PTY fd
  4. Forward terminal_resize as TIOCSWINSZ + SIGWINCH
  5. On terminal_close: terminate the process
  6. On PTY exit: send terminal_exited and clean up
"""
from __future__ import annotations

import base64
import fcntl
import json
import os
import pty
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
from typing import Any

try:
    import websocket as _websocket_lib
except ImportError:  # pragma: no cover
    _websocket_lib = None  # type: ignore[assignment]

DIRECT_TERMINAL_PORT = 14801  # default if not overridden by DIRECT_TERMINAL_PORT env var
VI_SESSION_PREFIX = "vi_remote_"  # tmux session name prefix used by launch_remote_job


def discover_pi_tmux_sessions(tmux_path: str | None = None, prefix: str = VI_SESSION_PREFIX) -> list[str]:
    """
    List local tmux sessions whose names start with prefix (default: "vi_remote_").

    Called on every relay connect so that sessions created before the daemon
    started (or before the relay first connected) are automatically announced.
    Returns an empty list if tmux is unavailable or has no matching sessions.
    """
    tmux = tmux_path or shutil.which("tmux") or "tmux"
    try:
        result = subprocess.run(
            [tmux, "list-sessions", "-F", "#{session_name}"],
            capture_output=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []
        return [
            line.strip()
            for line in result.stdout.decode("utf-8", errors="replace").splitlines()
            if line.strip().startswith(prefix)
        ]
    except Exception:
        return []


def derive_terminal_relay_url(server: str, explicit_url: str | None = None) -> str | None:
    """
    Build the WebSocket URL for the /vi-agent-relay endpoint.

    Priority:
      1. explicit_url (VI_TERMINAL_RELAY_URL env var) if set — used as-is
      2. Derived from VI_SERVER:
           http://host:port  → ws://host:<direct_port>/vi-agent-relay   (local dev)
           https://host      → wss://host/vi-agent-relay                 (production via TLS proxy)

    In local development, VI_SERVER is typically http://host:3000.
    The direct-terminal-ws server listens on port 14801 (or DIRECT_TERMINAL_PORT).
    In production behind an nginx/Caddy proxy, /vi-agent-relay is served at the
    same host as VI_SERVER over TLS, so port 14801 is not exposed directly.
    """
    if explicit_url:
        url = explicit_url.rstrip("/")
        if not url.endswith("/vi-agent-relay"):
            url += "/vi-agent-relay"
        return url

    if not server:
        return None

    s = server.rstrip("/")
    direct_port = int(os.environ.get("DIRECT_TERMINAL_PORT") or str(DIRECT_TERMINAL_PORT))

    if s.startswith("https://") or s.startswith("wss://"):
        # Production: proxy handles TLS, /vi-agent-relay is at the same host
        host = s.split("://", 1)[1].split("/")[0]
        return f"wss://{host}/vi-agent-relay"
    else:
        # Local dev: direct-terminal-ws on a separate port
        host = s.split("://", 1)[-1].split("/")[0].split(":")[0]
        return f"ws://{host}:{direct_port}/vi-agent-relay"


class _PtySession:
    """One PTY-attached tmux session served over the relay."""

    def __init__(self, session_id: str, master_fd: int, proc: subprocess.Popen[bytes]):
        self.session_id = session_id
        self.master_fd = master_fd
        self.proc = proc
        self.closed = False
        self._lock = threading.Lock()

    def write(self, data: bytes) -> None:
        with self._lock:
            if self.closed:
                return
            try:
                os.write(self.master_fd, data)
            except OSError:
                pass

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            if self.closed:
                return
            try:
                fcntl.ioctl(
                    self.master_fd,
                    termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0),
                )
                # Signal the process group so ncurses apps redraw
                pgid = os.getpgid(self.proc.pid)
                os.killpg(pgid, signal.SIGWINCH)
            except OSError:
                pass

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
        try:
            self.proc.terminate()
        except Exception:
            pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass


class TerminalRelayClient:
    """
    Background thread that maintains the vi-agent → PI /vi-agent-relay WebSocket.

    Usage:
        client = TerminalRelayClient(relay_url, agent_id, token)
        client.start()              # starts background thread
        client.announce("vi_remote_job_xxx")  # call after a tmux session is created
        client.stop()               # clean shutdown
    """

    def __init__(self, relay_url: str, agent_id: str, token: str):
        if _websocket_lib is None:
            raise RuntimeError(
                "websocket-client is required for terminal relay. "
                "Reinstall vi-agent: pip install vi-agent"
            )
        self._url = relay_url
        self._agent_id = agent_id
        self._token = token

        self._running = False
        self._thread: threading.Thread | None = None
        self._ws: Any | None = None
        self._ws_lock = threading.Lock()

        self._pty_sessions: dict[str, _PtySession] = {}
        self._pty_lock = threading.Lock()

        # Sessions to announce. Protected by _announce_lock.
        self._pending_sessions: list[str] = []
        self._all_sessions: set[str] = set()  # every session ever announced (for reconnect)
        self._announce_lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background relay thread."""
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="pi-terminal-relay")
        self._thread.start()

    def stop(self) -> None:
        """Signal the relay thread to stop and close all PTY sessions."""
        self._running = False
        with self._ws_lock:
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    pass
                self._ws = None
        self._close_all_ptys()

    def announce(self, session_id: str) -> None:
        """
        Register a tmux session as available for remote terminal access.
        If the relay WebSocket is connected, sends the announce immediately.
        Otherwise queues it for the next successful connect.
        """
        with self._announce_lock:
            if session_id in self._all_sessions:
                return
            self._all_sessions.add(session_id)
            self._pending_sessions.append(session_id)

        self._flush_pending_announce()

    # ── Internal: relay WebSocket lifecycle ───────────────────────────────────

    def _run(self) -> None:
        """Main reconnect loop. Runs in the daemon thread."""
        backoff = 2
        while self._running:
            try:
                self._connect_and_serve()
                backoff = 2  # reset after a clean session
            except Exception as exc:
                print(
                    json.dumps({
                        "event": "terminal_relay_error",
                        "agentId": self._agent_id,
                        "error": str(exc),
                        "retryInSeconds": backoff,
                    }),
                    flush=True,
                )
            finally:
                # Close all PTYs — they will be re-opened when the browser reconnects
                self._close_all_ptys()
                with self._ws_lock:
                    self._ws = None

            if not self._running:
                break
            time.sleep(backoff)
            backoff = min(60, backoff * 2)

    def _connect_and_serve(self) -> None:
        """Open one relay WebSocket session, authenticate, and serve until disconnected."""
        ws = _websocket_lib.create_connection(self._url, timeout=15)

        with self._ws_lock:
            self._ws = ws

        # Authenticate
        ws.send(json.dumps({
            "type": "hello",
            "agentId": self._agent_id,
            "token": self._token,
        }))
        raw = ws.recv()
        msg = json.loads(raw)
        if msg.get("type") == "hello_error":
            raise RuntimeError(f"Relay auth rejected: {msg.get('message', '?')}")
        if msg.get("type") != "hello_ack":
            raise RuntimeError(f"Unexpected relay response: {msg.get('type')}")

        print(
            json.dumps({
                "event": "terminal_relay_connected",
                "agentId": self._agent_id,
                "url": self._url,
            }),
            flush=True,
        )

        # Merge any local vi_remote_* tmux sessions that exist on this machine
        # but were not yet tracked (e.g. sessions from before daemon startup or
        # before this relay connection was first established).
        discovered = discover_pi_tmux_sessions()
        with self._announce_lock:
            for s in discovered:
                self._all_sessions.add(s)
            all_sessions = list(self._all_sessions)
            self._pending_sessions.clear()

        if all_sessions:
            ws.send(json.dumps({"type": "announce", "sessions": all_sessions}))
            print(
                json.dumps({
                    "event": "terminal_relay_announced",
                    "sessions": all_sessions,
                }),
                flush=True,
            )

        # Serve messages
        ws.settimeout(30.0)
        while self._running:
            try:
                raw = ws.recv()
            except _websocket_lib.WebSocketTimeoutException:
                # Keepalive ping
                try:
                    ws.send(json.dumps({"type": "ping"}))
                except Exception:
                    break
                continue
            except _websocket_lib.WebSocketConnectionClosedException:
                break
            except Exception:
                break

            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            self._dispatch(msg, ws)

    def _flush_pending_announce(self) -> None:
        """Send any queued session announcements if the WebSocket is live."""
        with self._announce_lock:
            pending = list(self._pending_sessions)
            self._pending_sessions.clear()
        if not pending:
            return

        with self._ws_lock:
            ws = self._ws
        if ws is None:
            # Re-queue; they will be sent on reconnect via _all_sessions
            return

        try:
            ws.send(json.dumps({"type": "announce", "sessions": pending}))
            print(
                json.dumps({
                    "event": "terminal_relay_announced",
                    "sessions": pending,
                }),
                flush=True,
            )
        except Exception:
            pass  # reconnect loop will re-announce from _all_sessions

    # ── Internal: message dispatch ────────────────────────────────────────────

    def _dispatch(self, msg: dict[str, Any], ws: Any) -> None:
        t = msg.get("type")
        session_id = msg.get("sessionId", "")

        if t == "terminal_open":
            cols = int(msg.get("cols") or 80)
            rows = int(msg.get("rows") or 24)
            self._open_pty(session_id, cols, rows, ws)
        elif t == "terminal_input":
            data_b64 = msg.get("data", "")
            try:
                data = base64.b64decode(data_b64)
            except Exception:
                return
            self._write_pty(session_id, data)
        elif t == "terminal_resize":
            cols = int(msg.get("cols") or 80)
            rows = int(msg.get("rows") or 24)
            self._resize_pty(session_id, cols, rows)
        elif t == "terminal_close":
            self._close_pty(session_id)
        elif t == "pong":
            pass
        # hello_error / hello_ack handled before dispatch

    # ── Internal: PTY management ──────────────────────────────────────────────

    def _find_tmux(self) -> str:
        found = shutil.which("tmux")
        if found:
            return found
        for candidate in ("/usr/bin/tmux", "/usr/local/bin/tmux", "/opt/homebrew/bin/tmux"):
            if os.path.isfile(candidate):
                return candidate
        return "tmux"

    def _open_pty(self, session_id: str, cols: int, rows: int, ws: Any) -> None:
        with self._pty_lock:
            if session_id in self._pty_sessions:
                return  # already open (idempotent)

        tmux = self._find_tmux()

        # Create master/slave PTY pair
        master_fd, slave_fd = pty.openpty()

        # Set initial terminal size before spawning the process
        try:
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

        # Build a sane environment for the tmux attach process.
        # Explicitly set UTF-8 locale so PTY output is UTF-8 encoded regardless
        # of what the parent process inherited. Shell aliases are not expanded in
        # subprocess launches so we cannot rely on alias-based workarounds.
        pty_env = {**os.environ}
        # Use C.UTF-8 if available; fall back to en_US.UTF-8 or current locale.
        for candidate in ("C.UTF-8", "en_US.UTF-8"):
            import locale as _locale
            try:
                _locale.setlocale(_locale.LC_ALL, candidate)
                _locale.resetlocale()
                pty_env["LANG"] = candidate
                pty_env["LC_ALL"] = candidate
                break
            except _locale.Error:
                continue
        pty_env.setdefault("LANG", os.environ.get("LANG", "C.UTF-8"))
        pty_env.setdefault("LC_ALL", os.environ.get("LC_ALL", "C.UTF-8"))
        pty_env["TERM"] = "xterm-256color"

        try:
            proc = subprocess.Popen(
                [tmux, "attach-session", "-t", session_id],
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
                preexec_fn=os.setsid,  # new session = new process group
                env=pty_env,
            )
        except Exception as exc:
            os.close(slave_fd)
            os.close(master_fd)
            print(
                json.dumps({
                    "event": "terminal_relay_pty_error",
                    "sessionId": session_id,
                    "error": str(exc),
                }),
                flush=True,
            )
            # Notify PI the open failed
            try:
                ws.send(json.dumps({
                    "type": "terminal_exited",
                    "sessionId": session_id,
                    "exitCode": -1,
                }))
            except Exception:
                pass
            return

        # Slave fd is now owned by the subprocess — close our copy
        os.close(slave_fd)

        session = _PtySession(session_id, master_fd, proc)
        with self._pty_lock:
            self._pty_sessions[session_id] = session

        print(
            json.dumps({
                "event": "terminal_relay_pty_opened",
                "sessionId": session_id,
                "pid": proc.pid,
                "cols": cols,
                "rows": rows,
            }),
            flush=True,
        )

        # Start background reader thread
        reader = threading.Thread(
            target=self._pty_reader,
            args=(session, ws),
            daemon=True,
            name=f"pty-reader-{session_id[:12]}",
        )
        reader.start()

    def _pty_reader(self, session: _PtySession, ws: Any) -> None:
        """Read PTY output and forward as terminal_data frames."""
        session_id = session.session_id
        while not session.closed:
            try:
                data = os.read(session.master_fd, 4096)
            except OSError:
                break
            if not data:
                break

            encoded = base64.b64encode(data).decode()
            try:
                ws.send(json.dumps({
                    "type": "terminal_data",
                    "sessionId": session_id,
                    "data": encoded,
                }))
            except Exception:
                break

        # PTY exited or errored — wait for process and report exit code
        exit_code = 0
        try:
            session.proc.wait(timeout=3)
            exit_code = session.proc.returncode or 0
        except Exception:
            exit_code = -1

        print(
            json.dumps({
                "event": "terminal_relay_pty_exited",
                "sessionId": session_id,
                "exitCode": exit_code,
            }),
            flush=True,
        )

        # Clean up PTY entry
        with self._pty_lock:
            self._pty_sessions.pop(session_id, None)

        # Notify PI server
        try:
            os.close(session.master_fd)
        except OSError:
            pass

        try:
            ws.send(json.dumps({
                "type": "terminal_exited",
                "sessionId": session_id,
                "exitCode": exit_code,
            }))
        except Exception:
            pass

    def _write_pty(self, session_id: str, data: bytes) -> None:
        with self._pty_lock:
            session = self._pty_sessions.get(session_id)
        if session:
            session.write(data)

    def _resize_pty(self, session_id: str, cols: int, rows: int) -> None:
        with self._pty_lock:
            session = self._pty_sessions.get(session_id)
        if session:
            session.resize(cols, rows)

    def _close_pty(self, session_id: str) -> None:
        with self._pty_lock:
            session = self._pty_sessions.pop(session_id, None)
        if session:
            session.close()
            print(
                json.dumps({
                    "event": "terminal_relay_pty_closed",
                    "sessionId": session_id,
                }),
                flush=True,
            )

    def _close_all_ptys(self) -> None:
        with self._pty_lock:
            sessions = list(self._pty_sessions.values())
            self._pty_sessions.clear()
        for session in sessions:
            session.close()
