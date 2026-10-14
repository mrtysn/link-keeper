#!/usr/bin/env python3
# DESC: Put the account, thread and senders a DM link came from back onto capture records the enrichers rebuilt.
"""Copy `account`, `thread` and `senders` from origin lines onto capture records, matched by link.

An importer such as `instagram.py --origins-out` writes one line per link it found in a DM:
`{"url", "account", "thread", "senders"}`. The enrichers read only `URL<TAB>date`, so a link that
went through them comes back without that. This reads the finished capture records (JSONL) and
fills the three fields in wherever a record's `url` or `source_url` matches an origin line — after
dropping the query string, the fragment and a trailing slash from both sides. A record that already
holds a field keeps it; one that matches nothing is passed through untouched.

When the same link has several origin lines, `thread` and `senders` take the union in the order seen.

Usage:
    attach-dm-origin.py origins.jsonl [more-origins.jsonl ...] < captures.jsonl > captures.out.jsonl
    attach-dm-origin.py origins.jsonl --captures captures.jsonl > captures.out.jsonl
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path


def key(url: str | None) -> str:
    return (url or "").split("#")[0].split("?")[0].rstrip("/")


def load_origins(paths: list[Path]) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for path in paths:
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as err:
                sys.exit(f"{path}:{n}: not JSON ({err})")
            k = key(row.get("url"))
            if not k:
                continue
            into = merged.setdefault(k, {})
            if row.get("account") and "account" not in into:
                into["account"] = row["account"]
            for field in ("thread", "senders"):
                seen = into.setdefault(field, [])
                seen += [v for v in row.get(field) or [] if v not in seen]
    return merged


def attach(record: dict, origins: dict[str, dict]) -> dict:
    found = origins.get(key(record.get("url"))) or origins.get(key(record.get("source_url")))
    if not found:
        return record
    for field, value in found.items():
        if value and not record.get(field):
            record[field] = value
    return record


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    p = argparse.ArgumentParser(description="Attach DM origins (account, thread, senders) to capture records.")
    p.add_argument("origins", nargs="+", type=Path, help="origin JSONL file(s), from an importer's --origins-out")
    p.add_argument("--captures", type=Path, help="capture records to read instead of stdin")
    args = p.parse_args()

    for path in args.origins:
        if not path.is_file():
            sys.exit(f"no such origins file: {path}")
    origins = load_origins(args.origins)

    src = args.captures.open() if args.captures else sys.stdin
    for line in src:
        if not line.strip():
            continue
        print(json.dumps(attach(json.loads(line), origins), ensure_ascii=False))


if __name__ == "__main__":
    main()
