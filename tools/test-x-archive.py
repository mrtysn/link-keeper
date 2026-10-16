#!/usr/bin/env python3
# DESC: Check the X archive importer against a made-up archive: threads, labels, senders, origins and the attach step.
"""Build a fake X data archive (a twitter-*.zip) in a temp directory and run importers/x-archive.py on it.

The layout copies a real archive's: data/account.js, data/tweets.js and the two DM files, each a
`window.YTD.<name>.part0 = [...]` script. Covers the conversation with yourself (always read), a named
one-to-one thread, a group thread named by its rename event, a thread that must stay out, a link met in
two threads, twitter.com folded into x.com, a DM's own media left out, `--list-threads`, `=LABEL`,
`--account`, `--origins-out`, `--check`, and `attach-dm-origin.py` putting the origin back on a record
the enrichers rebuilt. No network.

    tools/test-x-archive.py
    tools/test-x-archive.py --write-fixture FILE.zip   # only write the fake archive
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
IMPORTER = repo / "importers" / "x-archive.py"
ATTACH = repo / "importers" / "attach-dm-origin.py"

ME, ALICE, STRANGER = "100", "200", "300"
SELF = f"{ME}-{ME}"
WITH_ALICE = f"{ME}-{ALICE}"
WITH_STRANGER = f"{ME}-{STRANGER}"
GROUP = "9000"

TWEET_SELF = "https://x.com/someone/status/11"
TWEET_SHARED = "https://twitter.com/other/status/22?s=20&t=abc"
TWEET_SHARED_X = "https://x.com/other/status/22"
PAGE_ALICE = "https://example.com/article"
PAGE_STRANGER = "https://spam.example/win"
PAGE_GROUP = "https://example.org/club"
DM_MEDIA = "https://twitter.com/messages/media/123456"


def script(name: str, rows: list) -> str:
    return f"window.YTD.{name}.part0 = " + json.dumps(rows, indent=2)


def msg(sender: str, recipient: str | None, at: str, *urls: str) -> dict:
    body = {"senderId": sender, "createdAt": at, "text": "look " + " ".join(f"https://t.co/{i}" for i, _ in enumerate(urls)),
            "urls": [{"url": f"https://t.co/{i}", "expanded": u, "display": u[8:30]} for i, u in enumerate(urls)],
            "mediaUrls": [], "reactions": [], "id": at}
    if recipient:
        body["recipientId"] = recipient
    return {"messageCreate": body}


def build_archive(path: Path, with_dms: bool = True) -> None:
    files = {
        "data/account.js": script("account", [{"account": {"accountId": ME, "username": "me"}}]),
        "data/tweets.js": script("tweets", [{"tweet": {"id_str": "1", "full_text": "@alice hi",
                                                       "entities": {"user_mentions": [{"id_str": ALICE, "screen_name": "alice"}]}}}]),
    }
    if with_dms:
        files["data/direct-messages.js"] = script("direct_messages", [
            {"dmConversation": {"conversationId": SELF, "messages": [
                msg(ME, ME, "2026-01-02T10:00:00.000Z", TWEET_SELF),
                msg(ME, ME, "2026-01-03T10:00:00.000Z", TWEET_SHARED_X)]}},
            {"dmConversation": {"conversationId": WITH_ALICE, "messages": [
                msg(ALICE, ME, "2026-02-01T10:00:00.000Z", TWEET_SHARED, DM_MEDIA),
                msg(ME, ALICE, "2026-02-02T10:00:00.000Z", TWEET_SHARED),
                msg(ALICE, ME, "2026-02-03T10:00:00.000Z", PAGE_ALICE)]}},
            {"dmConversation": {"conversationId": WITH_STRANGER, "messages": [
                msg(STRANGER, ME, "2026-03-01T10:00:00.000Z", PAGE_STRANGER)]}},
        ])
        files["data/direct-messages-group.js"] = script("direct_messages_group", [
            {"dmConversation": {"conversationId": GROUP, "messages": [
                {"joinConversation": {"initiatingUserId": ALICE, "participantsSnapshot": [ME, ALICE], "createdAt": "2026-01-01T00:00:00.000Z"}},
                {"conversationNameUpdate": {"initiatingUserId": ALICE, "name": "book club", "createdAt": "2026-01-01T00:00:01.000Z"}},
                msg(ALICE, None, "2026-04-01T10:00:00.000Z", PAGE_GROUP)]}},
        ])
        # X Chat: end-to-end encrypted messages the archive keeps only as ciphertext, two with Alice and
        # one in a conversation that exists only as X Chat.
        enc = lambda cid: {"messageEvent": {"conversationId": cid, "senderId": ALICE, "detail": {"messageCreateEvent": {"contents": "CIPHERTEXT"}}}}
        files["data/message-event.js"] = script("message_event", [enc(f"{ME}:{ALICE}"), enc(f"{ME}:{ALICE}"), enc(f"{ME}:400"),
            {"messageEvent": {"conversationId": f"{ME}:{ALICE}", "detail": {"markConversationReadEvent": {}}}}])
    with zipfile.ZipFile(path, "w") as z:
        for name, body in files.items():
            z.writestr(name, body)


failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


def run(*args: str, ok: bool = True) -> subprocess.CompletedProcess:
    res = subprocess.run([sys.executable, "-I", str(IMPORTER), *args], capture_output=True, text=True)
    if ok and res.returncode:
        sys.exit(f"{IMPORTER.name} {' '.join(args)} failed:\n{res.stderr}")
    return res


def records(*args: str) -> dict[str, dict]:
    return {r["url"]: r for r in map(json.loads, run(*args, "--json").stdout.splitlines())}


def main() -> None:
    if sys.argv[1:2] == ["--write-fixture"]:
        build_archive(Path(sys.argv[2]))
        return

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        archive = tmp / "twitter-2026-10-15-abc.zip"
        build_archive(archive)
        a = str(archive)

        check("--check passes an archive with DMs", run(a, "--check", ok=False).returncode == 0)
        bare = tmp / "twitter-no-dms.zip"
        build_archive(bare, with_dms=False)
        check("--check fails an archive without DMs", run(str(bare), "--check", ok=False).returncode == 1)

        listed = [line.split("\t") for line in run(a, "--list-threads").stdout.splitlines()]
        check("--list-threads lists every thread with links, most first, ties by id",
              [r[1] for r in listed] == [WITH_ALICE, SELF, WITH_STRANGER, GROUP, f"{ME}-400"], str(listed))
        check("...naming a known person by handle, with a profile link",
              listed[0][2] == f"@alice  https://x.com/i/user/{ALICE}", listed[0][2])
        check("...an unknown one by id", listed[2][2].startswith(f"user {STRANGER}"), listed[2][2])
        check("...and a group by its name", listed[3][2] == "group: book club", listed[3][2])

        own = records(a)
        check("with no --thread only the conversation with yourself is read", set(own) == {TWEET_SELF, TWEET_SHARED_X}, str(set(own)))
        check("...labelled yourself", own[TWEET_SELF]["thread"] == ["yourself"], str(own[TWEET_SELF].get("thread")))

        got = records(a, "--thread", WITH_ALICE, "--thread", GROUP, "--account", "main")
        check("named threads are read", set(got) == {TWEET_SELF, TWEET_SHARED_X, PAGE_ALICE, PAGE_GROUP}, str(set(got)))
        check("a thread never named stays out", PAGE_STRANGER not in got)
        check("a DM's own media is not a link", not any("/messages/media/" in u for u in got))
        shared = got[TWEET_SHARED_X]
        check("twitter.com folds into x.com without the share params, one record", TWEET_SHARED not in got)
        check("a link in two threads lists both", shared["thread"] == ["yourself", "@alice"], str(shared["thread"]))
        check("...and each sender once", shared["senders"] == ["@me", "@alice"], str(shared["senders"]))
        check("...dated by its first sending", shared["saved_at"] == "2026-01-03", shared["saved_at"])
        check("a tweet is a bare tweet record", (shared["kind"], shared["text"], shared["author"]["handle"], shared["via"])
              == ("tweet", None, "@other", "x-archive"), str(shared))
        check("a page is a page record", got[PAGE_ALICE]["kind"] == "page" and got[PAGE_ALICE]["author"] is None)
        check("a group thread is named by its rename", got[PAGE_GROUP]["thread"] == ["book club"], str(got[PAGE_GROUP]["thread"]))
        check("--account stamps every record", all(r["account"] == "main" for r in got.values()))

        named = records(a, "--thread", f"{WITH_STRANGER}=the spammer")
        check("=LABEL names a thread", named[PAGE_STRANGER]["thread"] == ["the spammer"], str(named[PAGE_STRANGER]["thread"]))
        check("an unknown thread id is an error", run(a, "--thread", "1-2", ok=False).returncode != 0)

        lines = run(a, "--other", "--thread", WITH_ALICE).stdout.splitlines()
        check("--other lists every link as URL<TAB>date, newest first",
              lines == [f"{PAGE_ALICE}\t2026-02-03", f"{TWEET_SHARED_X}\t2026-01-03", f"{TWEET_SELF}\t2026-01-02"], str(lines))

        origins = tmp / "origins.jsonl"
        run(a, "--other", "--thread", WITH_ALICE, "--account", "main", "--origins-out", str(origins))
        rows = {r["url"]: r for r in map(json.loads, origins.read_text().splitlines())}
        check("--origins-out writes one line per link", set(rows) == {TWEET_SELF, TWEET_SHARED_X, PAGE_ALICE})
        enriched = json.dumps({"kind": "tweet", "url": TWEET_SHARED_X + "?s=46", "text": "fetched text"})
        res = subprocess.run([sys.executable, "-I", str(ATTACH), str(origins)], input=enriched, capture_output=True, text=True)
        back = json.loads(res.stdout)
        check("attach-dm-origin puts the origin back on an enriched record",
              (back.get("account"), back.get("thread"), back.get("senders")) == ("main", ["yourself", "@alice"], ["@me", "@alice"]),
              res.stdout or res.stderr)

        listed = {r.split("\t")[1]: r.split("\t") for r in run(a, "--list-threads").stdout.splitlines()}
        check("--list-threads counts a conversation's encrypted X Chat messages", listed[WITH_ALICE][3:] == ["+2 encrypted X Chat messages"], str(listed[WITH_ALICE]))
        check("...and lists one that exists only as X Chat", listed.get(f"{ME}-400", [""])[0] == "0" and listed[f"{ME}-400"][3] == "+1 encrypted X Chat message", str(listed.get(f"{ME}-400")))
        warn = run(a, "--json", "--thread", WITH_ALICE).stderr
        check("--json warns once for a named thread with encrypted messages, with where to grab them",
              warn.count("encrypted X Chat") == 1 and "2 encrypted X Chat messages with @alice" in warn and f"x.com/i/chat/{WITH_ALICE}" in warn, warn)
        check("...and not for threads it was not asked to read", "user 400" not in warn)

        stats = run(a, "--stats", "--thread", WITH_ALICE).stdout
        check("--stats counts links, tweets and threads", stats.startswith("3 links (2 tweets, 1 other) from 2 threads"), stats)

    if failed:
        sys.exit("\nsome checks failed")
    print("all passed")


if __name__ == "__main__":
    main()
