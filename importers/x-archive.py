#!/usr/bin/env python3
# DESC: Turn an X (Twitter) data archive's direct messages into links and capture records.
"""Extract the links in your X direct messages: the conversation with yourself, and the others you name.

The source is the account archive (Settings -> Your account -> Download an archive of your data), as
the downloaded twitter-*.zip or the unzipped folder. Two files in its data/ folder hold the DMs, each
a script that assigns one JSON array:

  * `direct-messages.js` — one-to-one conversations, `conversationId` "<id>-<id>";
  * `direct-messages-group.js` — group conversations, named by their `conversationNameUpdate` events.

Each `messageCreate` carries `urls[]` with the real address in `expanded` (the t.co wrapper in `url`),
`senderId` and `createdAt`. A conversation with yourself ("<your id>-<your id>") is always read; the
others only when named with `--thread` (repeatable) by conversation id — `--list-threads` prints every
conversation that holds links, most links first, with who is in it. Spam groups are common, which is
why nothing is read by default but your own.

The archive names people by numeric id only. Handles are recovered from your own tweets (the people
you mentioned or replied to) and your account; anyone else shows as "user <id>", and their profile is
https://x.com/i/user/<id>. `--thread ID=label` names a thread whose person the archive cannot.

A link met in several threads is one record whose `thread` lists them all and whose `senders` lists
each distinct sender once (you included, once). `--account NAME` stamps the record with the account.

The archive holds no content for a shared tweet or page, so `--json` emits bare records — the link,
when it was sent, where — which a later import with text upgrades (the extension fills a record that
has no text). `--other` lists every link as URL<TAB>date for the enrichers, and `--origins-out` writes
the origin lines `attach-dm-origin.py` puts back on their records.

Usage:
    ./x-archive.py twitter-2026-10-15-….zip --list-threads
    ./x-archive.py archive.zip --stats --thread 123-456
    ./x-archive.py archive.zip --json --account main --thread 123-456 --thread 789=book-club
    ./x-archive.py archive/ --other --origins-out origins.jsonl --thread 123-456
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

X_HOSTS = {"x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "www.twitter.com", "www.x.com"}
STATUS_RE = re.compile(r"^/([^/]+)/status(?:es)?/(\d+)")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Extract links from an X data archive's direct messages, newest first.",
        epilog="Request the archive at x.com: Settings -> Your account -> Download an archive of your data.",
    )
    p.add_argument("archive", type=Path, help="the downloaded twitter-*.zip, or the unzipped folder")
    p.add_argument("--thread", action="append", default=[], metavar="ID[=LABEL]",
                   help="a conversation id to read besides the one with yourself; repeat for several "
                   "(see --list-threads). =LABEL names it where the archive cannot")
    p.add_argument("--account", help="name of the account this archive belongs to, stored on each record")
    p.add_argument("--origins-out", type=Path, metavar="FILE",
                   help="also write one JSON line per link — url, account, thread, senders")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--json", action="store_true", help="emit bare capture records for every link")
    mode.add_argument("--other", action="store_true", help="emit every link as URL<TAB>date")
    mode.add_argument("--stats", action="store_true", help="summarise instead of listing")
    mode.add_argument("--list-threads", action="store_true",
                      help="list every conversation holding links, most links first")
    mode.add_argument("--check", action="store_true", help="exit 0 if the archive holds direct messages")
    return p.parse_args()


class Archive:
    """Reads the archive's data/*.js files from a zip or a folder."""

    def __init__(self, root: Path):
        self.zip = zipfile.ZipFile(root) if root.is_file() else None
        self.root = root

    def _path(self, name: str) -> str | None:
        if self.zip:
            hits = [n for n in self.zip.namelist() if n == f"data/{name}" or n.endswith(f"/data/{name}")]
            return hits[0] if hits else None
        hits = [p for p in (self.root / "data" / name, self.root / name) if p.is_file()]
        return str(hits[0]) if hits else None

    def has(self, name: str) -> bool:
        return self._path(name) is not None

    def load(self, name: str) -> list:
        """The array a `window.YTD.<x>.part0 = [...]` file assigns; [] when the file is absent."""
        path = self._path(name)
        if path is None:
            return []
        raw = (self.zip.read(path) if self.zip else Path(path).read_bytes()).decode("utf-8")
        return json.loads(raw[raw.index("=") + 1:])


def owner(ar: Archive) -> tuple[str | None, str | None]:
    acc = (ar.load("account.js") or [{}])[0].get("account", {})
    return acc.get("accountId"), acc.get("username")


