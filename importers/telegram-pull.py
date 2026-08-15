#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["telethon>=1.36"]
# ///
# DESC: Pull new links straight out of Saved Messages — no export, no steps on the phone.
"""Read Saved Messages through Telegram's own API and append any links to the inbox file.

This replaces the "Export chat history" dance: share a link to Saved Messages from any app on
any device, and the next refresh picks it up. Messages are read with your own account via
Telethon (official MTProto API). Nothing is posted, marked read, or modified — this only reads.

One-time setup:
  1. https://my.telegram.org -> API development tools -> create an app; note api_id + api_hash.
  2. Put them in config.local.sh:  TELEGRAM_API_ID=...  TELEGRAM_API_HASH=...
  3. Run `./telegram-pull.py --login` in a terminal once — it asks for your phone number and
     the code Telegram sends you. The session lands in ~/.config/link-keeper/ (chmod 600) and
     no later run ever prompts again.

State: the id of the last message seen is kept next to the session, so each run reads only
what is new. The inbox file (URL<TAB>date, the worklist format) is append-only; downstream
dedupes. Media and plain notes are ignored — only messages carrying links matter here.

Usage:
    ./telegram-pull.py --login          # first run, interactive
    ./telegram-pull.py                  # pull new links into $DATA_DIR/link-inbox.tsv
    ./telegram-pull.py --inbox f.tsv    # explicit inbox path
    ./telegram-pull.py --all            # ignore state, re-read the whole history
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import timezone
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.types import MessageEntityTextUrl, MessageEntityUrl

CONF_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "link-keeper"
SESSION = CONF_DIR / "telegram"
STATE = CONF_DIR / "saved-messages-state.json"


def config_value(name: str) -> str | None:
    """Environment first, then config.local.sh — same precedence as the zsh tools."""
    if os.environ.get(name):
        return os.environ[name]
    config = Path(__file__).resolve().parent.parent / "config.local.sh"
    if config.is_file():
        out = subprocess.run(
            ["zsh", "-c", f'source "{config}" && print -rn -- "${{{name}:-}}"'],
            capture_output=True, text=True,
        ).stdout.strip()
        return out or None
    return None


def links_of(msg) -> list[str]:
    """URLs from entities, the same source the export uses — no regex over message text."""
    urls = []
    for ent, text in msg.get_entities_text() if msg.entities else []:
        if isinstance(ent, MessageEntityTextUrl):
            urls.append(ent.url)
        elif isinstance(ent, MessageEntityUrl) and text.startswith(("http://", "https://")):
            urls.append(text)
    return urls


async def run(args: argparse.Namespace, api_id: int, api_hash: str) -> int:
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(CONF_DIR, 0o700)
    client = TelegramClient(str(SESSION), api_id, api_hash)

    if args.login:
        await client.start()   # interactive: prompts for phone + code on first run
        me = await client.get_me()
        print(f"logged in as {me.first_name} (@{me.username}) — session at {SESSION}.session")
        await client.disconnect()
        return 0

    if not (SESSION.with_suffix(".session")).is_file():
        print(f"no session at {SESSION}.session — run with --login once first", file=sys.stderr)
        return 1

    await client.connect()
    if not await client.is_user_authorized():
        print("session expired — run with --login again", file=sys.stderr)
        await client.disconnect()
        return 1

    last_id = 0
    if not args.all and STATE.is_file():
        last_id = json.loads(STATE.read_text()).get("last_id", 0)

    rows: list[tuple[int, str, str]] = []   # (msg_id, url, date)
    max_id = last_id
    async for msg in client.iter_messages("me", min_id=last_id):
        max_id = max(max_id, msg.id)
        date = msg.date.astimezone(timezone.utc).strftime("%Y-%m-%d") if msg.date else ""
        for url in links_of(msg):
            rows.append((msg.id, url, date))
    await client.disconnect()

    rows.sort()   # oldest first, so the inbox stays chronological on disk
    if rows:
        with open(args.inbox, "a", encoding="utf-8") as fh:
            for _, url, date in rows:
                fh.write(f"{url}\t{date}\n")
    STATE.write_text(json.dumps({"last_id": max_id}))

    print(f"{len(rows)} new links -> {args.inbox}" if rows else "nothing new")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Pull links from Saved Messages into the inbox file.")
    p.add_argument("--login", action="store_true", help="interactive first-time login")
    p.add_argument("--inbox", help="inbox file (default: $DATA_DIR/link-inbox.tsv)")
    p.add_argument("--all", action="store_true", help="ignore saved state, read everything")
    args = p.parse_args()

    api_id, api_hash = config_value("TELEGRAM_API_ID"), config_value("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        print("TELEGRAM_API_ID / TELEGRAM_API_HASH not set — see the header for setup", file=sys.stderr)
        return 1

    if not args.inbox:
        data_dir = config_value("DATA_DIR")
        if not data_dir:
            print("no --inbox and no DATA_DIR configured", file=sys.stderr)
            return 1
        args.inbox = str(Path(data_dir) / "link-inbox.tsv")

    return asyncio.run(run(args, int(api_id), api_hash))


if __name__ == "__main__":
    sys.exit(main())
