#!/usr/bin/env python3
# DESC: List the tab stashes the Firefox extension holds, read straight out of the profile.
"""Show what Link Keeper's stashes hold, without opening Firefox or the extension.

Reads the add-on's storage.local the way extension-diff.py does — a copy of its IndexedDB, decoded —
and prints each stash with its time and how many URLs of each kind it recorded (https, file,
moz-extension, …). Answers "did my stash work" after the tabs have closed.

Usage:
    ./stash-status.py
    ./stash-status.py --id foo@bar      # add-on id; default read from ../extension/manifest.json
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ISO = re.compile(r"\d{4}-\d\d-\d\dT[\d:.]+Z")
SCHEMES = {"http", "https", "ftp", "file", "moz-extension", "about", "view-source", "chrome", "data"}


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
        values, written = diff.read_storage(profile, uuid)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"could not read the extension's storage: {exc}", file=sys.stderr)
        return 2

    blob = values.get("sessions")
    if not blob:
        print("no stashes")
        return 0

    # A stash is { id, created_at, name?, tabs: [...] }; its uuid id is the first string of each one.
    stashes, cur = [], None
    for s in diff.clone_strings(blob):
        if UUID.fullmatch(s):
            cur = {"when": None, "name": None, "kinds": collections.Counter()}
            stashes.append(cur)
        elif cur is None:
            continue
        elif cur["when"] is None and ISO.fullmatch(s):
            cur["when"] = s
        elif (m := re.match(r"^([a-z-]+):", s)) and m.group(1) in SCHEMES:
            cur["kinds"][m.group(1)] += 1

    print(f"{len(stashes)} stashes, last written {diff.stamp(written['sessions'])}  ({profile.name})")
    for st in stashes:
        kinds = ", ".join(f"{n} {k}" for k, n in st["kinds"].most_common())
        print(f"  {st['when'] or '?'}  {sum(st['kinds'].values()):>4} tabs  {kinds}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
