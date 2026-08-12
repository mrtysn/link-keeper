#!/usr/bin/env python3
# DESC: Resolve ordinary web links into Link Keeper captures from og: tags and a few free APIs.
"""Turn `URL<TAB>date` lines into capture records for everything that is not x.com.

Most saved links are ordinary pages that answer a plain GET, so their title and description come
straight from `og:` tags. Three sites are worth special-casing because a free API returns better
data than scraping their HTML:

  github.com              the repo API gives description, stars, language and topics, and does not
                          rate-limit a browser-shaped scrape the way the site does
  news.ycombinator.com    the Algolia API gives the title, the points, and — the useful part — the
                          story's own outbound URL, which is the thing worth keeping
  youtube.com / youtu.be  oembed gives title and channel with no API key

## What this cannot get

Sites behind a bot check answer `403 Just a moment…` to anything that is not a real browser, and
login walls answer with a shell. Those URLs are written to `--failed-to` rather than guessed at.
Two ways to finish them off: run that list through a crawler with its own infrastructure — Exa's
fetch gets through Cloudflare where this does not — or open them in the extension, which is a real
logged-in browser and always works.
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")

META = r'<meta[^>]+(?:property|name)=["\']{k}["\'][^>]*content=["\']([^"\']*)["\']'
META_REV = r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']{k}["\']'
TITLE_RE = re.compile(r"<title[^>]*>([^<]{1,300})", re.I)
# Titles a bot check or a login wall serves in place of the page.
JUNK_TITLE = re.compile(
    r"^\s*(just a moment|attention required|access denied|are you a robot|"
    r"instagram|linkedin|google maps|itch\.io|log in|sign in|403 forbidden|"
    r"rate limit|security check|verifying)", re.I)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Resolve non-x.com links into Link Keeper capture records.",
        epilog="Reads URL<TAB>date on stdin. Capture JSONL on stdout, report on stderr.")
    p.add_argument("-i", "--input", help="read from this file instead of stdin")
    p.add_argument("--failed-to", help="write URLs that could not be resolved to this file")
    p.add_argument("--limit", type=int, help="stop after this many links")
    p.add_argument("--pace", type=float, default=0.2, help="seconds between requests")
    p.add_argument("--timeout", type=float, default=12.0, help="per-request timeout")
    return p.parse_args()


def get(url: str, timeout: float, as_json: bool = False):
    """Returns (payload, final_url, status). Never raises; a failure is (None, url, code)."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json" if as_json else "text/html,application/xhtml+xml",
        "Accept-Language": "en,tr;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as fh:
            raw = fh.read(400_000)
            final = fh.geturl()
            if as_json:
                return json.loads(raw.decode("utf-8", "replace")), final, 200
            charset = fh.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, "replace"), final, 200
    except urllib.error.HTTPError as exc:
        return None, url, exc.code
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return None, url, 0


def meta(html: str, key: str) -> str | None:
    for pattern in (META, META_REV):
        m = re.search(pattern.replace("{k}", re.escape(key)), html, re.I)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return None


def unescape(text: str | None) -> str | None:
    if not text:
        return None
    import html as htmllib
    return htmllib.unescape(text).strip() or None


# --- the three worth special-casing --------------------------------------------

def from_github(url: str, timeout: float) -> dict | None:
    m = re.match(r"https?://(?:www\.)?github\.com/([^/#?]+)/([^/#?]+)", url)
    if not m:
        return None
    owner, repo = m.group(1), m.group(2).removesuffix(".git")
    data, _, code = get(f"https://api.github.com/repos/{owner}/{repo}", timeout, as_json=True)
    if not data or code != 200:
        return None
    topics = data.get("topics") or []
    return {
        "kind": "repo",
        "title": data.get("full_name") or f"{owner}/{repo}",
        "text": data.get("description"),
        "author": {"name": owner, "handle": owner},
        "posted": data.get("created_at"),
        "stars": data.get("stargazers_count"),
        "lang": data.get("language"),
        "topics": topics,
        "links": [{"href": data["homepage"], "display": data["homepage"], "resolved": data["homepage"]}]
        if data.get("homepage") else [],
    }


def from_hn(url: str, timeout: float) -> dict | None:
    m = re.search(r"news\.ycombinator\.com/item\?id=(\d+)", url)
    if not m:
        return None
    data, _, code = get(f"https://hn.algolia.com/api/v1/items/{m.group(1)}", timeout, as_json=True)
    if not data or code != 200:
        return None
    story = data.get("url")
    return {
        "kind": "hn-item",
        "title": data.get("title") or "Hacker News item",
        "text": data.get("text"),
        "author": {"name": data.get("author"), "handle": data.get("author")},
        "posted": data.get("created_at"),
        "points": data.get("points"),
        # The story's own URL is the reason to keep an HN item; the discussion is secondary.
        "links": [{"href": story, "display": story, "resolved": story}] if story else [],
    }


