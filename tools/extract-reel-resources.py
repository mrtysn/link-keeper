#!/usr/bin/env python3
# DESC: Have Claude Haiku list the tools, repos, sites and links each reel pack says or shows, into resources.json.
"""Read each watch-reel pack's caption, transcript and on-screen text, and write what it points to.

The owner sends reels to themself for the resources in them: a tool, a repo, a site, an app. A pack
already holds what was said (transcript.txt) and what was shown (onscreen.txt, OCR of the distinct
frames); this asks Haiku to turn the two into a short list, and reels-to-captures.py puts that list
at the top of the reel's capture. Text only: no frame leaves the machine.

Every call spends Claude tokens. A pack is skipped while its resources.json was written from the same
input (a hash of caption, transcript and on-screen text), so a stopped run resumes and a rerun costs
nothing.

Usage:
    ./extract-reel-resources.py                 every pack that needs it, in REELS_DIR
    ./extract-reel-resources.py --limit 10      a trial on 10 of them, newest first
    ./extract-reel-resources.py CODE...         only these packs (shortcodes or pack directories)
    ./extract-reel-resources.py --force CODE    redo even when the input has not changed
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

MODEL = "haiku"
PARALLEL_CALLS = 3
MAX_CHARS = 6000   # per part: a long transcript or a screen-recorded README is cut here

SYSTEM = """You read what a short video (an Instagram reel or post) says and shows, and list the \
resources it points the viewer to: tools, apps, code repositories, websites, products, services, \
courses, books, people or accounts to follow, places.

