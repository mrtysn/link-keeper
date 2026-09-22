#!/usr/bin/env python3
# DESC: Shared parsing for Telegram Desktop JSON chat exports — messages, link entities, the filename-vs-TLD wrinkle.
"""Load a Telegram "Export chat history" result.json and pull the links out of it.

Telegram marks URLs with `link` text entities, so the links come out already parsed — no regex
over message bodies. One wrinkle is handled here: `.sh`, `.py`, `.so` and `.io` are real TLDs, so
a filename pasted inside a code snippet (`deploy.sh`, `server.py`) gets entity-tagged as a link
too. Anything without an http(s) scheme is kept out of the resolved list and returned separately
as "schemeless", because some of those are genuine sites typed without a scheme and the
difference is not mechanically decidable.

Link-preview metadata (title, author, description) is fetched by Telegram at send time and is
NOT in the export, so a bare `x.com/i/status/123` stays bare — resolving that is downstream work.

`text_link` entities (an explicit markdown link with its own visible text) are not counted as
links here, matching the original behaviour of every script this was extracted from: only
Telegram's auto-detected `link` entities are extracted.

Used by importers/telegram.py, tools/telegram-saved-links.py and tools/chat-to-watchlist.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit


def load_export(export_path: Path | str) -> dict:
    """The raw decoded export: {"name"/"type": ..., "messages": [...]}."""
    with Path(export_path).open(encoding="utf-8") as fh:
        return json.load(fh)


def entity_text(part) -> str:
    """A message's `text` is a string, or a list mixing strings and entity objects."""
    if isinstance(part, str):
        return part
    if isinstance(part, dict):
        return part.get("text", "")
    return ""


def message_text(msg: dict) -> str:
    """Every part of a message's text, concatenated, entities included."""
    text = msg.get("text", "")
    parts = text if isinstance(text, list) else [text]
    return "".join(entity_text(p) for p in parts)


def message_context(msg: dict, urls: set[str]) -> str:
    """Everything typed around a set of links, with the links themselves removed."""
    text = msg.get("text", "")
    parts = text if isinstance(text, list) else [text]
    kept = [t for t in (entity_text(p) for p in parts) if t and t not in urls]
    return " ".join(" ".join(kept).split())


def links_of(msg: dict) -> list[str]:
    """Text of every `link` entity in a message — Telegram's own parse, not a regex."""
    return [e.get("text", "") for e in (msg.get("text_entities") or []) if e.get("type") == "link"]


def split_url(url: str) -> tuple[str, str]:
    """(host without www, everything after it) — path, query and fragment, trailing slash dropped."""
    bits = urlsplit(url)
    host = bits.netloc.lower().removeprefix("www.")
    tail = bits.path or ""
    if bits.query:
        tail += "?" + bits.query
    if bits.fragment:
        tail += "#" + bits.fragment
    return host or "(no host)", tail.rstrip("/") or "/"


def extract_links(export_path: Path | str) -> tuple[list[dict], list[dict], dict]:
    """Every link entity in the export, deduped by URL (first occurrence wins).

    Returns (linked, schemeless, stats). Each record is
    {"url", "date" (YYYY-MM-DD), "context", "host", "tail"}. `linked` holds http(s) links;
    `schemeless` holds entities without a scheme — real sites typed bare and filenames Telegram
    mistook for links, mixed together, since the two are not mechanically separable.
    """
    data = load_export(export_path)
    messages = data.get("messages") or []
    linked: list[dict] = []
    schemeless: list[dict] = []
    seen: set[str] = set()

    for msg in messages:
        hits = links_of(msg)
        if not hits:
            continue
        context = message_context(msg, set(hits))
        when = (msg.get("date") or "")[:10]

        for url in hits:
            if not url or url in seen:
                continue
            seen.add(url)
            host, tail = split_url(url)
            record = {"url": url, "date": when, "context": context, "host": host, "tail": tail}
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
