#!/usr/bin/env python3
# DESC: Turn a capture JSONL into window.MOCK for the page preview: list rows, popup status, a sample message.
"""Mock data for preview.zsh, drawn from real captures so text lengths, scripts and emoji are realistic.

Every state the pages render appears at least once: all four statuses, a current item, a note, a
verdict each way, links, an author's reply link, a thumbnail, an image that fails to load, a stored
screenshot preview, unread links from several domains, and loose captures dated in X's own format.
No remote URLs are used for images, so rendering the preview makes no requests off this machine.

Usage:
    ./make-mock.py captures.jsonl out/mock-data.js
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import quote

STATUSES = ["kept", "kept", "kept", "pending", "seen", "kept", "kept", "kept", "skipped", "pending"]
UNREAD = [
    "https://www.linkedin.com/posts/some-post-123",
    "https://maps.app.goo.gl/abc123",
    "https://news.ycombinator.com/item?id=49246804",
    "https://apkpure.com/some-app/com.example",
    "https://decathlon.com.tr/p/btwin-100",
]
LONG_NEXT = "https://liveops.example-internal.com/prod/reward-service/v2/campaigns/autumn-event/rewards?tier=gold"


def svg(body: str, w: int, h: int) -> str:
    return "data:image/svg+xml," + quote(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">{body}</svg>')


THUMB = svg('<rect width="320" height="560" fill="#2b3040"/><rect x="20" y="20" width="280" height="40" rx="6" fill="#4a5470"/>'
            '<rect x="20" y="80" width="200" height="12" rx="4" fill="#5d6785"/>', 320, 560)
IMAGE = svg('<rect width="400" height="240" fill="#6b5b95"/><circle cx="200" cy="120" r="60" fill="#b8a9e0"/>', 400, 240)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build window.MOCK for the page preview from a capture JSONL.")
    p.add_argument("captures", type=Path, help="capture JSONL (link-captures-all.jsonl)")
    p.add_argument("out", type=Path, help="JavaScript file to write")
    return p.parse_args()


def read(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records


def handle(c: dict) -> str | None:
    return (c.get("author") or {}).get("handle")


def cap(c: dict, i: int) -> dict:
    links = [l.get("resolved") or l.get("href") for l in c.get("links") or [] if isinstance(l, dict)]
    return {
        "title": c.get("title"), "handle": handle(c), "text": c.get("text"), "kind": c.get("kind"),
        "links": links[:3] or ([f"https://github.com/example/tool-{i}"] if i % 5 == 1 else []),
        "reply_links": [{"href": "https://github.com/author/repo", "from": "@author", "self": True}] if i == 3 else [],
        "images": [IMAGE, "missing.png"] if i in (0, 4) else [],
        "screenshot": "link-keeper/x-preview.png" if i == 2 else None,
        "shotThumb": THUMB if i == 2 else None,
        "shotId": 1 if i == 2 else None,
        "verdict": "keep" if i == 6 else ("drop" if i == 7 else None),
    }


def main() -> int:
    args = parse_args()
    if not args.captures.is_file():
        print(f"no such capture file: {args.captures}", file=sys.stderr)
        return 1
    records = read(args.captures)
    tweets = [c for c in records if c.get("kind") == "tweet" and c.get("text")]
    reels = [c for c in records if c.get("kind") == "reel"]
    pages = [c for c in records if c.get("kind") not in ("tweet", "reel") and c.get("title")]
    posted = [c for c in tweets if c.get("posted")]
    if len(tweets) < 8:
        print("the capture file needs at least 8 tweet captures to cover every state", file=sys.stderr)
        return 1

    items = []
    for i, c in enumerate(tweets[:18] + reels[:4] + pages[:6]):
        status = STATUSES[i % len(STATUSES)]
        items.append({
            "url": c.get("url"), "status": status, "added_at": c.get("captured_at"),
            "saved_at": c.get("saved_at") or (c.get("captured_at") or "")[:10] or None,
            "note": "the launcher I wanted" if i == 5 else None,
            "current": i == 4,
            "cap": cap(c, i) if status != "pending" or i == 9 else None,
        })
    for url in UNREAD:
        items.append({"url": url, "status": "pending", "added_at": None, "saved_at": "2026-01-01",
                      "note": None, "current": False, "cap": None})
    loose = [{"url": c["url"], "status": "kept", "added_at": c.get("captured_at"), "saved_at": c["posted"],
              "note": None, "current": False, "cap": cap(c, 20 + i)} for i, c in enumerate(posted[-3:])]

    counts = {"pending": 0, "seen": 0, "kept": 0, "skipped": 0}
    for item in items:
        counts[item["status"]] += 1
    recent = [{
        "label": (f"{handle(c)}: " if handle(c) else "") + " ".join((c.get("text") or "").split())[:90] + "…",
        "url": c["url"], "links": len(c.get("links") or []),
    } for c in reversed(tweets[:4])]
    status = {
        "counts": counts, "total": len(items), "captures": len(records),
        "current": {"url": items[4]["url"], "isOpen": False},
        "next": LONG_NEXT, "upcoming": [], "recent": recent,
    }
    first = tweets[0]
    msg = (f"kept: {handle(first) or 'a page'} — {' '.join((first.get('text') or '').split())[:60]} (+3 links)\n"
           "png 1346×32000 from 31 tiles → link-keeper/x-preview.png")

    mock = {"status": status, "dump": {"items": items, "loose": loose}, "msg": msg}
    args.out.write_text("window.MOCK = " + json.dumps(mock, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"mock: {len(items)} rows, {len(loose)} loose → {args.out.name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