The input has the caption, the speech transcript (machine transcribed: names may be misheard) and the \
on-screen text (OCR of the frames, "[12s] text": fragments and misreads are common).
- List each resource once, under its correct name. A name that sounds like one on screen ("Zerp" said, "Xirp" \
shown) is the same resource: keep the on-screen spelling and drop the misheard one.
- url: only a URL or domain that appears in the input, or a GitHub repo whose owner and name both \
appear. Never guess one. Otherwise null.
- where: "shown" if it appears in the on-screen text at all, else "said", else "caption".
- Skip the reel's own author unless the reel recommends following them, and skip generic words \
(AI, coding, the app store).
- about: one plain sentence on what the video is about.
An empty list is a correct answer for a video that points to nothing."""

SCHEMA = {
    "type": "object",
    "properties": {
        "about": {"type": "string"},
        "resources": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": ["tool", "repo", "site", "app", "product", "service",
                                                       "course", "book", "media", "person", "place", "other"]},
                    "url": {"type": ["string", "null"]},
                    "where": {"type": "string", "enum": ["shown", "said", "caption"]},
                },
                "required": ["name", "kind", "url", "where"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["about", "resources"],
    "additionalProperties": False,
}


class ExtractError(Exception):
    """The claude call or its answer cannot be used."""


def default_reels_dir() -> Path:
    spec = importlib.util.spec_from_file_location("r2c", Path(__file__).with_name("reels-to-captures.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.default_reels_dir()


def call_claude(system: str, user: str, schema: dict) -> dict:
    """One headless `claude -p` call on Haiku with a structured-output schema, as tag-model/agent_tag.py
    does: no settings, tools or project instructions in the request, run from a temporary folder."""
    claude = shutil.which("claude")
    if not claude:
        raise ExtractError("claude CLI not on PATH")
    cmd = [claude, "-p", "--model", MODEL, "--output-format", "json", "--setting-sources", "",
           "--tools", "", "--no-session-persistence",
           "--system-prompt", system, "--json-schema", json.dumps(schema), user]
    with tempfile.TemporaryDirectory() as cwd:
        done = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if done.returncode != 0:
        raise ExtractError(f"claude exited {done.returncode}: {done.stderr.strip()[:400]}")
    try:
        payload = json.loads(done.stdout)
    except ValueError as exc:
        raise ExtractError(f"claude returned non-JSON: {done.stdout[:200]}") from exc
    if payload.get("is_error"):
        raise ExtractError(f"claude: {payload.get('result')}")
    doc = payload.get("structured_output")
    if doc is None:
        try:
            doc = json.loads(payload.get("result") or "")
        except ValueError as exc:
            raise ExtractError(f"claude returned no structured answer: {str(payload)[:200]}") from exc
    return doc


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def pack_input(pack: Path) -> str | None:
    """The prompt for one pack, or None when the pack has nothing to read yet (no summary means the
    on-screen text has not been made: run watch-reel.zsh --summarize-all first)."""
    if not (pack / "meta.json").is_file() or not (pack / "onscreen.txt").exists():
        return None
    try:
        info = json.loads(read(pack / "video.info.json") or "{}")
    except ValueError:
        info = {}
    caption = info.get("description") or ""
    if not caption:
        caption = next((e.get("description") for e in info.get("entries") or [] if e.get("description")), "")
    parts = [("caption", caption.strip()), ("transcript", read(pack / "transcript.txt")),
             ("on-screen text", read(pack / "onscreen.txt"))]
    return "\n\n".join(f"## {name}\n{(body[:MAX_CHARS] + ' …') if len(body) > MAX_CHARS else (body or '(none)')}"
                       for name, body in parts)


def digest(prompt: str) -> str:
    return hashlib.sha256(prompt.encode()).hexdigest()[:16]


def needs_work(pack: Path, force: bool) -> str | None:
    """"empty" (nothing to read yet), "skipped" (resources.json is from this same input) or None."""
    prompt = pack_input(pack)
    if prompt is None:
        return "empty"
    if not force:
        try:
            if json.loads((pack / "resources.json").read_text(encoding="utf-8")).get("input") == digest(prompt):
                return "skipped"
        except (OSError, ValueError):
            pass
    return None


def extract(pack: Path, ask=call_claude) -> None:
    """Ask once and write resources.json; raises ExtractError."""
    prompt = pack_input(pack)
    doc = ask(SYSTEM, prompt, SCHEMA)
    if not isinstance(doc.get("resources"), list) or not isinstance(doc.get("about"), str):
        raise ExtractError(f"answer is missing about or resources: {str(doc)[:200]}")
    doc = {"about": doc["about"].strip(), "resources": doc["resources"], "by": MODEL, "input": digest(prompt),
           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    out = pack / "resources.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out)


def main(argv: list[str] | None = None, ask=call_claude) -> int:
    p = argparse.ArgumentParser(description="List each reel pack's resources with Claude Haiku.")
    p.add_argument("packs", nargs="*", help="shortcodes or pack directories (default: every pack)")
    p.add_argument("--reels-dir", type=Path, default=None)
    p.add_argument("--limit", type=int, default=0, help="at most this many calls")
    p.add_argument("--force", action="store_true", help="redo packs whose input has not changed")
    args = p.parse_args(argv)

    reels_dir = args.reels_dir or default_reels_dir()
    if args.packs:
        packs = [Path(x) if Path(x).is_dir() else reels_dir / x for x in args.packs]
    else:
        if not reels_dir.is_dir():
            print(f"no reels directory: {reels_dir}", file=sys.stderr)
            return 1
        packs = sorted((d for d in reels_dir.iterdir() if (d / "meta.json").is_file()),
                       key=lambda d: (d / "meta.json").stat().st_mtime, reverse=True)

    todo, counts = [], {"done": 0, "skipped": 0, "empty": 0, "failed": 0}
    for pack in packs:
        state = needs_work(pack, args.force)
        if state:
            counts[state] += 1
        else:
            todo.append(pack)
    if args.limit:
        todo = todo[:args.limit]

    def one(pack: Path) -> None:
        try:
            extract(pack, ask)
            counts["done"] += 1
            print(f"→ {pack.name}", flush=True)
        except ExtractError as exc:
            counts["failed"] += 1
            print(f"  ! {pack.name}: {exc}", flush=True)

    with ThreadPoolExecutor(PARALLEL_CALLS) as pool:
        list(pool.map(one, todo))
    print(f"\nresources: {counts['done']} written, {counts['skipped']} unchanged, "
          f"{counts['empty']} without on-screen text yet (watch-reel.zsh --summarize-all), {counts['failed']} failed")
    return 1 if counts["failed"] and not counts["done"] else 0


if __name__ == "__main__":
    sys.exit(main())
