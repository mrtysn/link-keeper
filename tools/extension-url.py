#!/usr/bin/env python3
# DESC: Print the moz-extension:// URL of one of this add-on's pages, by reading Firefox's profile.
"""Work out the internal URL of an extension page.

An extension's pages live at `moz-extension://<uuid>/…`, where the uuid is assigned per install and
is not the add-on id. Firefox records the mapping in `extensions.webextensions.uuids` in prefs.js, so
it can be looked up rather than guessed — which is what lets a script open the add-on's own page.

Two things to know. The uuid is stable for an install but changes if the add-on is removed and added
again, so this is read fresh each time rather than cached. And prefs.js is only written periodically,
so a brand-new install may not appear until Firefox next flushes it; the caller should treat "not
found" as normal and fall back.

Usage:
    ./extension-url.py list.html                 # id read from ../extension/manifest.json
    ./extension-url.py cards.html --id foo@bar
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from pathlib import Path

PROFILE_GLOBS = (
    "~/Library/Application Support/Firefox/Profiles/*/prefs.js",   # macOS
    "~/.mozilla/firefox/*/prefs.js",                               # Linux
    "~/AppData/Roaming/Mozilla/Firefox/Profiles/*/prefs.js",       # Windows
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Print a moz-extension:// URL for an add-on page.")
    p.add_argument("page", nargs="?", default="list.html", help="page inside the add-on")
    p.add_argument("--id", help="add-on id (default: read from ../extension/manifest.json)")
    return p.parse_args()


def addon_id(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    manifest = Path(__file__).resolve().parent.parent / "extension" / "manifest.json"
    try:
        return (json.loads(manifest.read_text(encoding="utf-8"))
                .get("browser_specific_settings", {}).get("gecko", {}).get("id"))
    except (OSError, json.JSONDecodeError):
        return None


def uuid_for(target: str) -> str | None:
    """Newest profile that knows this add-on wins, so a second profile cannot shadow the live one."""
    candidates: list[tuple[float, str]] = []
    for pattern in PROFILE_GLOBS:
        for path in glob.glob(os.path.expanduser(pattern)):
            try:
                text = Path(path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            m = re.search(r'user_pref\("extensions\.webextensions\.uuids",\s*"(.*?)"\);', text, re.S)
            if not m:
                continue
            try:
                mapping = json.loads(m.group(1).replace('\\"', '"'))
            except json.JSONDecodeError:
                continue
            if target in mapping:
                candidates.append((os.path.getmtime(path), mapping[target]))
    if not candidates:
        return None
    return max(candidates)[1]


def main() -> int:
    args = parse_args()
    ident = addon_id(args.id)
    if not ident:
        print("could not determine the add-on id", file=sys.stderr)
        return 1
    uuid = uuid_for(ident)
    if not uuid:
        print(f"no uuid recorded for {ident} in any Firefox profile", file=sys.stderr)
        return 1
    print(f"moz-extension://{uuid}/{args.page.lstrip('/')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
