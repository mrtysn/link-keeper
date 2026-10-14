#!/usr/bin/env python3
"""Suggest tags for the links the owner has not tagged: the one entry point.

For each untagged link, a tag that has an enabled Jeffy head (see train.py) is scored by that head
(`"by": "model"`); every other tag is asked of two local decision servers with the same questions:
system-one (`"by": "system-one"`, threshold 0.85) and gutsy-inference (`"by": "gutsy"`, threshold 0.50;
skipped with `--no-gutsy` or when GUTSY_DIR is unset). Only suggestions at or above their threshold are
kept, at most 4 per source per link, sorted by p. A tag both servers give a link appears twice.

Writes <data dir>/tag-model/suggestions.json:

    { url: [ {"tag": str, "p": float 0..1, "by": "system-one" | "gutsy" | "model"}, ... ] }

(`suggestions.trial.json` with --limit) and sends it to Link Keeper with `--write` (`link-keeper suggest-set FILE --replace`). Without
--write it prints that command and changes nothing in the add-on.

    uv run python suggest.py --limit 20
    uv run python suggest.py --system-one-only
    uv run python suggest.py --write
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import numpy as np

import heads as heads_mod
import suggest_gutsy as gutsy_mod
import suggest_system_one as s1
import tagdata
from tagdata import Link, Suggestion


def model_suggestions(links: list[Link], folder, encode, metrics: dict, threshold: float | None) -> tuple[
        dict[str, list[Suggestion]], set[str]]:
    """Scores from every enabled head; returns the suggestions and the tags the heads cover."""
    enabled = {t: r for t, r in metrics.get("tags", {}).items() if r["enabled"]}
    found: dict[str, list[Suggestion]] = {l.url: [] for l in links}
    if not enabled or not links:
        return found, set()
    cache = heads_mod.EmbeddingCache(folder / "embeddings.npz", encode)
    X = cache.matrix([l.text for l in links])
    for tag in enabled:
        clf, scaler = heads_mod.load_head(folder / "heads", tag)
        cut = threshold if threshold is not None else metrics.get("threshold", 0.5)
        for link, p in zip(links, heads_mod.head_probabilities(clf, scaler, X)):
            if p >= cut:
                found[link.url].append(Suggestion(tag, float(p), tagdata.SOURCE_MODEL))
    return found, set(enabled)


def suggest(links, tag_library, folder, encode, *, system_one_only=False, threshold=None,
            system_one_threshold=s1.DEFAULT_THRESHOLD, ask_fn=None, gutsy_threshold=gutsy_mod.GUTSY_THRESHOLD,
            gutsy_dir=None, gutsy_ask_fn=None, use_gutsy=True, report=print, trial=False) -> dict:
    """The contract dict for the untagged links of `links`. `ask_fn` and `gutsy_ask_fn` replace the servers
    (for tests); without `gutsy_ask_fn` the gutsy pass needs `gutsy_dir`, else it is skipped."""
    untagged = [l for l in links if not l.tags]
    metrics_path = folder / "metrics.json"
    metrics = json.loads(metrics_path.read_text()) if metrics_path.is_file() and not system_one_only else {}
    found, covered = model_suggestions(untagged, folder, encode, metrics, threshold)
    rest = [t for t in tag_library if t not in covered and t not in tagdata.PERSONAL_TAGS]
    waiting = len([t for t in tag_library if t not in covered]) - len(rest)
    report(f"{len(untagged)} untagged links; {len(covered)} tags by trained heads, {len(rest)} asked of the "
           f"decision servers, {waiting} personal tags waiting for the owner's examples")
    if rest and untagged:
        meanings = tagdata.tag_meanings(folder)
        cache = s1.AnswerCache(folder / "system-one-answers.json", keep_unused=trial)
        if ask_fn is not None:
            guesses = s1.score_links(untagged, rest, meanings, system_one_threshold, ask_fn=ask_fn,
                                     report=report, cache=cache)
        else:
            with s1.system_one_server() as port:
                guesses = s1.score_links(untagged, rest, meanings, system_one_threshold,
                                         ask_fn=lambda r: s1.ask(r, port), report=report, cache=cache)
        for url, items in guesses.items():
            found[url].extend(items)
        for url, items in gutsy_guesses(untagged, rest, meanings, folder, gutsy_threshold, gutsy_dir,
                                        gutsy_ask_fn, use_gutsy, report, trial).items():
            found[url].extend(items)
    return tagdata.finish_suggestions(found)


def gutsy_guesses(untagged, rest, meanings, folder, threshold, install, ask_fn, use_gutsy, report, trial):
    """The gutsy pass: its guesses per link, or nothing when it is switched off or has no install."""
    if not use_gutsy:
        report("gutsy skipped: --no-gutsy")
        return {}
    cache = s1.AnswerCache(folder / gutsy_mod.ANSWERS_FILE, keep_unused=trial)
    source = tagdata.SOURCE_GUTSY
    if ask_fn is not None:
        return s1.score_links(untagged, rest, meanings, threshold, ask_fn=ask_fn, report=report, cache=cache,
                              source=source)
    if install is None:
        report(gutsy_mod.skip_line())
        return {}
    with gutsy_mod.gutsy_server(install, folder / gutsy_mod.LOG_FILE) as port:
        return s1.score_links(untagged, rest, meanings, threshold, ask_fn=lambda r: s1.ask(r, port),
                              report=report, cache=cache, source=source)


def summarize(result: dict) -> str:
    """Links and guesses per source, and the links holding the same tag from two sources."""
    sources = (tagdata.SOURCE_MODEL, tagdata.SOURCE_SYSTEM_ONE, tagdata.SOURCE_GUTSY)
    links = {s: 0 for s in sources}
    guesses = {s: 0 for s in sources}
    both = 0
    for items in result.values():
        for s in sources:
            n = sum(1 for i in items if i["by"] == s)
            guesses[s] += n
            links[s] += bool(n)
        tags_by = {s: {i["tag"] for i in items if i["by"] == s} for s in sources}
        both += bool(tags_by[tagdata.SOURCE_SYSTEM_ONE] & tags_by[tagdata.SOURCE_GUTSY])
    parts = ", ".join(f"{s}: {links[s]} links / {guesses[s]} guesses" for s in sources)
    return f"{len(result)} links with suggestions ({parts}); {both} links have a tag from both system-one and gutsy"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="only the first N untagged links (newest first), for a trial")
    ap.add_argument("--system-one-only", action="store_true", help="ignore trained heads; system-one guesses every tag")
    ap.add_argument("--threshold", type=float,
                    help="P(tag) a trained head needs (default: the threshold recorded at training)")
    ap.add_argument("--system-one-threshold", type=float, default=s1.DEFAULT_THRESHOLD,
                    help="P(yes) system-one needs (default %(default)s)")
    ap.add_argument("--gutsy-threshold", type=float, default=gutsy_mod.GUTSY_THRESHOLD,
                    help="P(yes) gutsy-inference needs (default %(default)s)")
    ap.add_argument("--no-gutsy", action="store_true", help="skip the gutsy-inference pass")
    ap.add_argument("--write", action="store_true", help="send the file with link-keeper suggest-set --replace")
    ap.add_argument("--data-dir", help="the refresh's data folder (default: DATA_DIR, else the repo's data/)")
    args = ap.parse_args()
    if args.limit and args.write:
        ap.error("--limit writes a trial file only; --write sends the complete suggestions")

    folder = tagdata.model_dir(args.data_dir)
    links = tagdata.load_links()
    if args.limit:
        keep = {l.url for l in [l for l in links if not l.tags][: args.limit]}
        links = [l for l in links if l.tags or l.url in keep]
    result = suggest(links, tagdata.load_tag_library(), folder, heads_mod.jeffy_encoder(),
                     system_one_only=args.system_one_only, threshold=args.threshold,
                     system_one_threshold=args.system_one_threshold, gutsy_threshold=args.gutsy_threshold,
                     gutsy_dir=gutsy_mod.gutsy_dir(), use_gutsy=not args.no_gutsy, trial=bool(args.limit))
    out = folder / ("suggestions.trial.json" if args.limit else "suggestions.json")
    tagdata.write_json(out, result)
    print(f"{summarize(result)} -> {out}")
    command = ["node", str(tagdata.LINK_KEEPER), "suggest-set", str(out), "--replace"]
    if args.write:
        done = subprocess.run(command, capture_output=True, text=True)
        print((done.stdout or done.stderr).strip())
        sys.exit(done.returncode)
    print("send it with:\n  " + " ".join(command))


if __name__ == "__main__":
    main()
