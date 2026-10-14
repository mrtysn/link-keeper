#!/usr/bin/env python3
"""Tag the owner's links with Claude Haiku, choosing from the tags in their library.

Run on demand only; every call spends Claude tokens. Links go to `claude -p` in batches, the answer is
checked against the library, and each batch is cached under `<data dir>/tag-model/agent-tags.json`
(keyed by the hash of the link's text) so a stopped run resumes. The result, `{url: [tag, ...]}`, is
written to `agent-tags-set.json` beside it and sent with `link-keeper agent-tags-set FILE --by haiku`.

Usage (from tools/tag-model/):
    uv run python agent_tag.py                 links with no agent tags yet
    uv run python agent_tag.py --limit 50      a trial on the first 50 of those
    uv run python agent_tag.py --all           retag every link, ignoring the cache; replaces stored agent tags (merges with --limit)
    uv run python agent_tag.py --no-write      write agent-tags-set.json only, do not send it
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import tagdata
from tagdata import Link

MODEL = "haiku"
BY = "haiku"
BATCH_SIZE = 25
PARALLEL_CALLS = 3
MAX_TAGS_PER_LINK = 5
CACHE_FILE = "agent-tags.json"
OUTPUT_FILE = "agent-tags-set.json"
SET_COMMAND = "agent-tags-set"

SYSTEM_PROMPT = """You tag web links for their owner, who keeps a personal library of links.

You get the owner's tag list, each tag with a one-line meaning, then a batch of links. Each link has a \
url, then its title, site and the start of its page text.

For every link, pick between 0 and {max_tags} tags that clearly fit it. Rules:
- Use only tags from the list, spelled exactly as listed. Never invent a tag.
- Choose a tag only when the page clearly fits its meaning. No tag at all is a valid answer; give an \
empty list rather than a weak match.
- Personal tags (to-read, to-try, reference, inspiration, leverage and the like) are included. Judge \
them from the page: a long article worth reading later fits to-read, a tool or recipe to attempt fits \
to-try, a page useful to look up again fits reference.
- Answer for every link in the batch, using its url exactly as given.

Tags and meanings:
{tags}
"""


class AgentTagError(RuntimeError):
    """The claude call or its answer cannot be used."""


def result_schema(library: list[str]) -> dict:
    """JSON schema of one answer: {results: [{url, tags}]}, tags limited to the library."""
    return {
        "type": "object",
        "properties": {"results": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "tags": {"type": "array", "maxItems": MAX_TAGS_PER_LINK,
                         "items": {"type": "string", "enum": library}},
            },
            "required": ["url", "tags"],
        }}},
        "required": ["results"],
    }


def system_prompt(library: list[str], meanings: dict[str, str]) -> str:
    lines = "\n".join(f"- {tag}: {meanings[tag]}" if meanings.get(tag) else f"- {tag}" for tag in library)
    return SYSTEM_PROMPT.format(max_tags=MAX_TAGS_PER_LINK, tags=lines)


def batch_message(batch: list[Link]) -> str:
    """The user message: the batch as a JSON list of {url, text}."""
    return json.dumps([{"url": link.url, "text": link.text} for link in batch], ensure_ascii=False)


def call_claude(system: str, user: str, schema: dict) -> dict:
    """One headless `claude -p` call on Haiku with a structured-output schema; returns the parsed answer.

    `--setting-sources ""`, an explicit system prompt and no tools keep the machine's CLAUDE.md, rules,
    hooks and tool definitions out of the request. It runs from a temporary folder so no project
    instructions are found by walking up.
    """
    claude = shutil.which("claude")
    if not claude:
        raise AgentTagError("claude CLI not on PATH")
    cmd = [claude, "-p", "--model", MODEL, "--output-format", "json", "--setting-sources", "",
           "--tools", "", "--no-session-persistence",
           "--system-prompt", system, "--json-schema", json.dumps(schema), user]
    with tempfile.TemporaryDirectory() as cwd:
        done = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if done.returncode != 0:
        raise AgentTagError(f"claude exited {done.returncode}: {done.stderr.strip()[:400]}")
    try:
        payload = json.loads(done.stdout)
    except ValueError as exc:
        raise AgentTagError(f"claude returned non-JSON: {done.stdout[:200]}") from exc
    if payload.get("is_error"):
        raise AgentTagError(f"claude: {payload.get('result')}")
    doc = payload.get("structured_output")
    if doc is None:
        try:
            doc = json.loads(payload.get("result") or "")
        except ValueError as exc:
            raise AgentTagError(f"claude returned no structured answer: {str(payload)[:200]}") from exc
    return doc


def text_hash(link: Link) -> str:
    return hashlib.sha256(link.text.encode()).hexdigest()


def clean_tags(tags, library: set[str]) -> list[str]:
    """The answer's tags that are in the library, once each, at most MAX_TAGS_PER_LINK."""
    kept: list[str] = []
    for tag in tags if isinstance(tags, list) else []:
        if isinstance(tag, str) and tag in library and tag not in kept:
            kept.append(tag)
    return kept[:MAX_TAGS_PER_LINK]


def read_batch(doc: dict, batch: list[Link], library: set[str]) -> dict[str, list[str]]:
    """{url: tags} for the batch's links the answer covers; unknown tags and urls outside the batch are dropped."""
    wanted = {link.url for link in batch}
    found: dict[str, list[str]] = {}
    for item in doc.get("results", []) if isinstance(doc, dict) else []:
        if isinstance(item, dict) and item.get("url") in wanted and item["url"] not in found:
            found[item["url"]] = clean_tags(item.get("tags"), library)
    return found


def batches(links: list[Link], size: int = BATCH_SIZE) -> list[list[Link]]:
    return [links[i:i + size] for i in range(0, len(links), size)]


