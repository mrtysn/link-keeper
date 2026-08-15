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
    ./reels-to-captures.py                      # packs from $DATA_DIR/reels (config.local.sh)
    ./reels-to-captures.py <reels-dir>          # explicit pack directory
    ./reels-to-captures.py <reels-dir> -o f.jsonl
"""

from __future__ import annotations

import argparse
import json
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


LINE_SEPARATORS = {0x2028: "\\u2028", 0x2029: "\\u2029"}


def default_reels_dir() -> Path | None:
    """Resolve $DATA_DIR/reels the same way the zsh tools do: config.local.sh wins."""
    repo = Path(__file__).resolve().parent.parent
    config = repo / "config.local.sh"
    if config.is_file():
        out = subprocess.run(
            ["zsh", "-c", f'source "{config}" && print -rn -- "${{REELS_DIR:-${{DATA_DIR:-}}/reels}}"'],
            capture_output=True, text=True,
        ).stdout.strip()
        if out and out != "/reels":
            return Path(out)
    return None


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
        transcript = "\n".join(l.strip() for l in lines if l.strip())
        if looks_hallucinated(lines):
            transcript = "(no intelligible speech — visual reel)"
        if transcript:
            text = f"{caption}\n\n— transcript —\n{transcript}" if caption else transcript

    upload_date = info.get("upload_date")  # YYYYMMDD
    posted = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}" if upload_date else None

    return {
        "kind": "reel",
        "url": meta["url"],
        "source_url": None,
        "title": (info.get("uploader") or info.get("channel") or pack.name),
        "text": text or None,
        "author": {"name": info.get("uploader"), "handle": info.get("uploader_id") or info.get("channel")},
        "saved_at": None,
        "posted_at": posted,
        "duration_s": meta.get("duration_s"),
        "images": [],
        "captured_at": meta.get("fetched_at") or datetime.now(timezone.utc).isoformat(),
        "via": "watch-reel",
        "site": "Instagram",
    }


def main() -> int:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    p = argparse.ArgumentParser(description="Convert watch-reel packs to capture JSONL.")
    p.add_argument("reels_dir", nargs="?", type=Path, default=None)
    p.add_argument("-o", "--output", type=Path, help="write here instead of stdout")
    args = p.parse_args()

    reels_dir = args.reels_dir or default_reels_dir()
    if not reels_dir or not reels_dir.is_dir():
        print(f"no reels directory: {reels_dir or '(none configured)'}", file=sys.stderr)
        return 1

    out = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
    n = 0
    for pack in sorted(reels_dir.iterdir()):
        if not pack.is_dir():
            continue
        rec = record(pack)
        if rec:
            out.write(json.dumps(rec, ensure_ascii=False).translate(LINE_SEPARATORS) + "\n")
            n += 1
    if args.output:
        out.close()
    print(f"{n} packs → capture records", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
