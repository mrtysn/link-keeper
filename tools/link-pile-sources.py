#!/usr/bin/env python3
# DESC: Print, as JSON, every link the import's sources hold, where each came from and what its capture read; the input of `link-keeper pile`.
"""The import's side of `link-keeper pile`.

Reads what tools/import-links.zsh leaves in the data folder (link-captures-ig.jsonl, link-captures-xdm.jsonl,
link-inbox.tsv, link-captures-all.jsonl) and, when one is named, a Telegram export's result.json, with
tools/link_sources.py. Prints one JSON object and joins nothing: `link-keeper pile` joins the rows with what
link-keeper holds on the extension's own link keys.

  {"dir": folder, "files": [names read],
   "rows":     [{"url", "date", "context", "origin": {"source", "thread", "senders", "accounts"}}],
   "captures": [{"url", "source_url", "status_id", "title", "author", "text", "quote", "links", "note", "posted"}],
   "schemeless": [{"url", "date", "context"}]}

A row is one link in one source (a link in two sources is two rows). A capture is a record of the capture
file that read something.

Usage: link-pile-sources.py [--data-dir DIR] [--telegram result.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import link_sources as ls  # noqa: E402
from telegram_export import extract_links  # noqa: E402

TEXT_LIMIT = 3000      # a capture's text is clipped here; the pile is for judging, the capture for reading


def capture_view(rec: dict) -> dict | None:
    """What a capture record read, in the pile's words; None when it read nothing."""
    author = rec.get("author") or {}
    inner = [(l if isinstance(l, str) else l.get("resolved") or l.get("href"))
             for l in (rec.get("links") or []) if isinstance(l, str) or l.get("resolved") or l.get("href")]
    quoted = rec.get("quoted") or {}
    text = rec.get("text") or rec.get("description") or rec.get("fallback_text") or ""
    got = {"title": rec.get("title"), "author": author.get("handle") or author.get("name"),
           "text": text[:TEXT_LIMIT], "quote": (quoted.get("text") or "")[:TEXT_LIMIT],
           "links": list(dict.fromkeys(inner)), "note": rec.get("note"), "posted": rec.get("posted")}
    got = {k: v for k, v in got.items() if v}
    return got if got.keys() - {"posted"} else None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", type=Path, help="the folder holding the import's files (default: as the import finds it)")
    p.add_argument("--telegram", type=Path, help="a Telegram export's result.json")
    a = p.parse_args()
    if a.data_dir:
        os.environ["DATA_DIR"] = str(a.data_dir.expanduser())
    if a.telegram and not a.telegram.is_file():
        print(f"no such Telegram export: {a.telegram}", file=sys.stderr)
        return 1
    inp = ls.Inputs(SimpleNamespace(export=a.telegram, instagram=None, x=None, inbox=None, captures=None))
    files = [f.name for f in (inp.instagram, inp.x, inp.inbox, inp.captures) if f]
    rows, schemeless = [], []

    def add(url, date, context, source, threads, senders=(), accounts=()):
        rows.append({"url": url, "date": date or "", "context": context or "",
                     "origin": {"source": source, "thread": list(threads), "senders": list(senders), "accounts": list(accounts)}})

    if inp.telegram:
        files.append(inp.telegram.name)
        linked, loose, stats = extract_links(inp.telegram)
        for r in linked:
            add(r["url"], r["date"], r["context"], "telegram", [stats["chat"]])
        schemeless = [{"url": r["url"], "date": r["date"], "context": r["context"]} for r in loose]
    for source, records in (("instagram", ls.read_dm_captures(inp.instagram, "instagram")),
                            ("x", ls.read_dm_captures(inp.x, "x")),
                            ("phone", ls.read_phone_inbox(inp.inbox))):
        for r in records:
            add(r["url"], r["date"], "", source, r["threads"], r["senders"], r["accounts"])

    captures = []
    for rec in ls.read_jsonl(inp.captures):
        view = capture_view(rec)
        if rec.get("url") and view:
            captures.append({"url": rec["url"], "source_url": rec.get("source_url"),
                             "status_id": str(rec["status_id"]) if rec.get("status_id") else None, **view})
    json.dump({"dir": str(inp.base), "files": files, "rows": rows, "captures": captures, "schemeless": schemeless},
              sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
