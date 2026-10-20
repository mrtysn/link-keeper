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
    for _ in range(40):
        if not bridge.refresh_status()["running"]:
            break
        time.sleep(0.25)
    bridge.refresh_start(offline=False, watch=False)
    time.sleep(0.4)
    check("an Import without watching passes --no-watch", "flags: --no-open --no-watch" in bridge.refresh_status()["lines"],
          str(bridge.refresh_status()["lines"]))

    # The watch worker: a stand-in that turns each queued link into a record, then exits.
    worker = fake / "tools" / "watch-links.zsh"
    worker.write_text('#!/bin/zsh\nq=$2 out=$4\nsleep 0.5\nfor f in $q/*.url(N.Om); do\n'
                      '  print -r -- "{\\"url\\": \\"$(<$f)\\", \\"via\\": \\"watch-reel\\"}" >> $out\n  rm -f $f\ndone\n')
    worker.chmod(0o755)
    bridge.WATCH_LOG = tmp / "Library/Logs/link-watch.log"
    st = bridge.watch_status(0)
    check("nothing watched yet: no worker, no queue, no records", st == {"ok": True, "running": False, "queued": 0, "records": [], "next": 0}, str(st))
    res = bridge.watch_start(["https://www.instagram.com/reel/AAA111/?igsh=x", "https://example.com/page",
                              "https://www.instagram.com/p/BBB222/"])
    check("watch-start queues the instagram links only and starts the worker",
          res["ok"] and res["added"] == 2 and res["running"], str(res))
    again = bridge.watch_start(["https://www.instagram.com/reel/AAA111/"])
    check("a link already queued is not queued twice", again["added"] == 0, str(again))
    for _ in range(40):
        if not bridge.watch_status(0)["running"]:
            break
        time.sleep(0.25)
    st = bridge.watch_status(0)
    check("the worker's records come back, and the queue is empty",
          not st["running"] and st["queued"] == 0 and len(st["records"]) == 2 and st["next"] == 2, str(st))
    check("a cursor returns only the records after it", bridge.watch_status(1)["records"] == st["records"][1:])
    check("a cursor past the end starts from the top", len(bridge.watch_status(9)["records"]) == 2)

if failed:
    sys.exit("\nsome checks failed")
print("all passed")
