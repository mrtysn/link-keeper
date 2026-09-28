#!/usr/bin/python3
# DESC: Firefox native-messaging helper: reopen stashed file: tabs, which an extension cannot open itself.
#
# Link Keeper sends {"open": ["file:///…", …]}. Each URL must be a file: URL naming a file that
# exists; anything else is refused, so the extension cannot use this to run or open anything but a
# local file. Accepted files are opened in the Firefox that launched this helper — found from the
# parent process, so no browser path is configured — in the background, as new tabs.
#
# Reply: {"ok": true, "opened": [...], "failed": [{"url": ..., "error": ...}]}
#
# /usr/bin/python3 on purpose: Firefox starts helpers with launchd's bare PATH, where an asdf or
# Homebrew python is not found. Set LINK_KEEPER_OPEN_DRY_RUN=1 to report the open command instead
# of running it (tools/test-open-local-files.py does).

import json
import os
import struct
import subprocess
import sys
from urllib.parse import unquote, urlparse


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send_message(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("@I", len(body)) + body)
    sys.stdout.buffer.flush()


def firefox_bundle():
    """The .app of the Firefox process that started this helper."""
    comm = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getppid())],
                          capture_output=True, text=True).stdout.strip()
    if ".app/" not in comm:
        return None
    return comm[: comm.index(".app/") + len(".app")]


def check(url):
    parsed = urlparse(url)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        return "not a local file: URL"
    if not os.path.isfile(unquote(parsed.path)):
        return "file no longer exists"
    return None


def main():
    msg = read_message()
    if not isinstance(msg, dict) or not isinstance(msg.get("open"), list):
        send_message({"ok": False, "error": "expected {\"open\": [urls]}"})
        return

    opened, failed = [], []
    for url in msg["open"]:
        error = check(url) if isinstance(url, str) else "not a string"
        (failed.append({"url": url, "error": error}) if error else opened.append(url))

    if opened:
        dry = bool(os.environ.get("LINK_KEEPER_OPEN_DRY_RUN"))
        app = firefox_bundle() or ("<parent is not Firefox>" if dry else None)
        if not app:
            send_message({"ok": False, "error": "could not tell which Firefox started the helper"})
            return
        cmd = ["open", "-g", "-a", app, *opened]
        if dry:
            send_message({"ok": True, "dry_run": cmd, "opened": opened, "failed": failed})
            return
        done = subprocess.run(cmd, capture_output=True, text=True)
        if done.returncode != 0:
            send_message({"ok": False, "error": done.stderr.strip() or f"open exited {done.returncode}"})
            return

    send_message({"ok": True, "opened": opened, "failed": failed})


if __name__ == "__main__":
    main()
