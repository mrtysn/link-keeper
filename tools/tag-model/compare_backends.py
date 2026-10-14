"""Ask two decision-model servers the same tag questions about the same links, side by side.

Both servers speak the `/v1/systemone` wire shape (system-one's Laya or Kev backend, gutsy-inference).
The questions are the ones suggest_system_one.py asks: one yes/no per tag system-one may guess (the
personal tags are left out), in one batched call per link. Nothing is cached and nothing is sent to
Link Keeper.

Output, in `<data dir>/tag-model/compare/`: `answers.json` (every probability, per link, per server,
with each call's seconds) and `compare.md`, a summary for the owner: speed, how often the two agree
at the threshold, and every link where they differ. Once the owner has tagged links, `--labelled`
compares both against those tags instead: precision and recall per tag at the threshold.

Usage, from tools/tag-model/:
    uv run python compare_backends.py --b-port 8765 --limit 100
    uv run python compare_backends.py --b-port 8765 --labelled
The A server is system-one (started for the run if it is not running); B is any server already
running on --b-port.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import suggest_system_one as s1
import tagdata

ENGLISH_ASCII_SHARE = 0.97


def looks_english(link: tagdata.Link) -> bool:
    """A crude filter: almost all letters ASCII, and not a Turkish site."""
    text = f"{link.title} {link.capture_text}"
    letters = [c for c in text if c.isalpha()]
    if not letters or link.host.endswith(".tr"):
        return False
    return sum(c.isascii() for c in letters) / len(letters) >= ENGLISH_ASCII_SHARE


def ask_both(links, tags, meanings, a_port, b_port, report=print) -> list[dict]:
    rows = []
    for i, link in enumerate(links, 1):
        request = s1.build_request(link, tags, meanings)
        row = {"url": link.url, "title": link.title, "tags": link.tags}
        for name, port in (("a", a_port), ("b", b_port)):
            started = time.time()
            try:
                row[name] = s1.ask(request, port)
            except RuntimeError as err:
                row[name] = None
                report(f"{name} skipped {link.url}: {err}")
            row[f"{name}_seconds"] = round(time.time() - started, 3)
        rows.append(row)
        if i % 10 == 0:
            report(f"{i}/{len(links)}")
    return rows


def above(answers: dict | None, threshold: float) -> set[str]:
    return {t for t, p in (answers or {}).items() if p >= threshold}


def median(values: list[float]) -> float:
    values = sorted(values)
    return values[len(values) // 2] if values else 0.0


def summary(rows: list[dict], tags: list[str], threshold: float, a_name: str, b_name: str,
            labelled: bool) -> str:
    ok = [r for r in rows if r["a"] is not None and r["b"] is not None]
    lines = [f"# {a_name} vs {b_name} on link tags", "",
             f"{len(ok)} links, {len(tags)} tags each, threshold {threshold}. "
             f"{'Scored against the owner’s own tags.' if labelled else 'No owner tags yet: this compares the two with each other, not with the truth.'}",
             "", "## Speed", "",
             "| Server | Median s per link | Slowest s |", "|---|---|---|"]
    for key, name in (("a", a_name), ("b", b_name)):
        secs = [r[f"{key}_seconds"] for r in ok]
        lines.append(f"| {name} | {median(secs):.2f} | {max(secs, default=0):.2f} |")
    if labelled:
        lines += ["", "## Precision and recall per tag", "",
                  f"| Tag | Owner’s links | {a_name} precision | {a_name} recall | {b_name} precision | {b_name} recall |",
                  "|---|---|---|---|---|---|"]
        for tag in tags:
            truth = {r["url"] for r in ok if tag in r["tags"]}
            cells = []
            for key in ("a", "b"):
                said = {r["url"] for r in ok if tag in above(r[key], threshold)}
                hit = len(said & truth)
                cells += [f"{hit / len(said):.2f}" if said else "–", f"{hit / len(truth):.2f}" if truth else "–"]
            if truth or any(c != "–" for c in cells):
                lines.append(f"| {tag} | {len(truth)} | " + " | ".join(cells) + " |")
    else:
        same = sum(above(r["a"], threshold) == above(r["b"], threshold) for r in ok)
        lines += ["", "## Agreement", "",
                  f"Same set of tags at the threshold on {same} of {len(ok)} links.", "",
                  "| Tag | Links by " + a_name + " | Links by " + b_name + " | Both |", "|---|---|---|---|"]
        for tag in tags:
            a = {r["url"] for r in ok if tag in above(r["a"], threshold)}
            b = {r["url"] for r in ok if tag in above(r["b"], threshold)}
            if a or b:
                lines.append(f"| {tag} | {len(a)} | {len(b)} | {len(a & b)} |")
        lines += ["", "## Where they differ", "", f"| Link | {a_name} only | {b_name} only |", "|---|---|---|"]
        for r in ok:
            a, b = above(r["a"], threshold), above(r["b"], threshold)
            if a != b:
                title = (r["title"] or r["url"])[:70].replace("|", "/")
                lines.append(f"| [{title}]({r['url']}) | {', '.join(sorted(a - b)) or '–'} | {', '.join(sorted(b - a)) or '–'} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--b-port", type=int, required=True, help="port of the second server (gutsy-inference: 8765)")
    ap.add_argument("--a-name", default="system-one (Laya)")
    ap.add_argument("--b-name", default="gutsy")
    ap.add_argument("--limit", type=int, default=100, help="links to ask about (default %(default)s)")
    ap.add_argument("--labelled", action="store_true", help="use the links the owner has tagged and score both")
    ap.add_argument("--threshold", type=float, default=s1.DEFAULT_THRESHOLD)
    ap.add_argument("--data-dir", help="the refresh's data folder (default: DATA_DIR, else the repo's data/)")
    args = ap.parse_args()

    folder = tagdata.model_dir(args.data_dir) / "compare"
    folder.mkdir(parents=True, exist_ok=True)
    tags = [t for t in tagdata.load_tag_library() if t not in tagdata.PERSONAL_TAGS]
    links = [l for l in tagdata.load_links() if bool(l.tags) == args.labelled and l.capture_text and looks_english(l)]
    links = links[: args.limit]
    if not links:
        raise SystemExit("no links to compare" + (": the owner has tagged none with captured English text yet" if args.labelled else ""))
    meanings = tagdata.tag_meanings(tagdata.model_dir(args.data_dir))
    print(f"{len(links)} English links with captured text, {len(tags)} tags")
    with s1.system_one_server() as a_port:
        rows = ask_both(links, tags, meanings, a_port, args.b_port)
    tagdata.write_json(folder / "answers.json", rows)
    (folder / "compare.md").write_text(summary(rows, tags, args.threshold, args.a_name, args.b_name, args.labelled))
    print(f"wrote {folder / 'answers.json'} and {folder / 'compare.md'}")


if __name__ == "__main__":
    main()
