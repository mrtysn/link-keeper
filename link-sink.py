#!/usr/bin/env python3
# DESC: Loopback HTTP sink that appends browser-extension link captures to a JSONL file.
"""Receive capture records from the Link Keeper Firefox extension and append them to JSONL.

The extension scrapes pages inside your logged-in session — the only place a bare
`x.com/i/status/123` resolves to an author and a body — and POSTs one JSON object per
capture here. This appends each to a file, one object per line, so the log survives
crashes and can be tailed while you browse.

Bound to loopback only. A shared token is required on every write: any web page you have
open could otherwise POST to this port, and the file it writes to lives in your notebook.
The token is generated on first run, stored beside the output, and printed at startup —
paste it into the extension popup once.

Usage:
    ./link-sink.py                       # writes ./link-captures.jsonl on port 8788
    ./link-sink.py -o /path/to/out.jsonl -p 9000
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 2 * 1024 * 1024  # a scraped tweet is a few KB; this is a sanity bound


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Append browser link captures to a JSONL file.")
    p.add_argument(
        "-o",
        "--out",
        type=Path,
        default=Path.cwd() / "link-captures.jsonl",
        help="JSONL file to append to (default: ./link-captures.jsonl)",
    )
    p.add_argument("-p", "--port", type=int, default=8788, help="port on 127.0.0.1 (default: 8788)")
    p.add_argument(
        "--token-file",
        type=Path,
        help="where the shared token lives (default: <out>.token)",
    )
    return p.parse_args()


def load_token(path: Path) -> str:
    if path.is_file():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    path.write_text(token + "\n", encoding="utf-8")
    path.chmod(0o600)
    return token


class Handler(BaseHTTPRequestHandler):
    server_version = "link-sink/1.0"
    out_path: Path
    token: str

    # --- helpers ---

    def _cors(self) -> None:
        # Loopback-only listener; the token, not the origin, is what authorises a write.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sink-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        pass  # the per-capture line below is the only log worth having

    # --- routes ---

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            count = 0
            if self.out_path.is_file():
                with self.out_path.open(encoding="utf-8") as fh:
                    count = sum(1 for line in fh if line.strip())
            self._json(200, {"ok": True, "out": str(self.out_path), "captures": count})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not self.path.startswith("/capture"):
            self._json(404, {"ok": False, "error": "not found"})
            return

        if self.headers.get("X-Sink-Token", "") != self.token:
            self._json(403, {"ok": False, "error": "bad or missing token"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"ok": False, "error": "bad content-length"})
            return
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"ok": False, "error": "body missing or too large"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._json(400, {"ok": False, "error": f"bad json: {exc}"})
            return

        records = payload if isinstance(payload, list) else [payload]
        written = 0
        with self.out_path.open("a", encoding="utf-8") as fh:
            for record in records:
                if not isinstance(record, dict) or not record.get("url"):
                    continue
                record.setdefault("received_at", datetime.now(timezone.utc).isoformat())
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1
                label = record.get("title") or record.get("text") or record.get("url")
                kind = record.get("kind", "page")
                print(f"  + [{kind}] {str(label)[:88]}", flush=True)

        self._json(200, {"ok": True, "written": written})


def main() -> int:
    args = parse_args()
    out = args.out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    token = load_token(args.token_file or out.with_suffix(out.suffix + ".token"))

    Handler.out_path = out
    Handler.token = token

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # flush=True so the token is visible immediately even when stdout is a pipe or log file.
    print(f"link-sink listening on http://127.0.0.1:{args.port}", flush=True)
    print(f"appending to {out}", flush=True)
    print(f"token: {token}", flush=True)
    print("paste that token into the extension popup once, then leave this running\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
