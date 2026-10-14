#!/usr/bin/env python3
# DESC: Check the Instagram importer against a made-up export: threads, accounts, origins and the attach step.
"""Build a fake "Download your information" export in a temp directory and run the importer on it.

Covers the self-thread, a named thread, an unnamed thread that must stay out, a link met in two
threads, mojibake, saved posts, `--list-threads`, `--account`, `--origins-out`, and
`attach-dm-origin.py` putting the origin back on a record the enrichers rebuilt. No network.

    tools/test-instagram-export.py
    tools/test-instagram-export.py --write-fixture DIR   # only write the fake export, without the
                                                         # links to other sites (no fetching needed)
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
IMPORTER = repo / "importers" / "instagram.py"
ATTACH = repo / "importers" / "attach-dm-origin.py"

REEL_SELF = "https://www.instagram.com/reel/AAA111/"
REEL_SHARED = "https://www.instagram.com/reel/BBB222/"
POST_ONLY_BOB = "https://www.instagram.com/p/CCC333/"
POST_NOT_ALLOWED = "https://www.instagram.com/p/DDD444/"
SITE_ALICE = "https://example.com/article?utm=x"
SITE_SELF = "https://example.org/self"
SAVED = "https://www.instagram.com/p/EEE555/"


def message(sender: str, ts: int, link: str | None = None, content: str | None = None, caption: str | None = None) -> dict:
    msg: dict = {"sender_name": sender, "timestamp_ms": ts}
    if link:
        msg["share"] = {"link": link, "share_text": caption, "original_content_owner": "someone"}
    if content:
        msg["content"] = content
    return msg


def write_thread(root: Path, slug: str, people: list[str], messages: list[dict]) -> None:
    d = root / "your_instagram_activity" / "messages" / "inbox" / slug
    d.mkdir(parents=True)
    body = {"participants": [{"name": n} for n in people], "messages": messages}
    (d / "message_1.json").write_text(json.dumps(body))


def build_export(root: Path, external: bool = True, saved_layout: str = "older") -> None:
    day = 86_400_000
    t0 = 1_760_000_000_000
    write_thread(root, "me_1", ["Me"], [
        message("Me", t0, link=REEL_SELF, caption="self reel"),
        *([message("Me", t0 + 1, content=f"read {SITE_SELF}")] if external else []),
        message("Me", t0 + 2, link=REEL_SHARED, caption="in self too"),
    ])
    # Captions carry mojibake as Meta writes it: "é" as two latin-1 code points.
    write_thread(root, "alice_2", ["Me", "Alice"], [
        message("Alice", t0 + day, link=REEL_SHARED, caption="from alice Ã©"),
        *([message("Alice", t0 + day + 1, content=f"look {SITE_ALICE}")] if external else []),
    ])
    write_thread(root, "bob_3", ["Me", "Bob"], [
        message("Bob", t0 + 2 * day, link=POST_ONLY_BOB, caption="bob post \u00c3\u00a9"),
    ])
    write_thread(root, "carol_4", ["Me", "Carol"], [
        message("Carol", t0 + 3 * day, link=POST_NOT_ALLOWED, caption="carol, not named"),
        message("Carol", t0 + 3 * day + 1, content="no link here"),
    ])
    saved = root / "your_instagram_activity" / "saved"
    saved.mkdir(parents=True)
    if saved_layout == "newer":   # a list of label_values, as Meta's 2026 exports write it
        body = [{"timestamp": 1_760_000_000, "media": [], "fbid": "1",
                 "label_values": [{"label": "URL", "value": SAVED, "href": SAVED},
                                  {"label": "Caption", "value": "saved caption"},
                                  {"label": "Title", "value": ""}, {}]}]
    else:
        body = {"saved_saved_media": [
            {"title": "saver", "string_map_data": {"Saved on": {"href": SAVED, "timestamp": 1_760_000_000}}}]}
    (saved / "saved_posts.json").write_text(json.dumps(body))


def run(*args: str | Path, stdin: str | None = None) -> str:
    done = subprocess.run([str(a) for a in args], capture_output=True, text=True, input=stdin)
    if done.returncode:
        sys.exit(f"FAILED {' '.join(map(str, args))}\n{done.stderr}")
    return done.stdout


failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}")
    if not ok:
        failures.append(f"{name} {detail}")


def main() -> None:
    if sys.argv[1:2] == ["--write-fixture"]:
        root = Path(sys.argv[2])
        root.mkdir(parents=True)
        build_export(root, external=False)
        return
    with tempfile.TemporaryDirectory() as tmp:
        export = Path(tmp) / "instagram-fake"
        export.mkdir()
        build_export(export)
        origins = Path(tmp) / "origins.jsonl"

        listing = run(IMPORTER, export, "--list-threads").splitlines()
        check("list-threads is most links first", [r.split("\t")[1] for r in listing][:2] == ["me_1", "alice_2"], str(listing))
        check("list-threads names the participants", "Alice, Me" in listing[1], listing[1])

        plain = {json.loads(l)["url"]: json.loads(l) for l in run(IMPORTER, export, "--json").splitlines()}
        check("no --thread reads the self-thread and saved posts only",
              set(plain) == {REEL_SELF, REEL_SHARED, SAVED}, str(sorted(plain)))
        check("no --account stores no account", "account" not in plain[REEL_SELF])
        check("self-thread record names its thread", plain[REEL_SELF]["thread"] == ["me_1"], str(plain[REEL_SELF]))

        recs = {json.loads(l)["url"]: json.loads(l) for l in run(
            IMPORTER, export, "--json", "--account", "main", "--thread", "alice_2", "--thread", "bob_3").splitlines()}
        check("named threads are read, unnamed ones are not",
              set(recs) == {REEL_SELF, REEL_SHARED, POST_ONLY_BOB, SAVED}, str(sorted(recs)))
        check("a link met in two threads keeps both", recs[REEL_SHARED]["thread"] == ["me_1", "alice_2"], str(recs[REEL_SHARED]))
        check("account is stamped", all(r["account"] == "main" for r in recs.values()))
        check("senders names the person who sent it", recs[POST_ONLY_BOB]["senders"] == ["Bob"], str(recs[POST_ONLY_BOB]))
        check("a link two people sent keeps both, you once", recs[REEL_SHARED]["senders"] == ["Me", "Alice"], str(recs[REEL_SHARED]))
        check("saved posts are their own thread", recs[SAVED]["thread"] == ["saved_posts"], str(recs[SAVED]))
        check("first caption of a shared link is kept", recs[REEL_SHARED]["text"] == "in self too", recs[REEL_SHARED]["text"])
        check("mojibake is repaired", recs[POST_ONLY_BOB]["text"] == "bob post \u00e9", recs[POST_ONLY_BOB]["text"])

        other = run(IMPORTER, export, "--other", "--account", "main", "--thread", "alice_2",
                    "--origins-out", origins).splitlines()
        check("--other lists non-instagram links of the named threads",
              sorted(l.split("\t")[0] for l in other) == sorted([SITE_SELF, SITE_ALICE]), str(other))
        lines = [json.loads(l) for l in origins.read_text().splitlines()]
        by_url = {l["url"]: l for l in lines}
        check("origins cover every link, query stripped",
              set(by_url) == {SITE_SELF, "https://example.com/article", REEL_SELF, REEL_SHARED, SAVED}, str(sorted(by_url)))
        check("origin carries account, thread and senders",
              by_url["https://example.com/article"] == {"url": "https://example.com/article", "account": "main",
                                                        "thread": ["alice_2"], "senders": ["Alice"]},
              str(by_url["https://example.com/article"]))

        enriched = json.dumps({"kind": "page", "url": "https://example.com/article", "title": "T"}) + "\n" \
            + json.dumps({"kind": "page", "url": "https://elsewhere.test/"}) + "\n"
        out = [json.loads(l) for l in run(ATTACH, origins, stdin=enriched).splitlines()]
        check("attach fills origin onto a matching record",
              (out[0].get("account"), out[0].get("thread"), out[0].get("senders")) == ("main", ["alice_2"], ["Alice"]), str(out[0]))
        check("attach leaves a non-matching record untouched", out[1] == {"kind": "page", "url": "https://elsewhere.test/"}, str(out[1]))

        keeps = json.dumps({"url": "https://example.com/article", "account": "other"})
        kept = json.loads(run(ATTACH, origins, stdin=keeps + "\n"))
        check("attach keeps a field the record already has", kept["account"] == "other", str(kept))

        newer = Path(tmp) / "instagram-newer"
        newer.mkdir()
        build_export(newer, saved_layout="newer")
        newer_recs = {json.loads(l)["url"]: json.loads(l) for l in run(IMPORTER, newer, "--json").splitlines()}
        check("saved posts in the newer list layout are read", SAVED in newer_recs, str(sorted(newer_recs)))
        check("...with their caption", newer_recs[SAVED]["text"] == "saved caption", str(newer_recs.get(SAVED)))
        check("--stats runs on the newer layout", "links" in run(IMPORTER, newer, "--stats"))

        # The same link read from two accounts' exports.
        recs_in = [
            {"kind": "reel", "url": REEL_SHARED, "text": None, "account": "main", "thread": ["alice_2"], "senders": ["Alice"]},
            {"kind": "reel", "url": REEL_SELF, "text": None, "account": "main", "thread": ["me_1"], "senders": ["Me"]},
            {"kind": "reel", "url": REEL_SHARED, "text": "caption", "account": "side", "thread": ["me_1"], "senders": ["Me", "Alice"]},
            {"kind": "page", "url": "https://x.test/"},
            {"kind": "page", "url": "https://x.test/"},
        ]
        merged = [json.loads(l) for l in run(ATTACH, "--merge-duplicates",
                                             stdin="".join(json.dumps(r) + "\n" for r in recs_in)).splitlines()]
        check("merge collapses a link two accounts hold into one record", len(merged) == 4, str(merged))
        both = merged[0]
        check("...naming both accounts", both["account"] == ["main", "side"], str(both))
        check("...with every thread and sender once", (both["thread"], both["senders"]) == (["alice_2", "me_1"], ["Alice", "Me"]), str(both))
        check("...filling a missing field from the other record", both["text"] == "caption", str(both))
        check("a link one account holds keeps its single account", merged[1]["account"] == "main", str(merged[1]))
        check("records with no origin are never merged", [r["url"] for r in merged].count("https://x.test/") == 2)

        side = Path(tmp) / "origins-side.jsonl"
        side.write_text(json.dumps({"url": "https://example.com/article", "account": "side", "thread": ["me_1"], "senders": ["Me"]}) + "\n")
        two = json.loads(run(ATTACH, origins, side, stdin=json.dumps({"url": "https://example.com/article"}) + "\n"))
        check("attach names every account that holds a link", two["account"] == ["main", "side"] and two["senders"] == ["Alice", "Me"], str(two))

        check("--check still passes for an export with messages", subprocess.run([str(IMPORTER), str(export), "--check"]).returncode == 0)

    if failures:
        sys.exit("\n" + "\n".join(failures))
    print("all passed")


if __name__ == "__main__":
    main()