def load_cache(path: Path) -> dict[str, dict]:
    return json.loads(path.read_text()) if path.is_file() else {}


def tag_links(links: list[Link], library: list[str], meanings: dict[str, str], cache_path: Path, *,
              ask_fn: Callable[[str, str, dict], dict] = call_claude, use_cache: bool = True,
              parallel: int = PARALLEL_CALLS, report: Callable[[str], None] = print) -> tuple[dict[str, list[str]], list[float]]:
    """Tag `links`; returns ({url: tags}, seconds per call). Cached links are not asked again.

    Links in a call's answer are cached at once. A link the answer left out, or a call that failed, is
    asked once more in a later pass; a link still missing after that is left out of the result.
    """
    system = system_prompt(library, meanings)
    schema = result_schema(library)
    allowed = set(library)
    cache = load_cache(cache_path) if use_cache else {}
    lock = threading.Lock()
    seconds: list[float] = []
    result: dict[str, list[str]] = {}
    todo: list[Link] = []
    for link in links:
        hit = cache.get(text_hash(link))
        if hit is not None:
            result[link.url] = clean_tags(hit.get("tags"), allowed)
        else:
            todo.append(link)
    if len(result):
        report(f"{len(result)} links already in the cache")

    def run(batch: list[Link]) -> list[Link]:
        """Ask for one batch; returns the links the answer did not cover."""
        started = time.monotonic()
        try:
            found = read_batch(ask_fn(system, batch_message(batch), schema), batch, allowed)
        except AgentTagError as exc:
            report(f"call failed: {exc}")
            found = {}
        elapsed = time.monotonic() - started
        with lock:
            seconds.append(elapsed)
            for link in batch:
                if link.url in found:
                    result[link.url] = found[link.url]
                    cache[text_hash(link)] = {"url": link.url, "tags": found[link.url],
                                              "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            tagdata.write_json(cache_path, cache)
            report(f"batch of {len(batch)}: {len(found)} answered in {elapsed:.1f} s")
        return [link for link in batch if link.url not in found]

    for attempt in (1, 2):
        if not todo:
            break
        if attempt == 2:
            report(f"asking again about {len(todo)} links the first pass missed")
        with ThreadPoolExecutor(max_workers=parallel) as pool:
            missed = [link for rest in pool.map(run, batches(todo)) for link in rest]
        if attempt == 1 and len(missed) == len(todo) and not result:
            raise AgentTagError("claude answered nothing usable; check `claude -p` works")
        todo = missed
    if todo:
        report(f"{len(todo)} links got no answer")
    return result, seconds


def links_to_tag(links: list[Link], tagged_urls: set[str], *, everything: bool, limit: int | None) -> list[Link]:
    """All links with `--all`, else those whose url is not in `tagged_urls`; cut to `limit`."""
    chosen = links if everything else [link for link in links if link.url not in tagged_urls]
    return chosen[:limit] if limit else chosen


def urls_with_agent_tags() -> set[str]:
    """Urls Link Keeper already holds agent tags for; an absent `agentTags` field means none."""
    raw = json.loads(tagdata.link_keeper("links", "--all", "--json"))["links"]
    return {item["url"] for item in raw if item.get("agentTags") is not None}


def send_command(output: Path, replace: bool) -> list[str]:
    return ["node", str(tagdata.LINK_KEEPER), SET_COMMAND, str(output), "--by", BY, *(["--replace"] if replace else [])]


def command_exists() -> bool:
    return SET_COMMAND in tagdata.link_keeper("--help")


def main(argv: list[str] | None = None, ask_fn: Callable[[str, str, dict], dict] = call_claude) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="retag every link, ignoring the cache; without --limit it replaces the stored agent tags")
    ap.add_argument("--limit", type=int, help="tag at most N links (a trial)")
    ap.add_argument("--no-write", action="store_true", help="write the output file but do not send it to Link Keeper")
    ap.add_argument("--data-dir")
    args = ap.parse_args(argv)

    folder = tagdata.model_dir(args.data_dir)
    library = tagdata.load_tag_library()
    meanings = tagdata.tag_meanings(folder)
    links = tagdata.load_links()
    chosen = links_to_tag(links, set() if args.all else urls_with_agent_tags(), everything=args.all, limit=args.limit)
    print(f"{len(chosen)} links to tag with {len(library)} library tags, {BATCH_SIZE} per call, {PARALLEL_CALLS} calls at a time")
    if not chosen:
        return 0

    result: dict[str, list[str]] = {}
    seconds: list[float] = []
    started = time.monotonic()
    try:
        result, seconds = tag_links(chosen, library, meanings, folder / CACHE_FILE, ask_fn=ask_fn, use_cache=not args.all)
    except KeyboardInterrupt:
        print("stopped; finished batches are cached, run again to resume", file=sys.stderr)
        return 130

    output = folder / OUTPUT_FILE
    tagdata.write_json(output, result)
    counts = [len(tags) for tags in result.values()]
    if seconds:
        print(f"{len(seconds)} calls, {sum(seconds) / len(seconds):.1f} s each; {time.monotonic() - started:.1f} s in all")
    if counts:
        print(f"{len(result)} links answered, {sum(counts) / len(counts):.2f} tags per link, {counts.count(0)} with none")
    print(f"wrote {output}")
    command = send_command(output, replace=args.all and not args.limit)
    if args.no_write:
        print("not sent (--no-write); to send:", " ".join(command))
    elif not command_exists():
        print(f"link-keeper has no {SET_COMMAND} yet; once it does:", " ".join(command))
    else:
        print(tagdata.link_keeper(*command[2:]).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
