#!/usr/bin/env python3
# DESC: Turn an Instagram "Download your information" export into links and capture records.
"""Extract every link you sent to yourself (or saved) on Instagram, newest first.

Instagram has no per-chat export; the account-wide "Download your information" dump (JSON format,
Messages ticked) is the source. Two places in it carry links:

  * your self-thread under `your_instagram_activity/messages/inbox/<thread>/message_N.json` —
    a shared reel or post arrives as a `share` object that already holds the canonical link, the
    caption (`share_text`) and the author (`original_content_owner`);
  * `your_instagram_activity/saved/saved_posts.json`, if "Saved" was ticked too.

Because the caption and author are IN the export, instagram.com links need no enrichment fetch —
which is fortunate, since instagram.com serves a login wall to any resolver. `--json` therefore
emits finished capture records directly. Links to elsewhere pasted into the self-thread have no
such metadata; `--other` lists them as URL<TAB>date for the normal enrichers.

Two quirks of Meta's export, both handled: every string is UTF-8 bytes mis-decoded as latin-1
(mojibake unless re-decoded), and long threads paginate across message_1.json, message_2.json, …
so reading only the first file silently drops the oldest half.

Accepts the export as the downloaded .zip or as an unzipped directory.

Usage:
    ./instagram.py export.zip                # all URLs as URL<TAB>date, newest first
    ./instagram.py export/ --json            # capture records for instagram.com links (JSONL)
    ./instagram.py export.zip --other        # only the non-instagram URLs, for enrich-web
    ./instagram.py export.zip --stats        # counts, date span, threads considered
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")
SHORTCODE_RE = re.compile(r"instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+)")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Extract links from an Instagram data export, newest first.",
        epilog="Request the export in-app: Accounts Center -> Download your information, "
        "format JSON, at least Messages ticked (Saved too, if you save posts).",
    )
    p.add_argument("export", type=Path, help="the downloaded .zip, or the unzipped directory")
    p.add_argument("--thread", help="thread directory name to read instead of auto-detecting the self-thread")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--json", action="store_true", help="emit capture records for instagram.com links")
    mode.add_argument("--other", action="store_true", help="emit only non-instagram URLs as URL<TAB>date")
    mode.add_argument("--stats", action="store_true", help="summarise instead of listing")
    mode.add_argument("--check", action="store_true",
                      help="exit 0 if the export contains messages or saved posts at all "
                      "(partial exports — e.g. connections only — exit 1)")
    return p.parse_args()


def demojibake(s: str) -> str:
    """Meta writes UTF-8 bytes escaped as latin-1 code points; undo it, or pass through unharmed."""
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def fix_strings(obj):
    if isinstance(obj, str):
        return demojibake(obj)
    if isinstance(obj, list):
        return [fix_strings(x) for x in obj]
    if isinstance(obj, dict):
        return {k: fix_strings(v) for k, v in obj.items()}
    return obj


class Export:
    """Uniform reads over a zip or a directory, addressed by path suffix inside the export."""

    def __init__(self, root: Path):
        self.zip = zipfile.ZipFile(root) if root.is_file() else None
        self.root = root

    def names(self) -> list[str]:
        if self.zip:
            return self.zip.namelist()
        return [str(p.relative_to(self.root)) for p in self.root.rglob("*.json")]

    def load(self, name: str):
        raw = self.zip.read(name) if self.zip else (self.root / name).read_bytes()
        return fix_strings(json.loads(raw))


def thread_files(ex: Export, chosen: str | None) -> tuple[str | None, list[str]]:
    """Locate the self-thread's message_N.json files, in page order.

    The self-thread is the inbox thread whose participants list is a single person — Meta lists
    both parties for real DMs. `--thread` overrides the detection when the guess is wrong.
    """
    pages: dict[str, list[str]] = {}
    for name in ex.names():
        m = re.search(r"(?:^|/)messages/inbox/([^/]+)/message_\d+\.json$", name)
        if m:
            pages.setdefault(m.group(1), []).append(name)

    if chosen:
        if chosen not in pages:
            sys.exit(f"no thread directory named {chosen!r}; have: {', '.join(sorted(pages))}")
        return chosen, sorted(pages[chosen], key=lambda n: int(re.search(r"message_(\d+)", n)[1]))

    for thread, files in pages.items():
        first = ex.load(min(files))
        participants = {p.get("name") for p in first.get("participants", [])}
        if len(participants) == 1:
            return thread, sorted(files, key=lambda n: int(re.search(r"message_(\d+)", n)[1]))
    return None, []


def canonical(url: str) -> str:
    """One reel, one URL: strip tracking params and pin the www.instagram.com/<kind>/<code>/ shape."""
    m = SHORTCODE_RE.search(url)
    if m:
        kind = "reel" if m.group(1) in ("reel", "reels") else m.group(1)
        return f"https://www.instagram.com/{kind}/{m.group(2)}/"
    return url.split("?")[0]


def is_instagram(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    return host == "instagram.com" or host.endswith(".instagram.com")


def gather(ex: Export, chosen: str | None):
    """Yield (url, date, share|None) for every link, self-thread first, then saved posts."""
    thread, files = thread_files(ex, chosen)
    for name in files:
        for msg in ex.load(name).get("messages", []):
            ts = msg.get("timestamp_ms")
            date = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d") if ts else ""
            share = msg.get("share") or {}
            if share.get("link"):
                yield share["link"], date, share
            for url in URL_RE.findall(msg.get("content") or ""):
                yield url, date, None

    for name in ex.names():
        if name.endswith("saved/saved_posts.json"):
            for item in ex.load(name).get("saved_saved_media", []):
                data = item.get("string_map_data", {}).get("Saved on", {})
                if data.get("href"):
                    ts = data.get("timestamp")
                    date = datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else ""
                    yield data["href"], date, {"original_content_owner": item.get("title")}
    return thread


def record(url: str, date: str, share: dict) -> dict:
    m = SHORTCODE_RE.search(url)
    kind = "reel" if m and m.group(1) in ("reel", "reels", "tv") else "ig-post"
    return {
        "kind": kind,
        "url": canonical(url),
        "source_url": None,
        "title": None,
        "text": (share.get("share_text") or "").strip() or None,
        "author": {"name": None, "handle": share.get("original_content_owner") or None},
        "saved_at": date or None,
        "images": [],
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "via": "instagram-export",
        "site": "Instagram",
    }


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    args = parse_args()
    if not args.export.exists():
        sys.exit(f"no such export: {args.export}")

    ex = Export(args.export)

    if args.check:
        has = any(re.search(r"(?:^|/)messages/inbox/[^/]+/message_\d+\.json$", n)
                  or n.endswith("saved/saved_posts.json") for n in ex.names())
        sys.exit(0 if has else 1)

    rows = []          # (url, date, share|None), newest first after sort
    seen: set[str] = set()
    for url, date, share in gather(ex, args.thread):
        key = canonical(url)
        if key in seen:
            continue
        seen.add(key)
        rows.append((url, date, share))
    rows.sort(key=lambda r: r[1], reverse=True)

    if args.stats:
        ig = sum(1 for u, _, _ in rows if is_instagram(u))
        dates = [d for _, d, _ in rows if d]
        print(f"{len(rows)} links ({ig} instagram, {len(rows) - ig} other)")
        if dates:
            print(f"span  {min(dates)} .. {max(dates)}")
        return

    if args.json:
        for url, date, share in rows:
            if is_instagram(url):
                print(json.dumps(record(url, date, share or {}), ensure_ascii=False))
        return

    for url, date, share in rows:
        if args.other and is_instagram(url):
            continue
        print(f"{url}\t{date}")


if __name__ == "__main__":
    main()
