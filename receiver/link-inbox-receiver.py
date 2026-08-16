#!/usr/bin/env python3
# DESC: Receive shared links from the phone and append them to the inbox file.
"""The receiving end of "share -> Link Keeper -> done".

The Android share target POSTs here; every accepted link becomes one line in the inbox file —
`URL<TAB>YYYY-MM-DD<TAB>client` — which the Mac mirrors during a refresh. Append-only, no
database, no dependencies: the inbox is a work queue measured in kilobytes.

Meant to sit on a Tailscale address, so the network is the first wall and the bearer token the
second. Nothing here should ever face the public internet.

Endpoints:
    POST /add   body: {"url": "...", "date": "YYYY-MM-DD"?, "client": "..."?}
                or a raw text body that is simply the URL.
                Requires:  Authorization: Bearer $LINK_INBOX_TOKEN
    GET  /      health check, no auth, replies "link-inbox"

Configuration, all by environment (see link-inbox.service.example):
    LINK_INBOX_FILE    where lines land (required)
    LINK_INBOX_TOKEN   shared secret the phone must present (required)
    LINK_INBOX_BIND    address to bind (default 127.0.0.1 — bind the Tailscale IP in the unit)
    LINK_INBOX_PORT    port (default 8477)
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date as _date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

INBOX = os.environ.get("LINK_INBOX_FILE")
TOKEN = os.environ.get("LINK_INBOX_TOKEN")
BIND = os.environ.get("LINK_INBOX_BIND", "127.0.0.1")
PORT = int(os.environ.get("LINK_INBOX_PORT", "8477"))


class Handler(BaseHTTPRequestHandler):
    server_version = "link-inbox"

    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/":
            self.reply(200, {"ok": True, "service": "link-inbox"})
        else:
            self.reply(404, {"ok": False})

    def do_POST(self) -> None:
        if self.path != "/add":
            return self.reply(404, {"ok": False})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self.reply(401, {"ok": False, "error": "bad token"})

        raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536))
        url, when, client = "", "", ""
        try:
            body = json.loads(raw)
            url = (body.get("url") or "").strip()
            when = (body.get("date") or "").strip()
            client = (body.get("client") or "").strip()
        except (json.JSONDecodeError, AttributeError):
            url = raw.decode("utf-8", "replace").strip()

        # Shares often arrive as "some caption text https://..." — take the URL out of it.
        if url and not url.startswith(("http://", "https://")):
            url = next((w for w in url.split() if w.startswith(("http://", "https://"))), "")
        parts = urlsplit(url)
        if not url or parts.scheme not in ("http", "https") or not parts.netloc or any(c in url for c in "\t\n\r"):
            return self.reply(400, {"ok": False, "error": "no usable url in body"})

        line = f"{url}\t{when or _date.today().isoformat()}\t{client or 'phone'}\n"
        with open(INBOX, "a", encoding="utf-8") as fh:
            fh.write(line)
        self.reply(200, {"ok": True})

    def log_message(self, fmt, *args):  # systemd's journal gets one line per request
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    if not INBOX or not TOKEN:
        print("LINK_INBOX_FILE and LINK_INBOX_TOKEN are required", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(INBOX) or ".", exist_ok=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
