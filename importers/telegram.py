#!/usr/bin/env python3
# DESC: Turn a Telegram "Export chat history" result.json into paste-ready lines for Link Keeper.
"""Extract every link from a Telegram Desktop JSON export, newest first.

Telegram marks URLs with `link` text entities, so the links come out already parsed — no regex
over message bodies. Two wrinkles it carries, both handled here:

  * `.sh`, `.py`, `.so` and `.io` are real TLDs, so filenames pasted inside code snippets
    (`deploy.sh`, `server.py`) get entity-tagged as links. Anything without an http(s) scheme is
    withheld from the output and listed by `--schemeless`, because some of those are genuine sites
    typed without a scheme and the difference is not mechanically decidable.
  * Link-preview metadata — title, author, description — is fetched by Telegram at send time and is
    NOT in the export. A bare `x.com/i/status/123` stays bare. Resolving those is the extension's
    job, from inside a logged-in session.

Output is `URL<TAB>YYYY-MM-DD`, which is what the extension's *Add links* box reads, so the date a
link was saved survives the handoff instead of collapsing to the moment of the paste.

Usage:
    ./telegram.py result.json | pbcopy      # paste into Add links
    ./telegram.py result.json --json        # same data as JSONL
    ./telegram.py result.json --schemeless  # the entities withheld above, for eyeballing
    ./telegram.py result.json --stats       # counts, date span, top domains
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Extract links from a Telegram JSON chat export, newest first.",
        epilog="Export from Telegram Desktop: chat menu -> Export chat history, "
        "format 'Machine-readable JSON', media unchecked.",
    )
    p.add_argument("export", type=Path, help="path to the export's result.json")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--json", action="store_true", help="emit JSONL objects instead of URL<TAB>date")
    mode.add_argument("--schemeless", action="store_true", help="list entities that lack a scheme, with context")
    mode.add_argument("--stats", action="store_true", help="summarise instead of listing")
    return p.parse_args()


def entity_text(part) -> str:
    """A message's `text` is a string, or a list mixing strings and entity objects."""
    if isinstance(part, str):
        return part
    if isinstance(part, dict):
        return part.get("text", "")
    return ""


def message_context(msg: dict, urls: set[str]) -> str:
    """Everything typed around the links, with the links themselves removed."""
    text = msg.get("text", "")
    parts = text if isinstance(text, list) else [text]
    kept = [t for t in (entity_text(p) for p in parts) if t and t not in urls]
    return " ".join(" ".join(kept).split())


def collect(export_path: Path) -> tuple[list[dict], list[dict], dict]:
    with export_path.open(encoding="utf-8") as fh:
        data = json.load(fh)

    messages = data.get("messages") or []
    linked: list[dict] = []
    schemeless: list[dict] = []
    seen: set[str] = set()

    for msg in messages:
        hits = [e.get("text", "") for e in (msg.get("text_entities") or []) if e.get("type") == "link"]
        if not hits:
            continue
        context = message_context(msg, set(hits))
        when = (msg.get("date") or "")[:10]

        for url in hits:
            if not url or url in seen:
                continue
            seen.add(url)
            record = {"url": url, "date": when, "context": context}
            target = linked if url.lower().startswith(("http://", "https://")) else schemeless
            target.append(record)

    stats = {
        "messages": len(messages),
        "links": len(linked),
        "schemeless": len(schemeless),
        "with_context": sum(1 for r in linked if r["context"]),
        "chat": data.get("name") or data.get("type") or "chat",
        "dates": sorted(r["date"] for r in linked if r["date"]),
    }
    return linked, schemeless, stats


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower().removeprefix("www.") or "(no host)"


def emit(lines) -> None:
    for line in lines:
        print(line)


def main() -> int:
    # This is a filter, so die the way a filter should when the reader closes the pipe. Python's
    # default turns that into a BrokenPipeError plus noise on stderr at interpreter shutdown.
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    args = parse_args()
    if not args.export.is_file():
        print(f"no such file: {args.export}", file=sys.stderr)
        return 1

    linked, schemeless, stats = collect(args.export)
    newest = sorted(linked, key=lambda r: r["date"], reverse=True)

    if args.stats:
        span = f"{stats['dates'][0]} → {stats['dates'][-1]}" if stats["dates"] else "unknown"
        hosts = Counter(host_of(r["url"]) for r in linked)
        print(f"chat        : {stats['chat']}")
        print(f"messages    : {stats['messages']}")
        print(f"links       : {stats['links']} unique")
        print(f"schemeless  : {stats['schemeless']} withheld (see --schemeless)")
        print(f"with a note : {stats['with_context']}")
        print(f"span        : {span}")
        print("top domains :")
        for host, n in hosts.most_common(10):
            print(f"  {n:>4}  {host}")
        return 0

    if args.schemeless:
        if not schemeless:
            print("none", file=sys.stderr)
            return 0
        emit(f"{r['url']}\t{r['date']}\t{r['context'][:90]}" for r in schemeless)
        return 0

    if args.json:
        emit(json.dumps({"url": r["url"], "saved_at": r["date"]}, ensure_ascii=False) for r in newest)
        return 0

    emit(f"{r['url']}\t{r['date']}" for r in newest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
