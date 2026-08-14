#!/usr/bin/env python3
# DESC: Resolve x.com status links into Link Keeper captures via FxTwitter, no login needed.
"""Turn `URL<TAB>date` lines into capture records for x.com links.

A saved `x.com/i/status/2086314129896378631` carries no information — no author, no text, nothing,
which is the whole problem this repo exists to solve. The usual answer is to open it in a logged-in
browser. For x.com specifically there is a shortcut: FxTwitter's public JSON API resolves a bare
status id to the full post without any authentication, so this half of a pile can be enriched
offline in one pass.

Reads the same format the importers emit, so it composes:

    ./telegram.py result.json | ./enrich-x.py > link-captures.jsonl

Non-x.com lines pass through untouched on stderr as a count; they still need the extension.

## What this cannot get

**Replies.** FxTwitter returns a reply *count*, never reply content, and no `?thread` variant
changes that. Tweets that say "repo in the comments" therefore come back without the repo. The
extension is the only route to those, since the replies exist only in a rendered, logged-in page.
`needs_replies` is set on records that look like they are pointing at one, so they can be found
later.
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# json.dumps(ensure_ascii=False) leaves U+2028/U+2029 raw, and every line-splitter in every language
# treats them as line breaks — which tears a JSONL record in half. Tweets contain them.
LINE_SEPARATORS = str.maketrans({"\u2028": "\\u2028", "\u2029": "\\u2029"})


def jsonl(record: dict) -> str:
    return json.dumps(record, ensure_ascii=False).translate(LINE_SEPARATORS)

API = "https://api.fxtwitter.com/i/status/{}"
STATUS_RE = re.compile(r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/[^/]+/status/(\d+)", re.I)
URL_IN_TEXT = re.compile(r"https?://[^\s<>\"')]+")
# Phrases that mean the payload is incomplete without the replies.
POINTS_AT_REPLIES = re.compile(
    r"\b(in|below|check|see)\s+(the\s+)?(repl(y|ies)|comments?|thread)\b"
    r"|\b(link|repo|code|source|github)\s+(is\s+)?(in|below|👇)"
    r"|👇|🧵|\bthread\b",
    re.I,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Resolve x.com status links into Link Keeper capture records.",
        epilog="Reads URL<TAB>date lines on stdin. Writes capture JSONL on stdout, a report on stderr.",
    )
    p.add_argument("-i", "--input", help="read from this file instead of stdin")
    p.add_argument("--limit", type=int, help="stop after this many links (for a quick trial)")
    p.add_argument("--pace", type=float, default=0.35, help="seconds between requests (default 0.35)")
    p.add_argument("--timeout", type=float, default=15.0, help="per-request timeout in seconds")
    return p.parse_args()


def fetch(status_id: str, timeout: float, attempts: int = 2) -> dict | None:
    """One retry, because a single transient 5xx should not lose a link."""
    last = None
    for n in range(attempts):
        try:
            req = urllib.request.Request(API.format(status_id), headers={"User-Agent": "link-keeper"})
            with urllib.request.urlopen(req, timeout=timeout) as fh:
                return json.loads(fh.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            last = exc
            if n + 1 < attempts:
                time.sleep(1.5)
    print(f"  ! {status_id}: {last}", file=sys.stderr)
    return None


def article_markdown(article: dict) -> tuple[str, list[str]]:
    """Rebuild an X Article as markdown, and return its code blocks separately.

    Prose lives in `content.blocks`; code lives in `content.entityMap` as MARKDOWN entities that
    the blocks reference by position through `atomic` placeholders. Joining only the blocks loses
    every code block, which on a technical article is most of the substance.
    """
    content = article.get("content") or {}
    blocks = content.get("blocks") or []
    entities = content.get("entityMap") or []
    prefix = {"header-one": "# ", "header-two": "## ", "blockquote": "> ", "unordered-list-item": "- "}

    out: list[str] = []
    code: list[str] = []
    for block in blocks:
        if block.get("type") == "atomic":
            ranges = block.get("entityRanges") or []
            idx = ranges[0].get("key") if ranges else None
            entity = entities[idx].get("value", {}) if isinstance(idx, int) and idx < len(entities) else {}
            if entity.get("type") == "MARKDOWN":
                md = (entity.get("data") or {}).get("markdown", "")
                if md:
                    out.append(md)
                    code.append(md)
            elif entity.get("type") == "DIVIDER":
                out.append("---")
            continue
        text = block.get("text", "")
        if text.strip():
            out.append(prefix.get(block.get("type"), "") + text)
    return "\n\n".join(out), code


def images_of(tweet: dict, article: dict) -> list[str]:
    urls = [m.get("url") for m in ((tweet.get("media") or {}).get("all") or []) if m.get("url")]
    if article:
        # Article media carries no plain url field, so take the CDN links out of the raw blob.
        blob = json.dumps({"c": article.get("cover_media"), "m": article.get("media_entities")})
        urls += re.findall(r"https://pbs\.twimg\.com/[^\"\\ ]+", blob)
    return list(dict.fromkeys(urls))


def build(payload: dict, source_url: str, saved_at: str) -> dict:
    tweet = payload.get("tweet") or {}
    author = tweet.get("author") or {}
    article = tweet.get("article") or {}
    handle = author.get("screen_name")

    text = tweet.get("text") or None
    code_blocks: list[str] = []
    if article:
        body, code_blocks = article_markdown(article)
        text = body or article.get("preview_text") or None

    # FxTwitter expands t.co inline, so the destinations are in the text rather than in a field.
    found = [u.rstrip(".,)") for u in URL_IN_TEXT.findall(text or "")]
    found = [u for u in dict.fromkeys(found) if not re.match(r"^https?://(x|twitter)\.com/", u, re.I)]

    return {
        "kind": "x-article" if article else "tweet",
        "url": (tweet.get("url") or source_url).split("?")[0],
        "source_url": source_url,
        "status_id": str(tweet.get("id") or ""),
        "author": {"name": author.get("name"), "handle": f"@{handle}" if handle else None},
        "title": article.get("title") or (f"@{handle} on X" if handle else "X post"),
        "text": text,
        "posted": tweet.get("created_at"),
        "saved_at": saved_at or None,
        "links": [{"href": u, "display": u, "resolved": u} for u in found],
        "images": images_of(tweet, article),
        "code_blocks": code_blocks,
        "media": sorted({m.get("type") for m in ((tweet.get("media") or {}).get("all") or []) if m.get("type")}),
        "replies": tweet.get("replies"),
        "needs_replies": bool(tweet.get("replies")) and bool(POINTS_AT_REPLIES.search(text or "")),
        "engagement": {k: tweet.get(k) for k in ("likes", "retweets", "bookmarks", "views") if tweet.get(k)},
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "via": "fxtwitter",
    }


def main() -> int:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    args = parse_args()

    source = open(args.input, encoding="utf-8") if args.input else sys.stdin
    todo, skipped = [], 0
    for line in source:
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t") if "\t" in line else line.split(None, 1)
        url = parts[0]
        date = parts[1].strip() if len(parts) > 1 else ""
        m = STATUS_RE.match(url)
        if m:
            todo.append((m.group(1), url, date))
        else:
            skipped += 1

    seen: set[str] = set()
    unique = []
    for sid, url, date in todo:
        if sid not in seen:
            seen.add(sid)
            unique.append((sid, url, date))
    if args.limit:
        unique = unique[: args.limit]

    print(f"{len(unique)} x.com links to resolve; {skipped} other links left for the extension",
          file=sys.stderr)

    ok = failed = 0
    counts = {"tweet": 0, "x-article": 0}
    needs = []
    started = time.time()
    for n, (sid, url, date) in enumerate(unique, 1):
        payload = fetch(sid, args.timeout)
        if not payload or payload.get("code") != 200:
            failed += 1
            why = (payload or {}).get("message", "no response")
            print(f"  ! {url} -> {why}", file=sys.stderr)
        else:
            record = build(payload, url, date)
            counts[record["kind"]] = counts.get(record["kind"], 0) + 1
            if record["needs_replies"]:
                needs.append(record)
            print(jsonl(record), flush=True)
            ok += 1
        if n % 25 == 0:
            print(f"  … {n}/{len(unique)}", file=sys.stderr)
        time.sleep(args.pace)

    print(f"\nresolved {ok}, failed {failed}, in {time.time() - started:.0f}s", file=sys.stderr)
    print(f"  tweets {counts.get('tweet', 0)} · articles {counts.get('x-article', 0)}", file=sys.stderr)
    print(f"  {len(needs)} look like they point at their replies (not retrievable here)", file=sys.stderr)
    # No x.com links in the input is a clean run, not a failure — only report failure when
    # there was work and none of it resolved.
    return 0 if ok or not unique else 1


if __name__ == "__main__":
    sys.exit(main())
