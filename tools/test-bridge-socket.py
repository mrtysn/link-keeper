#!/usr/bin/env python3
# DESC: Check that the helper (native/link-keeper-bridge.py) makes its shell socket again when the file goes missing.
"""Start the helper's socket server with its state folder in a temp directory, delete the socket file
as a second helper quitting would, and check that it comes back and answers. No Firefox, no network.

    tools/test-bridge-socket.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


def ask(path: Path) -> dict | None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
        c.settimeout(2)
        c.connect(str(path))
        c.sendall(json.dumps({"cmd": "bridge-status", "args": {}}).encode() + b"\n")
        c.shutdown(socket.SHUT_WR)
        data = b""
        while chunk := c.recv(65536):
            data += chunk
    return json.loads(data)


def wait_for(path: Path, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if path.exists():
            return True
        time.sleep(0.05)
    return False


with tempfile.TemporaryDirectory() as tmp:
    os.environ["LINK_KEEPER_STATE_DIR"] = str(Path(tmp) / "state")
    spec = importlib.util.spec_from_file_location("bridge", repo / "native" / "link-keeper-bridge.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.SOCK_CHECK_S = 0.2
    sock = bridge.state_dir() / "bridge.sock"
    threading.Thread(target=bridge.serve_socket, args=(sock,), daemon=True).start()

    check("the socket is made", wait_for(sock, 2))
    first = ask(sock)
    check("...and answers", isinstance(first, dict) and first.get("live") is True, str(first))
    sock.unlink()
    check("deleted, it is made again", wait_for(sock, 2))
    again = ask(sock)
    check("...and answers again", again == first, f"{again} vs {first}")

if failed:
    sys.exit("\nsome checks failed")
print("all passed")
