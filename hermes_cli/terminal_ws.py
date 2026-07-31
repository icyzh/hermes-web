"""``/api/terminal`` — a user-shell PTY over WebSocket for Hermes Web.

The Electron desktop app hosts its terminal pane through node-pty in the main
process (``apps/desktop/electron/main.ts``, ``hermes:terminal:*`` IPC). The
browser build (``apps/webapp``) has no main process, so this endpoint hosts
the same thing server-side: each WebSocket owns one interactive login shell
behind a PTY, relayed as raw bytes both ways.

Wire protocol (mirrors the existing ``/api/pty`` conventions):

* first server frame: JSON hello ``{"type": "hello", "id", "shell", "cwd"}``
* every later server frame: raw PTY output (UTF-8 text frames)
* client frames: raw input for the shell's stdin
* in-band resize escape ``ESC [RESIZE:<cols>;<rows>]`` — consumed server-side,
  never written to the shell (same ``_RESIZE_RE`` contract as ``/api/pty``)
* socket close ⇒ the shell is terminated (SIGHUP → SIGTERM → SIGKILL)

Security: a browser-reachable login shell is strictly more powerful than the
``/api/pty`` TUI, so this endpoint is **opt-in** via
``HERMES_DASHBOARD_TERMINAL=1`` and sits behind the exact same pre-accept
gate chain as every other dashboard WebSocket (credential, Host/Origin,
peer-IP — close codes 4401/4403/4408), plus 4404 when the feature is off.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
import uuid
from pathlib import Path
from typing import Callable, Optional, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from hermes_cli.pty_bridge import PtyBridge, PtyUnavailableError

_log = logging.getLogger("hermes.dashboard.terminal")

_RESIZE_RE = re.compile(rb"\x1b\[RESIZE:(\d+);(\d+)\]")

_MAX_DIM = 1000


def terminal_ws_enabled() -> bool:
    """The endpoint is opt-in: a browser-reachable shell means any XSS or
    stolen session is remote code execution on the host."""
    return (os.environ.get("HERMES_DASHBOARD_TERMINAL") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _clamp(value: Optional[str], default: int) -> int:
    try:
        n = int(value or default)
    except (TypeError, ValueError):
        return default
    return max(2, min(_MAX_DIM, n))


def _shell_spec() -> Tuple[list, str]:
    """argv + display name of the user's interactive shell.

    Ports the desktop main process's ``posixShellSpec()``: honor ``$SHELL``,
    fall back to /bin/bash → /bin/sh, and run bash/zsh as interactive login
    shells (``-il``) so the user's rc files load like a real terminal tab.
    """
    shell = (os.environ.get("SHELL") or "").strip()
    if not shell or not Path(shell).exists():
        shell = "/bin/bash" if Path("/bin/bash").exists() else "/bin/sh"

    name = Path(shell).name
    argv = [shell, "-il"] if name in {"bash", "zsh"} else [shell]
    return argv, name


def _resolve_cwd(raw: Optional[str]) -> str:
    """Requested working directory, falling back to $HOME on anything bogus."""
    home = os.path.expanduser("~")
    if not raw:
        return home
    candidate = os.path.expanduser(raw.strip())
    try:
        if os.path.isdir(candidate):
            return candidate
    except OSError:
        pass
    return home


def _spawn_env() -> dict:
    """Shell env: the dashboard process env with terminal identity backfilled.

    Mirrors the desktop's ``terminalShellEnv()`` — real terminals advertise
    256-color/truecolor, and PTY-hosted programs misrender without it.
    """
    from tools.environments.local import build_subprocess_env

    env = build_subprocess_env(scrub_secrets=False, inherit_profile_home=True)
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    env.setdefault("TERM_PROGRAM", "hermes-web")
    return env


def register_terminal_ws(
    app: FastAPI,
    *,
    ws_auth_reason: Callable[[WebSocket], Tuple[Optional[str], str]],
    ws_host_origin_reason: Callable[[WebSocket], Optional[str]],
    ws_client_reason: Callable[[WebSocket], Optional[str]],
    ws_close_reason: Callable[[str], str],
) -> None:
    """Mount the endpoint, reusing web_server's WS gate helpers verbatim."""

    @app.websocket("/api/terminal")
    async def terminal_ws(ws: WebSocket) -> None:  # noqa: C901 — one pump, kept together
        peer = ws.client.host if ws.client else "?"

        if not terminal_ws_enabled():
            _log.info("terminal refused: disabled (HERMES_DASHBOARD_TERMINAL) peer=%s", peer)
            await ws.close(code=4404, reason=ws_close_reason("terminal disabled"))
            return

        # Same pre-accept gate chain + close codes as /api/pty:
        #   4401 bad credential  4403 host/origin mismatch  4408 peer not allowed
        auth_reason, cred = ws_auth_reason(ws)
        if auth_reason is not None:
            _log.warning("terminal auth rejected reason=%s cred=%s peer=%s", auth_reason, cred, peer)
            await ws.close(code=4401, reason=ws_close_reason(f"auth: {auth_reason}"))
            return

        host_origin_reason = ws_host_origin_reason(ws)
        if host_origin_reason is not None:
            _log.warning("terminal refused: %s peer=%s", host_origin_reason, peer)
            await ws.close(code=4403, reason=ws_close_reason(host_origin_reason))
            return

        client_reason = ws_client_reason(ws)
        if client_reason is not None:
            _log.warning("terminal refused: %s", client_reason)
            await ws.close(code=4408, reason=ws_close_reason(client_reason))
            return

        await ws.accept()

        if not PtyBridge.is_available():
            await ws.send_text(
                "\r\n\x1b[31mTerminal unavailable: this platform cannot host a POSIX PTY.\x1b[0m\r\n"
            )
            await ws.close(code=1011)
            return

        cols = _clamp(ws.query_params.get("cols"), 80)
        rows = _clamp(ws.query_params.get("rows"), 24)
        cwd = _resolve_cwd(ws.query_params.get("cwd"))
        argv, shell_name = _shell_spec()

        try:
            bridge = PtyBridge.spawn(argv, cwd=cwd, env=_spawn_env(), cols=cols, rows=rows)
        except (PtyUnavailableError, FileNotFoundError, OSError) as exc:
            await ws.send_text(f"\r\n\x1b[31mTerminal failed to start: {exc}\x1b[0m\r\n")
            await ws.close(code=1011)
            return

        term_id = f"term-{uuid.uuid4().hex[:12]}"
        _log.info(
            "terminal started id=%s shell=%s cwd=%s pid=%s peer=%s cred=%s",
            term_id, shlex.join(argv), cwd, bridge.pid, peer, cred,
        )

        import json

        await ws.send_text(json.dumps({"type": "hello", "id": term_id, "shell": shell_name, "cwd": cwd}))

        loop = asyncio.get_running_loop()
        closed = asyncio.Event()

        async def reader() -> None:
            """PTY master → WebSocket. Runs the blocking read in a thread."""
            try:
                while not closed.is_set():
                    data = await loop.run_in_executor(None, bridge.read, 0.2)
                    if data is None:
                        break  # child exited / master EOF
                    if data:
                        await ws.send_text(data.decode("utf-8", errors="replace"))
            except Exception:
                pass
            finally:
                closed.set()
                try:
                    await ws.close(code=1000)
                except Exception:
                    pass

        reader_task = asyncio.create_task(reader())

        try:
            while not closed.is_set():
                try:
                    msg = await ws.receive()
                except RuntimeError:
                    break
                if msg.get("type") == "websocket.disconnect":
                    break
                raw = msg.get("bytes")
                if raw is None:
                    text = msg.get("text")
                    raw = text.encode("utf-8") if isinstance(text, str) else b""
                if not raw:
                    continue

                # Resize escape is consumed locally, never written to the shell.
                match = _RESIZE_RE.match(raw)
                if match and match.end() == len(raw):
                    bridge.resize(cols=int(match.group(1)), rows=int(match.group(2)))
                    continue

                bridge.write(raw)
        except WebSocketDisconnect:
            pass
        finally:
            closed.set()
            reader_task.cancel()
            bridge.close()
            _log.info("terminal closed id=%s", term_id)
