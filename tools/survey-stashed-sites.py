#!/usr/bin/env python3
# DESC: Count Link Keeper's stashed links per site, and show the URL shapes behind chosen sites.
"""Survey what the stashes hold, read from a copy of the Firefox profile's bookmarks.

Answers "which sites fill my stashes, and which of their pages are main pages (an inbox, a feed)
rather than items (one email, one post)" — the question behind the filtered-out rules. Long ids
in a path or #part are shown as <id>, so an inbox and the emails under it read apart.

Usage:
    ./survey-stashed-sites.py                       # links per site, most first
    ./survey-stashed-sites.py --top 100
    ./survey-stashed-sites.py --shapes mail.google.com,reddit.com
    ./survey-stashed-sites.py --profile <profile dir>   # default: the profile with Link Keeper

The profile's places.sqlite is copied to a temporary folder first; Firefox may stay open.
"""

from __future__ import annotations

import argparse
import collections
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse
from pathlib import Path

ROOT_TITLE = "Link Keeper stashes"
PROFILES = Path.home() / "Library/Application Support/Firefox/Profiles"


def find_profile() -> Path:
    for ext in sorted(PROFILES.glob("*/extensions.json")):
        if "Link Keeper" in ext.read_text(errors="ignore"):
            return ext.parent
    sys.exit(f"no Firefox profile with Link Keeper under {PROFILES}; pass --profile")


def stashed(profile: Path) -> list[tuple[str, str]]:
    with tempfile.TemporaryDirectory() as tmp:
        for name in ("places.sqlite", "places.sqlite-wal"):
            if (profile / name).exists():
                shutil.copy2(profile / name, Path(tmp) / name)
        db = sqlite3.connect(Path(tmp) / "places.sqlite")
        root = db.execute("select id from moz_bookmarks where title=? and type=2", (ROOT_TITLE,)).fetchone()
        if not root:
            sys.exit(f"no '{ROOT_TITLE}' folder in {profile}")
        rows = db.execute(
            """with recursive t(id) as (select ? union all
                 select b.id from moz_bookmarks b join t on b.parent = t.id where b.type = 2)
               select p.url, coalesce(b.title, '') from moz_bookmarks b join moz_places p on p.id = b.fk
               where b.parent in (select id from t)""", root).fetchall()
        db.close()
    return rows


def site(url: str) -> str:
    u = urllib.parse.urlsplit(url)
    return (u.hostname or u.scheme).removeprefix("www.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Count stashed links per site, or show URL shapes for some sites.")
    ap.add_argument("--profile", type=Path, help="Firefox profile directory (default: the one with Link Keeper)")
    ap.add_argument("--top", type=int, default=60, help="how many sites to list (default 60)")
    ap.add_argument("--shapes", help="comma-separated sites whose URL shapes to show")
    args = ap.parse_args()

    rows = stashed(args.profile or find_profile())
    if args.shapes:
        for host in args.shapes.split(","):
            print(f"== {host}")
            shapes = collections.Counter()
            for url, title in rows:
                if site(url) != host:
                    continue
                u = urllib.parse.urlsplit(url)
                shape = re.sub(r"[A-Za-z0-9_-]{16,}", "<id>", u.path + (f"#{u.fragment}" if u.fragment else ""))
                shapes[(shape[:60], title[:45])] += 1
            for (shape, title), n in shapes.most_common(15):
                print(f"  {n:4}  {shape:60}  {title}")
        return
    print(f"{len(rows)} stashed links")
    counts = collections.Counter(site(u) for u, _ in rows)
    example = {}
    for url, title in rows:
        example.setdefault(site(url), title)
    for host, n in counts.most_common(args.top):
        print(f"{n:5}  {host:40}  {example[host][:60]}")


if __name__ == "__main__":
    main()
