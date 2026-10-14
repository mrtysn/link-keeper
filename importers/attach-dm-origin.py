#!/usr/bin/env python3
# DESC: Put the account, thread and senders a DM link came from back onto capture records the enrichers rebuilt.
"""Copy `account`, `thread` and `senders` from origin lines onto capture records, matched by link.

An importer such as `instagram.py --origins-out` writes one line per link it found in a DM:
`{"url", "account", "thread", "senders"}`. The enrichers read only `URL<TAB>date`, so a link that
went through them comes back without that. This reads the finished capture records (JSONL) and
fills the three fields in wherever a record's `url` or `source_url` matches an origin line — after
dropping the query string, the fragment and a trailing slash from both sides. A record that already
holds a field keeps it; one that matches nothing is passed through untouched.

When the same link has several origin lines, `thread` and `senders` take the union in the order seen,
and `account` is the one account's name, or a list when several accounts hold the link.

`--merge-duplicates` also collapses capture records that share a link and carry an origin — the same
reel read from two accounts' exports — into the first, with the union of their accounts, threads and
senders. Records with no origin are never merged.

Usage:
    attach-dm-origin.py origins.jsonl [more-origins.jsonl ...] < captures.jsonl > captures.out.jsonl
    attach-dm-origin.py origins.jsonl --captures captures.jsonl > captures.out.jsonl
    attach-dm-origin.py --merge-duplicates --captures ig-captures.jsonl > merged.jsonl
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path


ORIGIN_LISTS = ("account", "thread", "senders")


def key(url: str | None) -> str:
    return (url or "").split("#")[0].split("?")[0].rstrip("/")


def as_list(value) -> list:
    if value is None or value == "":
        return []
    return list(value) if isinstance(value, list) else [value]


def union(into: dict, row: dict) -> None:
    """Add row's account, thread and senders to into's lists, each value once, in the order seen."""
    for field in ORIGIN_LISTS:
        seen = into.setdefault(field, [])
        seen += [v for v in as_list(row.get(field)) if v not in seen]


def settled(accounts: list):
    """One account stays a string, as importers write it; several become a list."""
    return accounts[0] if len(accounts) == 1 else accounts


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
            union(merged.setdefault(k, {}), row)
    return merged


def attach(record: dict, origins: dict[str, dict]) -> dict:
    found = origins.get(key(record.get("url"))) or origins.get(key(record.get("source_url")))
    if not found:
        return record
    for field, value in found.items():
        if value and not record.get(field):
            record[field] = settled(value) if field == "account" else value
    return record


def merge_duplicates(records: list[dict]) -> list[dict]:
    """Collapse records that share a link and carry an origin into the first, keeping every origin."""
    first: dict[str, dict] = {}
    out = []
    for rec in records:
        k = key(rec.get("url"))
        if not k or not any(as_list(rec.get(f)) for f in ORIGIN_LISTS):
            out.append(rec)
            continue
        if k not in first:
            first[k] = rec
            out.append(rec)
            continue
        keep = first[k]
        merged: dict = {}
        union(merged, keep)
        union(merged, rec)
        keep["account"] = settled(merged["account"]) if merged["account"] else keep.get("account")
        for field in ("thread", "senders"):
            keep[field] = merged[field]
        for field, value in rec.items():
            if value and not keep.get(field):
                keep[field] = value
    return out


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    p = argparse.ArgumentParser(description="Attach DM origins (account, thread, senders) to capture records.")
    p.add_argument("origins", nargs="*", type=Path, help="origin JSONL file(s), from an importer's --origins-out")
    p.add_argument("--captures", type=Path, help="capture records to read instead of stdin")
    p.add_argument("--merge-duplicates", action="store_true",
                   help="collapse records that share a link and carry an origin into one")
    args = p.parse_args()
    if not args.origins and not args.merge_duplicates:
        p.error("give origin files to attach, or --merge-duplicates, or both")

    for path in args.origins:
        if not path.is_file():
            sys.exit(f"no such origins file: {path}")
    origins = load_origins(args.origins)

    src = args.captures.open() if args.captures else sys.stdin
    records = [attach(json.loads(line), origins) for line in src if line.strip()]
    if args.merge_duplicates:
        records = merge_duplicates(records)
    for rec in records:
        print(json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
