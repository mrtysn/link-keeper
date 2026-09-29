#!/usr/bin/env python3
# DESC: List the tab stashes the Firefox extension holds, read straight out of the profile's bookmarks.
"""Show what Link Keeper's stashes hold, without opening Firefox or the extension.

Since 5.9 stashes are bookmarks — Other Bookmarks / Link Keeper stashes / one folder per stash — so
this reads a copy of the profile's places.sqlite and prints each stash with its time and how many
URLs of each kind it holds (https, file, moz-extension, …). Answers "did my stash work" after the
tabs have closed. If the add-on still holds stashes from before bookmarks (not yet moved over), it
says so.

Usage:
    ./stash-status.py
    ./stash-status.py --id foo@bar      # add-on id; default read from ../extension/manifest.json
"""

from __future__ import annotations

import argparse
import collections
import datetime
import importlib.util
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT_TITLE = "Link Keeper stashes"


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_places(profile: Path) -> list[tuple[str, int, list[str]]]:
    """(title, dateAdded µs, [urls]) per stash folder, in bookmark order."""
    with tempfile.TemporaryDirectory() as tmp:
        # Firefox holds places.sqlite open; a copy with its WAL reads consistently.
        for suffix in ("", "-wal"):
            src = profile / f"places.sqlite{suffix}"
            if src.exists():
                shutil.copyfile(src, Path(tmp) / f"places.sqlite{suffix}")
        db = sqlite3.connect(Path(tmp) / "places.sqlite")
        try:
            root = db.execute(
                "SELECT b.id FROM moz_bookmarks b JOIN moz_bookmarks p ON b.parent = p.id "
                "WHERE p.guid = 'unfiled_____' AND b.type = 2 AND b.title = ?", (ROOT_TITLE,)).fetchone()
            if not root:
                return []
            folders = db.execute(
                "SELECT id, title, dateAdded FROM moz_bookmarks WHERE parent = ? AND type = 2 ORDER BY position",
                (root[0],)).fetchall()
            out = []
            for fid, title, added in folders:
                urls = [u for (u,) in db.execute(
                    "SELECT p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id "
                    "WHERE b.parent = ? AND b.type = 1 ORDER BY b.position", (fid,))]
                out.append((title or "", added or 0, urls))
            return out
        finally:
            db.close()


def main() -> int:
    p = argparse.ArgumentParser(description="List the tab stashes the Firefox extension holds.")
    p.add_argument("--id", help="add-on id (default: read from ../extension/manifest.json)")
    args = p.parse_args()

    diff = load("extension_diff", "extension-diff.py")
    ext = diff.load_extension_url()
    ident = ext.addon_id(args.id)
    install = ident and ext.install_for(ident)
    if not install:
        print(f"no install of {ident or 'the add-on'} recorded in any Firefox profile", file=sys.stderr)
        return 2
    profile, uuid = install

    try:
        stashes = read_places(profile)
    except (OSError, sqlite3.Error) as exc:
        print(f"could not read the profile's bookmarks: {exc}", file=sys.stderr)
        return 2

    try:
        values, _ = diff.read_storage(profile, uuid)
        if values.get("sessions"):
            print("the add-on still holds stashes from before bookmarks; they move over when 5.9 or later first runs")
    except (OSError, sqlite3.Error, ValueError):
        pass

    if not stashes:
        print(f"no stashes in {ROOT_TITLE}  ({profile.name})")
        return 0
    total = sum(len(u) for _, _, u in stashes)
    print(f"{len(stashes)} stashes, {total} tabs, in Other Bookmarks / {ROOT_TITLE}  ({profile.name})")
    for title, added, urls in stashes:
        kinds = collections.Counter(u.split(":", 1)[0] for u in urls)
        when = datetime.datetime.fromtimestamp(added / 1e6).strftime("%Y-%m-%d %H:%M") if added else "?"
        detail = ", ".join(f"{n} {k}" for k, n in kinds.most_common())
        print(f"  {when}  {len(urls):>4} tabs  {title[:40]:<40}  {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