def known_handles(ar: Archive) -> dict[str, str]:
    """User id -> handle, from the people your own tweets mention or reply to."""
    out: dict[str, str] = {}
    for row in ar.load("tweets.js"):
        t = row.get("tweet", row)
        for m in t.get("entities", {}).get("user_mentions", []):
            if m.get("id_str") and m.get("screen_name"):
                out[m["id_str"]] = m["screen_name"]
        if t.get("in_reply_to_user_id_str") and t.get("in_reply_to_screen_name"):
            out[t["in_reply_to_user_id_str"]] = t["in_reply_to_screen_name"]
    return out


class People:
    def __init__(self, ar: Archive):
        self.me, me_handle = owner(ar)
        self.handles = known_handles(ar)
        if self.me and me_handle:
            self.handles[self.me] = me_handle

    def name(self, uid: str) -> str:
        h = self.handles.get(uid)
        return f"@{h}" if h else f"user {uid}"


def conversations(ar: Archive) -> list[dict]:
    """Every conversation, one-to-one and group, as {id, group, name, messages}."""
    out = []
    for name, group in (("direct-messages.js", False), ("direct-messages-group.js", True)):
        for row in ar.load(name):
            dc = row.get("dmConversation", {})
            title = None
            for m in dc.get("messages", []):
                if "conversationNameUpdate" in m:
                    title = m["conversationNameUpdate"].get("name") or title
            out.append({"id": dc.get("conversationId", ""), "group": group, "name": title,
                        "messages": [m["messageCreate"] for m in dc.get("messages", []) if "messageCreate" in m]})
    return out


def is_self(conv: dict, me: str | None) -> bool:
    return not conv["group"] and bool(me) and set(conv["id"].split("-")) == {me}


def label(conv: dict, people: People, given: str | None = None) -> str:
    """What a thread is called on a record: given > group name > the other person > yourself."""
    if given:
        return given
    if conv["group"]:
        return conv["name"] or f"group {conv['id']}"
    others = [i for i in conv["id"].split("-") if i != people.me]
    return people.name(others[0]) if others else "yourself"


