#!/usr/bin/env python3
# DESC: Check the safe-to-delete and link-triage pages against made-up input from all four sources, and that an unchanged input is not rebuilt.
"""Build both pages in a temp folder from a fake Telegram export, Instagram and X link records and a phone inbox.

Covers: every source shows on both pages with its thread; the safe/not-safe marks follow what a stand-in
`link-keeper` says the add-on holds (a link held under another path of the same X post counts); Telegram's
own categories (a note you wrote, a plain note, media) stay on Telegram rows; the page says whether the add-on,
a backup or the import's capture file decided; the capture file decides when the add-on cannot be read; one link
saved in two sources is one card with both origins; decisions saved under the old sidecar name still load;
and a second build with unchanged input is skipped, while a changed input, a changed holding or a plain run
(no `--only-if-changed`) builds. No network, no Firefox.

    tools/test-source-pages.py
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
SAFE = repo / "tools" / "build-safe-to-delete-page.py"
TRIAGE = repo / "tools" / "build-link-triage-page.py"

# Telegram
TG_HELD = "https://held.example/a"
TG_NOTE_HELD = "https://held.example/b"
TG_MISSING = "https://missing.example/c"
# Instagram
IG_HELD = "https://www.instagram.com/reel/HELD1/"
IG_MISSING = "https://www.instagram.com/reel/MISS1/"
# X: held under another handle's path, the same post
X_HELD = "https://x.com/i/status/111"
X_HELD_AS_STORED = "https://x.com/someone/status/111"
X_MISSING = "https://x.com/other/status/222"
# Phone
PH_HELD = "https://held.example/phone-held"
PH_MISSING = "https://missing.example/phone"

# What the stand-in add-on holds, and what the import's own capture file holds (they differ on purpose).
ADD_ON = [TG_HELD, TG_NOTE_HELD, IG_HELD, X_HELD_AS_STORED, PH_HELD]
CAPTURE_FILE = [TG_HELD, IG_MISSING, PH_MISSING]

FAKE_CLI = r'''
import json, sys
held = json.load(open(sys.argv[1]))
if len(sys.argv) > 2 and sys.argv[2] == "fail":
    sys.exit("Firefox is not running Link Keeper, and there is no latest.json yet")
if "links" in sys.argv:
    if len(sys.argv) > 2 and sys.argv[2] == "backup":
        sys.stderr.write("(from the backup of 2026-01-01T00:00:00Z; Firefox is not running Link Keeper)\n")
    print(json.dumps({"total": len(held), "links": [{"url": u, "key": u} for u in held]}))
'''


def text_msg(i: int, when: str, parts: list, **extra) -> dict:
    """A Telegram message: `text` mixes strings and entities, `text_entities` lists the link ones."""
    ents = [{"type": "link", "text": p["text"]} for p in parts if isinstance(p, dict)]
    return {"id": i, "type": "message", "date": when, "text": parts, "text_entities": ents, **extra}


def link(url: str) -> dict:
    return {"type": "link", "text": url}


def build_inputs(tmp: Path) -> dict:
    export = {"name": "Saved Messages", "type": "saved_messages", "messages": [
        text_msg(1, "2026-01-01T10:00:00", [link(TG_HELD)]),
        text_msg(2, "2026-01-02T10:00:00", ["read this ", link(TG_NOTE_HELD)]),
        text_msg(3, "2026-01-03T10:00:00", [link(TG_MISSING)]),
        text_msg(4, "2026-01-04T10:00:00", ["remember the milk"]),
        text_msg(5, "2026-01-05T10:00:00", [""], photo="photos/a.jpg"),
    ]}
    d = tmp / "data"
    d.mkdir()
    (tmp / "result.json").write_text(json.dumps(export), encoding="utf-8")
    (d / "link-captures-ig.jsonl").write_text("\n".join(json.dumps(r) for r in [
        {"kind": "reel", "url": IG_HELD, "text": "a reel about tools", "author": {"handle": "toolsguy"},
         "saved_at": "2026-02-01", "account": "main", "thread": ["alice_546464526753937"], "senders": ["me"]},
        {"kind": "reel", "url": IG_MISSING, "text": "another", "saved_at": "2026-02-02",
         "thread": ["alice_546464526753937", "bob_123456789012"], "senders": ["me", "Bob"]},
    ]) + "\n", encoding="utf-8")
    (d / "link-captures-xdm.jsonl").write_text("\n".join(json.dumps(r) for r in [
        {"kind": "tweet", "url": X_HELD, "saved_at": "2026-03-01", "thread": ["yourself"], "senders": ["@me"]},
        {"kind": "tweet", "url": X_MISSING, "saved_at": "2026-03-02", "thread": ["@carol"], "senders": ["@carol"]},
    ]) + "\n", encoding="utf-8")
    # The phone inbox also holds a link Telegram has: one card on the triage page, two rows on the safe page.
    (d / "link-inbox.tsv").write_text(f"{PH_HELD}\t2026-04-01\n{PH_MISSING}\t2026-04-02\n{TG_HELD}\t2026-04-03\n", encoding="utf-8")
    (d / "link-captures-all.jsonl").write_text("\n".join(json.dumps({"url": u, "kind": "page", "title": "T " + u})
                                                          for u in CAPTURE_FILE) + "\n", encoding="utf-8")
    (tmp / "held.json").write_text(json.dumps(ADD_ON), encoding="utf-8")
    (tmp / "fake-cli.py").write_text(FAKE_CLI, encoding="utf-8")
    return {"export": tmp / "result.json", "data": d, "held": tmp / "held.json", "cli": tmp / "fake-cli.py"}


failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


def run(script: Path, paths: dict, *args: str, cli_mode: str = "") -> subprocess.CompletedProcess:
    cli = shlex.join([sys.executable, "-I", str(paths["cli"]), str(paths["held"])] + ([cli_mode] if cli_mode else []))
    # The CLI is called as `<cli> links --filter all ...`; the stand-in reads argv[2] as its mode, so the mode
    # word goes where the real one has none: after the held file and before `links`.
    env = dict(os.environ, DATA_DIR=str(paths["data"]), LINK_KEEPER_CLI=cli)
    res = subprocess.run([sys.executable, "-I", str(script), *args], capture_output=True, text=True, env=env,
                         cwd=str(paths["data"].parent))
    if res.returncode:
        sys.exit(f"{script.name} {' '.join(args)} failed:\n{res.stdout}\n{res.stderr}")
    return res


def rows_of(page: str) -> list:
    """The safe-to-delete rows: (id, ref, verdict, source, threads)."""
    out = []
    for m in re.finditer(r'<div class="msg [^"]*" data-id="([^"]*)" data-ref="([^"]*)" data-verdict="([^"]*)" '
                         r'data-source="([^"]*)" data-srclabel="[^"]*" data-srcorder="\d+" data-threads="([^"]*)"', page):
        out.append(tuple(m.groups()))
    return out


def triage_data(page: str) -> dict:
    return json.loads(re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S).group(1).replace("<\\/", "</"))


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        paths = build_inputs(tmp)
        data = paths["data"]
        export = str(paths["export"])
        safe, triage = data / "safe-to-delete.html", data / "link-triage.html"

        # --- the safe-to-delete page ---
        res = run(SAFE, paths, export, "-o", str(safe))
        page = safe.read_text(encoding="utf-8")
        rows = rows_of(page)
        verdict = {}
        for i, ref, v, src, th in rows:
            verdict[(src, ref)] = v
        check("every source has rows", {r[3] for r in rows} == {"telegram", "instagram", "x", "phone"}, str({r[3] for r in rows}))
        check("one row per Telegram message and per link of the other sources (5 + 2 + 2 + 3)", len(rows) == 12, str(len(rows)))
        check("a Telegram message with only a held link is safe", verdict[("telegram", "1")] == "migrated")
        check("...with a note of your own beside a held link, not", verdict[("telegram", "2")] == "yournote")
        check("...with a link nothing holds, not captured", verdict[("telegram", "3")] == "uncaptured")
        check("...with no link, a note", verdict[("telegram", "4")] == "note")
        check("...a photo, media", verdict[("telegram", "5")] == "media")
        check("a held Instagram link is safe, a missing one not",
              (verdict[("instagram", IG_HELD)], verdict[("instagram", IG_MISSING)]) == ("migrated", "uncaptured"))
        check("an X post held under another handle's path is safe by its status id, another one not",
              (verdict[("x", X_HELD)], verdict[("x", X_MISSING)]) == ("migrated", "uncaptured"))
        check("phone links follow the add-on too",
              (verdict[("phone", PH_HELD)], verdict[("phone", PH_MISSING)], verdict[("phone", TG_HELD)]) == ("migrated", "uncaptured", "migrated"))
        check("Telegram's categories stay on Telegram rows",
              {src for (src, ref), v in verdict.items() if v in ("yournote", "note", "media")} == {"telegram"})
        threads = {(r[3], r[4]) for r in rows}
        check("each row names its thread", {("telegram", "Saved Messages"), ("instagram", "alice"), ("instagram", "alice|bob"),
                                            ("x", "yourself"), ("x", "@carol"), ("phone", "share inbox")} == threads, str(threads))
        check("...and the page offers a filter by source and by thread",
              all(f'data-schip="{k}"' in page for k in ("all", "telegram", "instagram", "x", "phone")) and 'id="thread"' in page)
        check("...and a grouped view", 'value="source"' in page)
        check("the page says the add-on decided", "read from the live add-on" in page and "Safe means Link Keeper holds the link" in page)
        check("the fingerprint is kept beside the page", (data / "safe-to-delete.fingerprint").is_file())

        before = safe.stat().st_mtime_ns
        res = run(SAFE, paths, export, "-o", str(safe), "--only-if-changed")
        check("a second build with unchanged input is skipped, with one line saying so",
              "skipped" in res.stdout and len(res.stdout.strip().splitlines()) == 1 and safe.stat().st_mtime_ns == before, res.stdout)
        res = run(SAFE, paths, export, "-o", str(safe))
        check("without the flag it builds again", "skipped" not in res.stdout and safe.stat().st_mtime_ns != before, res.stdout)

        with (data / "link-inbox.tsv").open("a", encoding="utf-8") as fh:
            fh.write("https://new.example/line\t2026-04-04\n")
        res = run(SAFE, paths, export, "-o", str(safe), "--only-if-changed")
        check("a new inbox line rebuilds it", "skipped" not in res.stdout and len(rows_of(safe.read_text())) == 13, res.stdout)

        paths["held"].write_text(json.dumps(ADD_ON + [IG_MISSING]), encoding="utf-8")
        res = run(SAFE, paths, export, "-o", str(safe), "--only-if-changed")
        check("a link the add-on now holds rebuilds it, and turns safe",
              "skipped" not in res.stdout and ("instagram", IG_MISSING) in {(r[3], r[1]) for r in rows_of(safe.read_text())}
              and {(r[3], r[1]): r[2] for r in rows_of(safe.read_text())}[("instagram", IG_MISSING)] == "migrated", res.stdout)
        paths["held"].write_text(json.dumps(ADD_ON), encoding="utf-8")

        res = run(SAFE, paths, export, "-o", str(safe), "--only-if-changed", cli_mode="backup")
        check("a backup read is named as such", "the backup of 2026-01-01T00:00:00Z" in safe.read_text() and "skipped" not in res.stdout, res.stdout)

        res = run(SAFE, paths, export, "-o", str(safe), "--only-if-changed", cli_mode="fail")
        page = safe.read_text(encoding="utf-8")
        fallback = {(r[3], r[1]): r[2] for r in rows_of(page)}
        check("when the add-on cannot be read the import's capture file decides, and the page says so",
              "link-captures-all.jsonl" in page and "could not be read" in page and "there is no latest.json yet" in page, page[:0])
        check("...held links are then those of that file",
              (fallback[("telegram", "1")], fallback[("instagram", IG_HELD)], fallback[("instagram", IG_MISSING)], fallback[("phone", PH_MISSING)])
              == ("migrated", "uncaptured", "migrated", "migrated"), str(fallback))

        # --- the triage page ---
        (data / "telegram-links-triage.json").write_text(json.dumps({"decisions": {TG_MISSING: "drop", "https://gone.example/": "keep"}}), encoding="utf-8")
        res = run(TRIAGE, paths, export, "-o", str(triage))
        page = triage.read_text(encoding="utf-8")
        d = triage_data(page)
        links = {l["u"]: l for l in d["links"]}
        sources = {o["s"] for l in d["links"] for o in l["o"]}
        check("every source has cards", sources == {"telegram", "instagram", "x", "phone"}, str(sources))
        check("a link saved in two sources is one card with both origins",
              sorted(o["s"] for o in links[TG_HELD]["o"]) == ["phone", "telegram"], str(links[TG_HELD]["o"]))
        check("...so eleven saved links (the inbox has grown by one) make ten cards", len(d["links"]) == 10, str(len(d["links"])))
        check("...dated by the earliest saving", links[TG_HELD]["d"] == "2026-01-01", links[TG_HELD]["d"])
        ig = next(o for o in links[IG_MISSING]["o"])
        check("a card carries its thread, senders and account",
              (ig["t"], ig["b"]) == (["alice", "bob"], ["me", "Bob"]) and next(o for o in links[IG_HELD]["o"])["a"] == ["main"], str(ig))
        check("...Telegram's its chat", links[TG_MISSING]["o"][0]["t"] == ["Saved Messages"])
        check("a link takes its title from the import's capture file, and one without a capture has none",
              links[IG_MISSING].get("x", {}).get("t") == "T " + IG_MISSING and "x" not in links[IG_HELD], str(links[IG_MISSING]))
        check("the page offers a filter by source and a grouping by source",
              all(f'data-src="{k}"' in page for k in ("all", "telegram", "instagram", "x", "phone")) and 'value="source"' in page)
        check("decisions saved under the old sidecar name still load, only for links that are there, and save under the new name",
              d["seeded"] == {TG_MISSING: "drop"} and d["triageName"] == "link-triage-decisions.json", str((d["seeded"], d["triageName"])))
        check("every card is in the queue", sorted(d["queue"]) == sorted(links))

        before = triage.stat().st_mtime_ns
        res = run(TRIAGE, paths, export, "-o", str(triage), "--only-if-changed")
        check("a second triage build with unchanged input is skipped, with one line saying so",
              "skipped" in res.stdout and len(res.stdout.strip().splitlines()) == 1 and triage.stat().st_mtime_ns == before, res.stdout)
        (data / "link-triage-decisions.json").write_text(json.dumps({"decisions": {X_MISSING: "keep"}}), encoding="utf-8")
        res = run(TRIAGE, paths, export, "-o", str(triage), "--only-if-changed")
        d = triage_data(triage.read_text(encoding="utf-8"))
        check("saved decisions changing rebuilds it, and the new sidecar name wins over the old",
              "skipped" not in res.stdout and d["seeded"] == {X_MISSING: "keep"} and d["triageName"] == "link-triage-decisions.json", res.stdout)
        res = run(TRIAGE, paths, export, "-o", str(triage))
        check("without the flag it builds again", "skipped" not in res.stdout and "wrote" in res.stdout, res.stdout)

        # --- without a Telegram export, the other sources alone ---
        res = run(SAFE, paths, "-o", str(data / "no-telegram.html"))
        only = {r[3] for r in rows_of((data / "no-telegram.html").read_text())}
        check("the Telegram export is optional", only == {"instagram", "x", "phone"}, str(only))

    if failed:
        sys.exit("\nsome checks failed")
    print("all passed")


if __name__ == "__main__":
    main()
