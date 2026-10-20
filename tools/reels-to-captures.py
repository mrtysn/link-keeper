#!/usr/bin/env python3
# DESC: Turn watch-reel packs into capture records, so the extension's views can show them.
"""Convert a directory of watch-reel packs into capture JSONL.

A pack (reels/<shortcode>/) holds what the reel *is*: yt-dlp's info.json carries the caption,
author and upload date; transcript.txt carries what was said. That is exactly the material a
capture record holds for any other page, so once converted, a reel shows up on the extension's
list page with its text readable inline, and in the card deck as something judgeable — no
special casing in the extension itself.

The transcript is appended to the caption under a marker line. Silent reels carry their
"(no audio track — visual only)" marker instead, which is honest: the record says there is
nothing to read, go watch it.

Usage:
    ./reels-to-captures.py                      # packs from REELS_DIR / $DATA_DIR/reels / <repo>/data/reels
    ./reels-to-captures.py <reels-dir>          # explicit pack directory
    ./reels-to-captures.py <reels-dir> -o f.jsonl
    ./reels-to-captures.py --pack CODE          # one pack's record (tools/watch-links.zsh)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Whisper hallucinates fluent loops on music and ambient noise. A transcript that is one short
# line repeated is noise, not speech — flag it rather than presenting it as content.
def looks_hallucinated(lines: list[str]) -> bool:
    stripped = [l.strip() for l in lines if l.strip()]
    return len(stripped) >= 4 and len(set(stripped)) <= 2


MUSIC = re.compile(r"[\[(]?music[\])]?", re.I)


def collapse_music(lines) -> list[str]:
    """Whisper writes "Music" for each stretch of music with no speech; nobody said it. A run of them
    becomes one "(music)" line, so the text still says where music plays. transcript.txt keeps whisper's
    own output."""
    out: list[str] = []
    for line in lines:
        if MUSIC.fullmatch(line):
            if not out or out[-1] != "(music)":
                out.append("(music)")
        else:
            out.append(line)
    return out


LINE_SEPARATORS = {0x2028: "\\u2028", 0x2029: "\\u2029"}


def default_reels_dir() -> Path:
    """Resolve REELS_DIR the same way the zsh tools do: environment, then config.local.sh, then
    this repo's own data/reels."""
    repo = Path(__file__).resolve().parent.parent
    env_reels, env_data = os.environ.get("REELS_DIR"), os.environ.get("DATA_DIR")
    reels_dir = data_dir = None
    config = repo / "config.local.sh"
    if config.is_file():
        out = subprocess.run(
            ["zsh", "-c", f'source "{config}" && printf "%s\\t%s" "${{REELS_DIR:-}}" "${{DATA_DIR:-}}"'],
            capture_output=True, text=True,
        ).stdout.rstrip("\n")
        reels_dir, _, data_dir = out.partition("\t")
    reels_dir = env_reels or reels_dir or None
    if reels_dir:
        return Path(reels_dir)
    data_dir = env_data or data_dir or str(repo / "data")
    return Path(data_dir) / "reels"


