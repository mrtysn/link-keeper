#!/usr/bin/env python3
# DESC: Link Keeper's sync server: holds each Mac's encrypted changes and the latest snapshot, nothing it can read.
"""The sync server for Link Keeper.

Every Mac's add-on records its changes, encrypts them with a key the server never sees, and its
helper sends them here as opaque batches. Other Macs fetch the batches they have not seen yet. The
server stores, orders and hands out ciphertext: it cannot read a link, a tag or a capture.

  GET  /healthz                    {"ok": true}; no token
  GET  /v1/whoami                  {"device"}: the device the token belongs to
  POST /v1/ops                     {"batches": [{"id", "blob"}]} -> {"seq"}; a batch id already
                                   stored is skipped, so a resend after a lost answer is harmless
  GET  /v1/ops?since=N&limit=L     {"ops": [{"seq", "device", "blob"}], "more", "last"}; 409
                                   {"error": "behind", "floor"} when batches up to N were compacted
                                   into the snapshot
  GET  /v1/snapshot                {"upto", "device", "at", "blob"}, or 404 before the first one
  PUT  /v1/snapshot                {"upto", "blob"}: the sender's whole state, encrypted, holding every
                                   batch up to seq `upto`; batches up to `upto` are then dropped

Every /v1 call needs "Authorization: Bearer <token>". Tokens are "<device>.<secret>"; the server keeps
only their SHA-256 in tokens.json ({"<device>": "<hex>"}), read on every request so a device is added
or revoked without a restart.

Settings from the environment: LKS_DATA (folder for sync.db and tokens.json, default ./data),
LKS_HOST (default 127.0.0.1), LKS_PORT (default 8791), LKS_MAX_BODY (bytes, default 64 MB).
Standard library only; Python 3.9 syntax, so the tests run on the Mac's system Python.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DATA = Path(os.environ.get("LKS_DATA") or Path(__file__).resolve().parent / "data")
HOST = os.environ.get("LKS_HOST") or "127.0.0.1"
PORT = int(os.environ.get("LKS_PORT") or 8791)
MAX_BODY = int(os.environ.get("LKS_MAX_BODY") or 64 * 1024 * 1024)
MAX_LIMIT = 1000
BATCH_ID = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")

db_lock = threading.Lock()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def open_db(folder: Path) -> sqlite3.Connection:
    folder.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(folder / "sync.db"), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS ops (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL UNIQUE,
            device TEXT NOT NULL, blob TEXT NOT NULL, at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshot (
            id INTEGER PRIMARY KEY CHECK (id = 1), upto INTEGER NOT NULL,
            device TEXT NOT NULL, blob TEXT NOT NULL, at TEXT NOT NULL);
    """)
    return con


def token_device(folder: Path, header: str | None) -> str | None:
    """The device a bearer token belongs to, or None."""
    m = re.match(r"^Bearer\s+(\S+)$", header or "")
    if not m:
        return None
    digest = hashlib.sha256(m.group(1).encode()).hexdigest()
    try:
        tokens = json.loads((folder / "tokens.json").read_text())
    except (OSError, ValueError):
        return None
    found = None
    for device, want in tokens.items():
        if isinstance(want, str) and hmac.compare_digest(want, digest):
            found = device
    return found


def last_seq(con: sqlite3.Connection) -> int:
    """The newest batch's seq; after compaction with nothing newer, the snapshot's."""
    row = con.execute("SELECT MAX(seq) FROM ops").fetchone()
    return int(row[0]) if row and row[0] is not None else floor(con)


