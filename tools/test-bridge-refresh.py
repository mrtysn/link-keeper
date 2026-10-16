#!/usr/bin/env python3
# DESC: Check the helper's refresh commands (native/link-keeper-bridge.py) against a stand-in refresh.zsh.
"""Run the bridge's refresh-start and refresh-status against a fake repo whose tools/refresh.zsh only
prints a few lines and exits, with HOME and the state folder in a temp directory: no real refresh, no
network, the real log untouched.

    tools/test-bridge-refresh.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import time
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    os.environ["HOME"] = str(tmp)
    os.environ["LINK_KEEPER_STATE_DIR"] = str(tmp / "state")
    spec = importlib.util.spec_from_file_location("bridge", repo / "native" / "link-keeper-bridge.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    fake = tmp / "repo"
    (fake / "tools").mkdir(parents=True)
    script = fake / "tools" / "refresh.zsh"
    script.write_text('#!/bin/zsh\nprint "export : somewhere"\nprint "flags: $*"\nsleep 1\nprint "5/8  merging"\nexit 3\n')
    script.chmod(0o755)
    bridge.REPO = fake
    bridge.REFRESH_LOG = tmp / "Library/Logs/link-refresh.log"

    check("nothing has run: not running, no lines", bridge.refresh_status() == {"ok": True, "running": False, "started": None, "lines": [], "exit": None},
          str(bridge.refresh_status()))
    started = bridge.refresh_start(offline=True)
    check("refresh-start runs the script", started["ok"] and started["pid"] > 0, str(started))
    check("a second start while it runs is refused", bridge.refresh_start(offline=False) == {"ok": False, "error": "a refresh is already running"})
    time.sleep(0.4)
    st = bridge.refresh_status()
    check("while it runs: running, and its lines so far", st["running"] and any("export : somewhere" in l for l in st["lines"]), str(st))
    check("...with --no-open, and --offline when asked", any(l == "flags: --no-open --offline" for l in st["lines"]), str(st["lines"]))
    for _ in range(40):
        if not bridge.refresh_status()["running"]:
            break
        time.sleep(0.25)
    st = bridge.refresh_status()
    check("when it ends: not running, its exit code and its last lines", not st["running"] and st["exit"] == 3 and "5/8  merging" in st["lines"], str(st))
    check("the run's lines start at its own '--- refresh' line", st["lines"][0].startswith("--- refresh ") and st["lines"][0].endswith("(offline)"), st["lines"][0])
    again = bridge.refresh_start(offline=False)
    time.sleep(1.6)
    st = bridge.refresh_status()
    check("a later run shows only its own lines", st["lines"][0].startswith("--- refresh ") and not st["lines"][0].endswith("(offline)")
          and sum(l.startswith("--- refresh ") for l in st["lines"]) == 1, str(st["lines"]))

if failed:
    sys.exit("\nsome checks failed")
print("all passed")