def record(pack: Path) -> dict | None:
    meta_p, info_p, transcript_p = pack / "meta.json", pack / "video.info.json", pack / "transcript.txt"
    if not meta_p.is_file():
        return None
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    info = {}
    if info_p.is_file():
        try:
            info = json.loads(info_p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    caption = (info.get("description") or "").strip()
    text = caption
    if transcript_p.is_file():
        lines = transcript_p.read_text(encoding="utf-8").splitlines()
        transcript = "\n".join(collapse_music(l.strip() for l in lines if l.strip()))
        if looks_hallucinated(lines):
            transcript = "(no intelligible speech — visual reel)"
        if transcript:
            text = f"{caption}\n\n— transcript —\n{transcript}" if caption else transcript

    # What the reel shows (OCR) and what it points to (extract-reel-resources.py): the list goes first,
    # since it is what the owner sent the reel for; the on-screen text sits beside the transcript.
    shown = (pack / "onscreen.txt").read_text(encoding="utf-8").strip() if (pack / "onscreen.txt").is_file() else ""
    if shown:
        text = f"{text}\n\n— on screen —\n{shown}" if text else f"— on screen —\n{shown}"
    links = []
    try:
        res = json.loads((pack / "resources.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        res = None
    if res:
        rows = [f"- {r['name']} ({r['kind']}, {r['where']})" + (f" {r['url']}" if r.get("url") else "")
                for r in res.get("resources") or []]
        head = "\n".join([f"— about — {res.get('about', '')}".rstrip(), *rows])
        text = f"{head}\n\n{text}" if text else head
        for r in res.get("resources") or []:
            u = (r.get("url") or "").strip()
            if u and not u.startswith(("http://", "https://")):
                u = "https://" + u
            if u and u not in links:
                links.append(u)

    upload_date = info.get("upload_date")  # YYYYMMDD
    posted = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}" if upload_date else None

    # yt-dlp's Instagram fields: `channel` is the username, `uploader` the display name, and
    # `uploader_id` a bare numeric id — never show that one. The title is the caption's first
    # line, which identifies a reel far better than who posted it.
    first_line = caption.splitlines()[0][:100] if caption else None
    is_reel = "/reel/" in meta["url"] or "/reels/" in meta["url"] or "/tv/" in meta["url"]
    platform = meta.get("platform", "instagram")
    # YouTube: the video's own title, by its channel. X: the post's text, by its @handle (yt-dlp's
    # uploader_id there is the handle).
    if platform == "youtube":
        kind, site, title = "video", "YouTube", info.get("title")
        author = {"name": info.get("channel") or info.get("uploader"), "handle": info.get("uploader_id") or None}
    elif platform == "x":
        kind, site, title = "tweet", "X", first_line
        handle = info.get("uploader_id")
        author = {"name": info.get("uploader"), "handle": f"@{handle}" if handle else None}
    else:
        kind, site, title = ("reel" if is_reel else "ig-post"), "Instagram", first_line
        author = {"name": info.get("uploader"), "handle": info.get("channel") or None}
    return {
        "kind": kind,
        "url": meta["url"],
        "source_url": None,
        "title": title or info.get("uploader") or pack.name,
        "text": text or None,
        "author": author,
        "saved_at": None,
        "posted_at": posted,
        "duration_s": meta.get("duration_s"),
        "links": links,
        "images": [],
        "captured_at": meta.get("fetched_at") or datetime.now(timezone.utc).isoformat(),
        "via": "watch-reel",
        "site": site,
    }


def main() -> int:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    p = argparse.ArgumentParser(description="Convert watch-reel packs to capture JSONL.")
    p.add_argument("reels_dir", nargs="?", type=Path, default=None)
    p.add_argument("-o", "--output", type=Path, help="write here instead of stdout")
    p.add_argument("--pack", action="append", default=[], metavar="CODE",
                   help="only this pack (repeatable); exits 1 when none of them gave a record")
    args = p.parse_args()

    reels_dir = args.reels_dir or default_reels_dir()
    if not reels_dir or not reels_dir.is_dir():
        print(f"no reels directory: {reels_dir or '(none configured)'}", file=sys.stderr)
        return 1

    out = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
    n = 0
    packs = [reels_dir / c for c in args.pack] if args.pack else sorted(reels_dir.iterdir())
    for pack in packs:
        if not pack.is_dir():
            continue
        rec = record(pack)
        if rec:
            out.write(json.dumps(rec, ensure_ascii=False).translate(LINE_SEPARATORS) + "\n")
            n += 1
    if args.output:
        out.close()
    print(f"{n} packs → capture records", file=sys.stderr)
    return 1 if args.pack and not n else 0


if __name__ == "__main__":
    sys.exit(main())
