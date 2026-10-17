#!/usr/bin/env python3
# DESC: Check that only one Firefox profile writes and reads Link Keeper's backup folder (native/link-keeper-bridge.py).
"""Load the helper with its backup folder in a temp directory and play several Firefox profiles at it:
how a profile is read from Firefox's arguments, the first full backup claiming the folder, a
near-empty profile unable to claim it, and another profile (a copy, a test profile) refused writes and
reads. No Firefox, no network.

    tools/test-bridge-owner.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


def data(links: int) -> dict:
    return {"format": "link-keeper-backup", "storage": {"items": [{"url": f"https://a.example/{i}"} for i in range(links // 2)]},
            "sessions": [{"name": "s", "tabs": [{"url": f"https://b.example/{i}"} for i in range(links - links // 2)]}]}


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    os.environ["LINK_KEEPER_BACKUP_DIR"] = str(tmp / "backups")
    os.environ["LINK_KEEPER_STATE_DIR"] = str(tmp / "state")
    spec = importlib.util.spec_from_file_location("bridge", repo / "native" / "link-keeper-bridge.py")
    b = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(b)
    folder = tmp / "backups"

    fx = "/Applications/Firefox.app/Contents/MacOS/firefox"
    check("a Dock launch is the default profile", b.firefox_profile(fx) == "default")
    check("...and so is one launched with the control-port flags", b.firefox_profile(f"{fx} --marionette --remote-allow-system-access") == "default")
    check("-profile names the folder", b.firefox_profile(f"{fx} -profile {tmp}/copy -no-remote") == f"path:{os.path.realpath(tmp / 'copy')}")
    check("...as does --profile=", b.firefox_profile(f"{fx} --profile={tmp}/copy") == f"path:{os.path.realpath(tmp / 'copy')}")
    check("-P names a profile", b.firefox_profile(f"{fx} -P work") == "name:work")

    b.PROFILE = "default"
    folder.mkdir()
    (folder / "latest.json").write_text(json.dumps(data(100)))
    small = b.write_backup(data(13), "change")
    check("unclaimed, a backup under half the last one's size is refused", not small["ok"] and "13 links" in small["error"] and not (folder / ".owner.json").exists(), str(small))
    check("...and the folder keeps the last one", b.link_count(json.loads((folder / "latest.json").read_text())) == 100)
    full = b.write_backup(data(90), "change")
    check("a full one is written and claims the folder for its profile", full["ok"] and json.loads((folder / ".owner.json").read_text())["profile"] == "default", str(full))
    check("the owner reads its backups", b.read_backup("latest.json")["ok"] and b.list_backups()["ok"])
    check("...and shrinks as it likes once it owns the folder", b.write_backup(data(10), "change")["ok"])
    check("the owner file is not listed as a backup", ".owner.json" not in [x["name"] for x in b.list_backups()["backups"]])

    b.PROFILE = f"path:{tmp}/copy-of-default"
    check("another profile is told why", b.foreign() and "another Firefox profile" in b.foreign())
    w = b.write_backup(data(500), "change")
    check("...writes nothing, however big", not w["ok"] and b.link_count(json.loads((folder / "latest.json").read_text())) == 10, str(w))
    check("...and reads nothing, so it cannot restore the owner's data into itself",
          not b.read_backup("latest.json")["ok"] and not b.list_backups()["ok"])
    check("...nor writes a pre-restore file", not b.write_backup(data(5), "pre-restore")["ok"])

if failed:
    sys.exit("\nsome checks failed")
print("all passed")
