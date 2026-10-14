#!/usr/bin/env python3
"""Guess tags for untagged links with the local system-one model.

For every untagged link, one `noul` question per tag ("Would the owner file this link under the tag
'<tag>'?", plus the tag's meaning where its name is abstract), all of a link's questions in one
`system-one ask` call. The answer is P(yes) per tag.

system-one is globally disabled on purpose. This script starts the server for itself with
SYSTEM_ONE_ENABLED=1 only when it is not running, and stops it afterwards only if it started it.
It never runs `system-one enable`.

The first batch (up to 10 links) is timed and the estimate for the whole run is printed before the
rest is asked. Without --out nothing is written anywhere; the top suggestions are printed.

    suggest_system_one.py --limit 10
    suggest_system_one.py --out suggestions.json --threshold 0.85
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import tagdata
from tagdata import Link, Suggestion

DEFAULT_THRESHOLD = 0.85
TIMING_BATCH = 10
MAX_FAILURES_IN_A_ROW = 5
ASK_TIMEOUT_SECONDS = 120
START_WAIT_SECONDS = 60
HTTP_500_RETRY_SECONDS = 2


def _env() -> dict:
    return {**os.environ, "SYSTEM_ONE_ENABLED": "1"}


def server_port() -> int | None:
    """The port of the running server, from `system-one status`; None when it is not running."""
    out = subprocess.run(["system-one", "status"], capture_output=True, text=True, env=_env()).stdout
    for line in out.splitlines():
        if line.startswith("server:") and "not running" not in line:
            match = re.search(r":(\d+)", line)
            if match:
                return int(match.group(1))
    return None


def server_ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
            return json.load(resp).get("status") == "ok"
    except (OSError, ValueError):
        return False


@contextlib.contextmanager
def system_one_server():
    """Yield the server's port; the server runs for the duration and is stopped afterwards only when
    this call started it."""
    started = False
    port = server_port()
    if port is None:
        subprocess.run(["system-one", "start"], check=True, capture_output=True, text=True, env=_env())
        started = True
    try:
        deadline = time.time() + START_WAIT_SECONDS
        while True:
            port = port or server_port()
            if port and server_ready(port):
                break
            if time.time() > deadline:
                raise RuntimeError("system-one did not become ready; see `system-one status`")
            time.sleep(1)
        yield port
    finally:
        if started:
            subprocess.run(["system-one", "stop"], capture_output=True, text=True, env=_env())


def question_for(tag: str, meaning: str | None) -> str:
    text = f"Would the owner file this link under the tag '{tag}'?"
    return f"{text} The tag means: {meaning}." if meaning else text


def build_request(link: Link, tags: list[str], meanings: dict[str, str]) -> dict:
    return {
        "state": link.text,
        "questions": {
            tag: {"type": "noul", "instructions": question_for(tag, meanings.get(tag))} for tag in tags
        },
    }


def ask(request: dict, port: int) -> dict[str, float]:
    """One batched question set; returns P(yes) per question key. The server is called directly:
    `system-one ask` gives up after 1.5 s, which is made for hooks, not for fifty questions."""
    body = json.dumps({**request, "model": "english"}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/systemone", body,
                                 {"content-type": "application/json"})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=ASK_TIMEOUT_SECONDS) as resp:
                answers = json.load(resp).get("answers", {})
            break
        except urllib.error.HTTPError as err:
            # A Metal command-buffer error makes the model return NaN, which the server cannot serialise
            # and answers 500; the same request succeeds when asked again.
            if err.code == 500 and attempt == 1:
                time.sleep(HTTP_500_RETRY_SECONDS)
                continue
            raise RuntimeError(f"the server on port {port} did not answer: {err}") from err
        except (OSError, ValueError) as err:
            raise RuntimeError(f"the server on port {port} did not answer: {err}") from err
    return {tag: float(a["noul"]) for tag, a in answers.items() if "noul" in a}


class AnswerCache:
    """P(yes) per (link text, question), kept in a JSON file so a rerun asks only about what is new.
    A changed link text or a changed tag meaning is a new key. A full run drops the entries it did
    not use; a trial run (`keep_unused`) keeps them."""

    def __init__(self, path: Path, keep_unused: bool = False):
        self.path, self.keep_unused = path, keep_unused
        self.old: dict[str, float] = json.loads(path.read_text()) if path.is_file() else {}
        self.used: dict[str, float] = {}

    @staticmethod
    def key(link: Link, question: str) -> str:
        return hashlib.sha1(f"{link.text}\0{question}".encode()).hexdigest()

    def get(self, key: str) -> float | None:
        p = self.old.get(key, self.used.get(key))
        if p is not None:
            self.used[key] = p
        return p

    def put(self, key: str, p: float) -> None:
        self.used[key] = p

    def save(self) -> None:
        tagdata.write_json(self.path, {**self.old, **self.used} if self.keep_unused else self.used)


def score_links(links: list[Link], tags: list[str], meanings: dict[str, str], threshold: float,
                ask_fn=ask, report=print, total: int | None = None,
                cache: AnswerCache | None = None, source: str = tagdata.SOURCE_SYSTEM_ONE) -> dict[str, list[Suggestion]]:
    """P(yes) per link and tag; keeps those at or above `threshold`, labelled `source`. `ask_fn` is
    replaceable for tests. With a cache, only the (link, tag) pairs it lacks are asked; the speed line
    counts those links."""
    found: dict[str, list[Suggestion]] = {}
    started = time.time()
    asked = 0
    failed: list[str] = []
    in_a_row = 0
    for link in links:
        probs: dict[str, float] = {}
        missing = []
        for tag in tags:
            key = cache.key(link, question_for(tag, meanings.get(tag))) if cache else None
            hit = cache.get(key) if cache else None
            if hit is None:
                missing.append(tag)
            else:
                probs[tag] = hit
        if missing:
            try:
                answers = ask_fn(build_request(link, missing, meanings))
            except RuntimeError as err:
                # One link the server cannot answer is skipped; several in a row mean the server is down.
                failed.append(link.url)
                in_a_row += 1
                report(f"{source}: skipped {link.url}: {err}")
                if in_a_row >= MAX_FAILURES_IN_A_ROW:
                    if cache:
                        cache.save()
                    raise RuntimeError(f"{source} failed {in_a_row} links in a row; stopping") from err
                continue
            in_a_row = 0
            probs.update(answers)
            if cache:
                for tag, p in answers.items():
                    cache.put(cache.key(link, question_for(tag, meanings.get(tag))), p)
            asked += 1
            if asked % 25 == 0 and cache:
                cache.save()
            if asked == TIMING_BATCH or (asked == 1 and len(links) == 1):
                per_link = (time.time() - started) / asked
                report(f"{source} speed: {per_link:.2f} s per link over {asked} links; "
                       f"estimate for {total or len(links)} links: {per_link * (total or len(links)) / 60:.1f} min")
        found[link.url] = [Suggestion(tag, p, source) for tag, p in probs.items() if p >= threshold]
    if cache:
        cache.save()
    if failed:
        report(f"{source} could not answer {len(failed)} links; they get no suggestions this run")
    if asked < TIMING_BATCH:
        report(f"{source}: asked about {asked} of {len(links)} links ({len(links) - asked} answered from the cache)"
               + (f"; {(time.time() - started) / asked:.2f} s per link" if asked else ""))
    return found


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="ask about only the first N untagged links (newest first)")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help="keep a tag at or above this P(yes) (default %(default)s)")
    ap.add_argument("--out", help="write the suggestions contract JSON here")
    ap.add_argument("--data-dir", help="the refresh's data folder (default: DATA_DIR, else the repo's data/)")
    args = ap.parse_args()

    tags = tagdata.load_tag_library()
    links = [l for l in tagdata.load_links() if not l.tags]
    total = len(links)
    if args.limit:
        links = links[: args.limit]
    meanings = tagdata.tag_meanings(tagdata.model_dir(args.data_dir))
    print(f"{total} untagged links ({len(links)} to ask about), {len(tags)} tags")
    with system_one_server() as port:
        found = score_links(links, tags, meanings, args.threshold, ask_fn=lambda r: ask(r, port), total=total)
    result = tagdata.finish_suggestions(found)
    if args.out:
        tagdata.write_json(Path(args.out), result)
        print(f"wrote {len(result)} links with suggestions to {args.out}")
    else:
        shown = 0
        for link in links:
            if link.url in result and shown < 10:
                top = ", ".join(f"{s['tag']} {s['p']:.2f}" for s in result[link.url])
                print(f"- {link.title[:70] or link.url}\n  {link.url[:90]}\n  {top}")
                shown += 1
        print(f"{len(result)} of {len(links)} links have a suggestion at or above {args.threshold}")


if __name__ == "__main__":
    sys.exit(main())