def from_youtube(url: str, timeout: float) -> dict | None:
    if not re.search(r"(youtube\.com/(watch|shorts/|live/)|youtu\.be/)", url, re.I):
        return None
    oembed = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe="")
    data, _, code = get(oembed, timeout, as_json=True)
    if not data or code != 200:
        return None
    return {
        "kind": "video",
        "title": data.get("title"),
        "author": {"name": data.get("author_name"), "handle": None},
        "images": [data["thumbnail_url"]] if data.get("thumbnail_url") else [],
    }


SPECIAL = (from_github, from_hn, from_youtube)


def from_html(url: str, timeout: float) -> tuple[dict | None, int, str]:
    html, final, code = get(url, timeout)
    if not html:
        return None, code, url
    title = unescape(meta(html, "og:title")) or unescape(
        (TITLE_RE.search(html) or [None, None])[1] if TITLE_RE.search(html) else None)
    if not title:
        m = TITLE_RE.search(html)
        title = unescape(m.group(1)) if m else None
    if not title or JUNK_TITLE.match(title):
        return None, code, final
    return {
        "kind": "page",
        "title": title,
        "text": unescape(meta(html, "og:description")) or unescape(meta(html, "description")),
        "author": {"name": unescape(meta(html, "author")), "handle": None},
        "posted": meta(html, "article:published_time"),
        "site": unescape(meta(html, "og:site_name")),
        "images": [meta(html, "og:image")] if meta(html, "og:image") else [],
    }, code, final


def build(base: dict, url: str, final_url: str, saved_at: str) -> dict:
    author = base.get("author") or {}
    record = {
        "kind": base.get("kind", "page"),
        "url": (final_url or url).split("#")[0],
        "source_url": url if (final_url or url) != url else None,
        "title": base.get("title"),
        "text": base.get("text"),
        "author": {"name": author.get("name"), "handle": author.get("handle")},
        "posted": base.get("posted"),
        "saved_at": saved_at or None,
        "links": base.get("links") or [],
        "images": [i for i in (base.get("images") or []) if i],
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "via": base.get("via", "web"),
    }
    for extra in ("stars", "lang", "topics", "points", "site"):
        if base.get(extra):
            record[extra] = base[extra]
    return {k: v for k, v in record.items() if v not in (None, [], {})}


def main() -> int:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    args = parse_args()

    source = open(args.input, encoding="utf-8") if args.input else sys.stdin
    todo, seen = [], set()
    for line in source:
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t") if "\t" in line else line.split(None, 1)
        url = parts[0]
        if not url.lower().startswith(("http://", "https://")):
            continue
        if re.match(r"https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/[^/]+/status/\d+", url, re.I):
            continue   # enrich-x.py owns those
        if url in seen:
            continue
        seen.add(url)
        todo.append((url, parts[1].strip() if len(parts) > 1 else ""))

    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} non-x.com links to resolve", file=sys.stderr)

    ok, failed = 0, []
    kinds: dict[str, int] = {}
    started = time.time()

    for n, (url, date) in enumerate(todo, 1):
        base = None
        for handler in SPECIAL:
            base = handler(url, args.timeout)
            if base:
                base["via"] = "api"
                break
        final = url
        code = 200
        if not base:
            base, code, final = from_html(url, args.timeout)

        if base:
            record = build(base, url, final, date)
            kinds[record["kind"]] = kinds.get(record["kind"], 0) + 1
            print(json.dumps(record, ensure_ascii=False), flush=True)
            ok += 1
        else:
            failed.append((url, date, code))
            print(f"  ! {code or 'no response'}  {url[:88]}", file=sys.stderr)

        if n % 30 == 0:
            print(f"  … {n}/{len(todo)}", file=sys.stderr)
        time.sleep(args.pace)

    print(f"\nresolved {ok}, unresolved {len(failed)}, in {time.time() - started:.0f}s", file=sys.stderr)
    print(f"  {' · '.join(f'{k} {v}' for k, v in sorted(kinds.items()))}", file=sys.stderr)

    if args.failed_to and failed:
        with open(args.failed_to, "w", encoding="utf-8") as fh:
            for url, date, code in failed:
                fh.write(f"{url}\t{date}\t{code}\n")
        print(f"  unresolved list → {args.failed_to}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