def floor(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT upto FROM snapshot WHERE id = 1").fetchone()
    return int(row[0]) if row else 0


def push(con: sqlite3.Connection, device: str, body: dict) -> tuple[int, dict]:
    batches = body.get("batches")
    if not isinstance(batches, list):
        return 400, {"error": "batches must be a list"}
    for b in batches:
        if not isinstance(b, dict) or not BATCH_ID.match(str(b.get("id") or "")) or not isinstance(b.get("blob"), str):
            return 400, {"error": "each batch needs an id (letters, digits, . _ : -) and a string blob"}
    with db_lock, con:
        stored = 0
        for b in batches:
            if con.execute("SELECT 1 FROM ops WHERE batch = ?", (b["id"],)).fetchone():
                continue
            con.execute("INSERT INTO ops (batch, device, blob, at) VALUES (?, ?, ?, ?)",
                        (b["id"], device, b["blob"], now()))
            stored += 1
        return 200, {"ok": True, "stored": stored, "seq": last_seq(con)}


def pull(con: sqlite3.Connection, query: dict) -> tuple[int, dict]:
    try:
        since = int((query.get("since") or ["0"])[0])
        limit = min(max(int((query.get("limit") or ["500"])[0]), 1), MAX_LIMIT)
    except ValueError:
        return 400, {"error": "since and limit are numbers"}
    with db_lock:
        low = floor(con)
        if since < low:
            return 409, {"error": "behind", "floor": low}
        rows = con.execute("SELECT seq, device, blob FROM ops WHERE seq > ? ORDER BY seq LIMIT ?",
                           (since, limit + 1)).fetchall()
        last = last_seq(con)
    more = len(rows) > limit
    rows = rows[:limit]
    return 200, {"ok": True, "ops": [{"seq": s, "device": d, "blob": b} for s, d, b in rows], "more": more, "last": last}


def get_snapshot(con: sqlite3.Connection) -> tuple[int, dict]:
    with db_lock:
        row = con.execute("SELECT upto, device, blob, at FROM snapshot WHERE id = 1").fetchone()
    if not row:
        return 404, {"error": "no snapshot"}
    return 200, {"ok": True, "upto": row[0], "device": row[1], "blob": row[2], "at": row[3]}


def put_snapshot(con: sqlite3.Connection, device: str, body: dict) -> tuple[int, dict]:
    upto, blob = body.get("upto"), body.get("blob")
    if not isinstance(upto, int) or upto < 0 or not isinstance(blob, str):
        return 400, {"error": "upto (a seq) and blob (a string) are needed"}
    with db_lock, con:
        if upto > last_seq(con):
            return 409, {"error": f"upto {upto} is past the last batch {last_seq(con)}"}
        if upto < floor(con):
            return 409, {"error": f"a newer snapshot holds batches up to {floor(con)}", "floor": floor(con)}
        con.execute("INSERT OR REPLACE INTO snapshot (id, upto, device, blob, at) VALUES (1, ?, ?, ?, ?)",
                    (upto, device, blob, now()))
        dropped = con.execute("DELETE FROM ops WHERE seq <= ?", (upto,)).rowcount
    return 200, {"ok": True, "upto": upto, "dropped": dropped}


def make_handler(folder: Path, con: sqlite3.Connection):
    class Handler(BaseHTTPRequestHandler):
        server_version = "link-keeper-sync"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # one line per request, no bodies, no tokens
            sys.stderr.write(f"{now()} {self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}\n")

        def answer(self, code: int, obj: dict) -> None:
            raw = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def body(self) -> dict | None:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return None
            try:
                obj = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return None
            return obj if isinstance(obj, dict) else None

        def route(self, method: str) -> None:
            url = urlparse(self.path)
            if url.path == "/healthz" and method == "GET":
                return self.answer(200, {"ok": True})
            if not url.path.startswith("/v1/"):
                return self.answer(404, {"error": "not found"})
            device = token_device(folder, self.headers.get("Authorization"))
            if not device:
                return self.answer(401, {"error": "a valid bearer token is needed"})
            if method in ("POST", "PUT"):
                if int(self.headers.get("Content-Length") or 0) > MAX_BODY:
                    return self.answer(413, {"error": f"body over {MAX_BODY} bytes"})
                body = self.body()
                if body is None:
                    return self.answer(400, {"error": "send one JSON object"})
            key = (method, url.path)
            if key == ("GET", "/v1/whoami"):
                return self.answer(200, {"ok": True, "device": device})
            if key == ("POST", "/v1/ops"):
                return self.answer(*push(con, device, body))
            if key == ("GET", "/v1/ops"):
                return self.answer(*pull(con, parse_qs(url.query)))
            if key == ("GET", "/v1/snapshot"):
                return self.answer(*get_snapshot(con))
            if key == ("PUT", "/v1/snapshot"):
                return self.answer(*put_snapshot(con, device, body))
            return self.answer(404, {"error": "not found"})

        def do_GET(self):
            self.route("GET")

        def do_POST(self):
            self.route("POST")

        def do_PUT(self):
            self.route("PUT")

    return Handler


def serve(folder: Path = DATA, host: str = HOST, port: int = PORT) -> ThreadingHTTPServer:
    con = open_db(folder)
    return ThreadingHTTPServer((host, port), make_handler(folder, con))


if __name__ == "__main__":
    httpd = serve()
    sys.stderr.write(f"link-keeper-sync on {HOST}:{PORT}, data in {DATA}\n")
    httpd.serve_forever()
