"""Guess tags for untagged links with the local gutsy-inference decision server.

gutsy-inference speaks the same `/v1/systemone` wire shape as system-one, so the questions, the batched
`noul` call per link and the answer cache are those of suggest_system_one.py; only the server differs.
Its install folder is a machine value, `GUTSY_DIR` in config.local.sh. A run starts
`$GUTSY_DIR/.venv/bin/gutsy-inference serve` (from that folder, where it finds models.json) when nothing
listens on its port, waits for `/health`, and stops the server afterwards only if it started it.
"""

from __future__ import annotations

import contextlib
import subprocess
import time
from pathlib import Path

import suggest_system_one as s1
import tagdata

GUTSY_PORT = 8765
GUTSY_THRESHOLD = 0.50
START_WAIT_SECONDS = 180
STOP_WAIT_SECONDS = 15
ANSWERS_FILE = "gutsy-answers.json"
LOG_FILE = "gutsy-server.log"


def gutsy_dir() -> Path | None:
    """The install folder from GUTSY_DIR (environment, else config.local.sh); None when unset."""
    configured = tagdata.config_value("GUTSY_DIR")
    return Path(configured).expanduser() if configured else None


def skip_line() -> str:
    return "gutsy skipped: GUTSY_DIR is not set (add it to config.local.sh; see config.local.sh.example)"


@contextlib.contextmanager
def gutsy_server(install: Path, log_path: Path, port: int = GUTSY_PORT):
    """Yield the server's port; the server runs for the duration and is stopped afterwards only when
    this call started it."""
    binary = install / ".venv" / "bin" / "gutsy-inference"
    if s1.server_ready(port):
        yield port
        return
    if not binary.is_file():
        raise RuntimeError(f"gutsy: {binary} not found; check GUTSY_DIR in config.local.sh")
    with open(log_path, "w") as log:
        proc = subprocess.Popen([str(binary), "serve", "--port", str(port)], cwd=install, stdout=log,
                                stderr=subprocess.STDOUT, start_new_session=True)
    try:
        deadline = time.time() + START_WAIT_SECONDS
        while not s1.server_ready(port):
            if proc.poll() is not None:
                raise RuntimeError(f"gutsy-inference exited with {proc.returncode}; see {log_path}")
            if time.time() > deadline:
                raise RuntimeError(f"gutsy-inference was not ready after {START_WAIT_SECONDS} s; see {log_path}")
            time.sleep(1)
        yield port
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(STOP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