def canonical(url: str) -> str:
    """x.com for a tweet, without the share params; other links as given, minus a t.co-style tail."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in X_HOSTS:
        m = STATUS_RE.match(parts.path)
        if m:
            return f"https://x.com/{m.group(1)}/status/{m.group(2)}"
        return f"https://x.com{parts.path.rstrip('/')}" + (f"?{parts.query}" if parts.query and parts.path.startswith("/i/") else "")
    return url


def message_links(msg: dict):
    for u in msg.get("urls", []):
        url = u.get("expanded") or u.get("url")
        # A photo or video sent in the DM itself points back into the conversation; it is not a link.
        if url and "/messages/media/" not in url and not re.search(r"/i/web/status|/messages/\d", url):
            yield url


def chosen_threads(convs: list[dict], picks: list[str], me: str | None) -> list[tuple[dict, str | None]]:
    """The conversations to read, each with the label given for it: yours, then the named ones in order."""
    by_id = {c["id"]: c for c in convs}
    wanted: list[tuple[dict, str | None]] = [(c, None) for c in convs if is_self(c, me)]
    for pick in picks:
        cid, _, given = pick.partition("=")
        if cid not in by_id:
            sys.exit(f"no conversation with id {cid!r}; see --list-threads")
        if all(c["id"] != cid for c, _ in wanted):
            wanted.append((by_id[cid], given or None))
    return wanted


def gather(convs, picks, people):
    """Yield (url, date, thread label, sender) for every link in the chosen conversations."""
    for conv, given in chosen_threads(convs, picks, people.me):
        name = label(conv, people, given)
        for msg in conv["messages"]:
            date = (msg.get("createdAt") or "")[:10]
            for url in message_links(msg):
                yield url, date, name, people.name(msg["senderId"]) if msg.get("senderId") else None


def is_tweet(url: str) -> bool:
    return bool(STATUS_RE.match(urlsplit(url).path)) and (urlsplit(url).hostname or "") in X_HOSTS


def record(url: str, date: str, account: str | None, threads: list[str], senders: list[str]) -> dict:
    tweet = is_tweet(url)
    return {
        "kind": "tweet" if tweet else "page",
        "url": url,
        "source_url": None,
        "title": None,
        "text": None,
        "author": {"name": None, "handle": "@" + STATUS_RE.match(urlsplit(url).path).group(1)} if tweet else None,
        "saved_at": date or None,
        "images": [],
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "via": "x-archive",
        **({"site": "X"} if tweet else {}),
        **origin(account, threads, senders),
    }


def encrypted_counts(ar: Archive) -> dict[str, int]:
    """Conversation id ("<id>-<id>") -> how many X Chat messages it holds that the archive keeps only as
    ciphertext (data/message-event.js). X Chat is end-to-end encrypted: the archive cannot read them, and
    a conversation that moved there looks complete here when it is not. Link Keeper's chat grab reads
    them from the chat page."""
    out: dict[str, int] = {}
    for row in ar.load("message-event.js"):
        ev = row.get("messageEvent", {})
        if "messageCreateEvent" in (ev.get("detail") or {}):
            cid = str(ev.get("conversationId", "")).replace(":", "-")
            out[cid] = out.get(cid, 0) + 1
    return out


def origin(account: str | None, threads: list[str] | None, senders: list[str] | None) -> dict:
    out: dict = {}
    if account:
        out["account"] = account
    if threads:
        out["thread"] = threads
    if senders:
        out["senders"] = senders
    return out


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    args = parse_args()
    if not args.archive.exists():
        sys.exit(f"no such archive: {args.archive}")
    ar = Archive(args.archive)

    if args.check:
        sys.exit(0 if ar.has("direct-messages.js") or ar.has("direct-messages-group.js") else 1)

    people = People(ar)
    convs = conversations(ar)
    encrypted = encrypted_counts(ar)

    if args.list_threads:
        # Links readable here, the id, who; a fourth column counts the X Chat messages the archive holds
        # only encrypted. A conversation that exists only as X Chat is listed too, with 0 readable links.
        rows = []
        seen = set()
        for c in convs:
            n = sum(1 for m in c["messages"] for _ in message_links(m))
            seen.add(c["id"])
            if not n and not encrypted.get(c["id"]):
                continue
            if c["group"]:
                who = f"group: {label(c, people)}"
            else:
                others = [i for i in c["id"].split("-") if i != people.me]
                who = "yourself" if not others else f"{people.name(others[0])}  https://x.com/i/user/{others[0]}"
            rows.append((n, c["id"], who))
        for cid in encrypted:
            if cid not in seen:
                others = [i for i in cid.split("-") if i != people.me]
                rows.append((0, cid, "yourself" if not others else f"{people.name(others[0])}  https://x.com/i/user/{others[0]}"))
        for n, cid, who in sorted(rows, key=lambda r: (-r[0], r[1])):
            enc = encrypted.get(cid)
            print(f"{n}\t{cid}\t{who}" + (f"\t+{enc} encrypted X Chat message{'s' if enc != 1 else ''}" if enc else ""))
        return

    # A named thread with encrypted X Chat messages is only partly read: say so, once (with --json,
    # which refresh runs once per archive), and where to get the rest.
    if args.json:
        for conv, given in chosen_threads(convs, args.thread, people.me):
            enc = encrypted.get(conv["id"])
            if enc:
                print(f"! {enc} encrypted X Chat message{'s' if enc != 1 else ''} with {label(conv, people, given)} are not in the archive's readable DMs: "
                      f"grab them from the chat page, https://x.com/i/chat/{conv['id']} (Link Keeper's popup there)", file=sys.stderr)

    rows: dict[str, dict] = {}
    for url, date, thread, sender in gather(convs, args.thread, people):
        key = canonical(url)
        row = rows.get(key)
        if row is None:
            rows[key] = row = {"url": key, "date": date, "threads": [], "senders": []}
        row["date"] = min(row["date"], date) if row["date"] and date else row["date"] or date
        if thread not in row["threads"]:
            row["threads"].append(thread)
        if sender and sender not in row["senders"]:
            row["senders"].append(sender)
    ordered = sorted(rows.values(), key=lambda r: r["date"], reverse=True)

    if args.origins_out:
        with args.origins_out.open("w") as fh:
            for r in ordered:
                fh.write(json.dumps({"url": r["url"], **origin(args.account, r["threads"], r["senders"])},
                                    ensure_ascii=False) + "\n")

    if args.stats:
        tweets = sum(1 for r in ordered if is_tweet(r["url"]))
        dates = [r["date"] for r in ordered if r["date"]]
        threads = {t for r in ordered for t in r["threads"]}
        print(f"{len(ordered)} links ({tweets} tweets, {len(ordered) - tweets} other) from {len(threads)} threads")
        if dates:
            print(f"span  {min(dates)} .. {max(dates)}")
        return

    for r in ordered:
        if args.json:
            print(json.dumps(record(r["url"], r["date"], args.account, r["threads"], r["senders"]), ensure_ascii=False))
        else:
            print(f"{r['url']}\t{r['date']}")


if __name__ == "__main__":
    main()
