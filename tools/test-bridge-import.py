#!/usr/bin/env python3
# DESC: Check the helper's import and watch commands (native/link-keeper-bridge.py) against a stand-in import-links.zsh.
"""Run the bridge's import-start and import-status against a fake repo whose tools/import-links.zsh only
prints a few lines and exits, with HOME and the state folder in a temp directory: no real import, no
network, the real log untouched.

    tools/test-bridge-import.py
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
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
    script = fake / "tools" / "import-links.zsh"
    script.write_text('#!/bin/zsh\nprint "export : somewhere"\nprint "flags: $*"\nsleep 1\nprint "5/8  merging"\nexit 3\n')
    script.chmod(0o755)
    bridge.REPO = fake
    bridge.IMPORT_LOG = tmp / "Library/Logs/link-import.log"

    check("nothing has run: not running, no lines", bridge.import_status() == {"ok": True, "running": False, "started": None, "lines": [], "exit": None},
          str(bridge.import_status()))
    started = bridge.import_start(offline=True)
    check("import-start runs the script", started["ok"] and started["pid"] > 0, str(started))
    check("a second start while it runs is refused", bridge.import_start(offline=False) == {"ok": False, "error": "an import is already running"})
    time.sleep(0.4)
    st = bridge.import_status()
    check("while it runs: running, and its lines so far", st["running"] and any("export : somewhere" in l for l in st["lines"]), str(st))
    check("...with --no-open, and --offline when asked", any(l == "flags: --no-open --offline" for l in st["lines"]), str(st["lines"]))
    for _ in range(40):
        if not bridge.import_status()["running"]:
            break
        time.sleep(0.25)
    st = bridge.import_status()
    check("when it ends: not running, its exit code and its last lines", not st["running"] and st["exit"] == 3 and "5/8  merging" in st["lines"], str(st))
    check("the run's lines start at its own '--- import' line", st["lines"][0].startswith("--- import ") and st["lines"][0].endswith("(offline)"), st["lines"][0])
    again = bridge.import_start(offline=False)
    time.sleep(1.6)
    st = bridge.import_status()
    check("a later run shows only its own lines", st["lines"][0].startswith("--- import ") and not st["lines"][0].endswith("(offline)")
          and sum(l.startswith("--- import ") for l in st["lines"]) == 1, str(st["lines"]))
    for _ in range(40):
        if not bridge.import_status()["running"]:
            break
        time.sleep(0.25)
    bridge.import_start(offline=False, watch=False)
    time.sleep(0.4)
    check("an Import without watching passes --no-watch", "flags: --no-open --no-watch" in bridge.import_status()["lines"],
          str(bridge.import_status()["lines"]))

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

    # The phone inbox: the helper hands back what its script prints as new; exit 3 is "not set up".
    puller = fake / "tools" / "pull-phone-inbox.zsh"
    puller.write_text('#!/bin/zsh\nprint "https://a.example/1\\t2026-10-20"\nprint "not a url"\nprint "https://b.example/2\\t"\n')
    puller.chmod(0o755)
    res = bridge.inbox_pull()
    check("inbox-pull returns the new links with their day, and only links",
          res == {"ok": True, "configured": True, "new": [{"url": "https://a.example/1", "saved_at": "2026-10-20"},
                                                          {"url": "https://b.example/2", "saved_at": None}]}, str(res))
    puller.write_text("#!/bin/zsh\nexit 3\n")
    check("an inbox that is not set up is not an error", bridge.inbox_pull() == {"ok": True, "configured": False, "new": []})
    puller.write_text('#!/bin/zsh\nprint -u2 "  ! could not reach box"\nexit 2\n')
    res = bridge.inbox_pull()
    check("an unreachable inbox says so", not res["ok"] and "could not reach box" in res["error"], str(res))

# The real script against a stand-in ssh: the mirror is written, and only lines new since it are printed.
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    stubs = tmp / "bin"
    stubs.mkdir()
    served = tmp / "server-inbox.tsv"
    (stubs / "ssh").write_text(f'#!/bin/zsh\ncat {served}\n')
    (stubs / "ssh").chmod(0o755)
    env = dict(os.environ, PATH=f"{stubs}:{os.environ['PATH']}", DATA_DIR=str(tmp / "data"), LINK_INBOX_REMOTE="box:/srv/inbox.tsv")
    run = lambda *a: subprocess.run([str(repo / "tools" / "pull-phone-inbox.zsh"), *a], env=env, capture_output=True, text=True)
    served.write_text("https://a.example/1\t2026-10-19\tphone\n")
    first = run("--print-new")
    check("the first pull prints every line as new, URL and day", first.returncode == 0 and first.stdout == "https://a.example/1\t2026-10-19\n", first.stdout + first.stderr)
    served.write_text("https://a.example/1\t2026-10-19\tphone\nhttps://b.example/2\t2026-10-20\tphone\n")
    second = run("--print-new")
    check("the next pull prints only what arrived since", second.stdout == "https://b.example/2\t2026-10-20\n", second.stdout)
    check("...and the mirror holds the whole inbox", (tmp / "data" / "link-inbox.tsv").read_text() == served.read_text())
    check("a summary run says how many are new", "2 in the inbox (mirror of box), 0 new" in run().stdout)
    (stubs / "ssh").write_text("#!/bin/zsh\nexit 255\n")
    down = run("--print-new")
    check("an unreachable server keeps the last mirror and exits 2",
          down.returncode == 2 and (tmp / "data" / "link-inbox.tsv").read_text() == served.read_text(), down.stderr)

if failed:
    sys.exit("\nsome checks failed")
print("all passed")
