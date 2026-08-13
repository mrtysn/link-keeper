#!/usr/bin/env python3
# DESC: Serve one file on loopback until the extension has fetched it once, then exit.
"""Hand a file to the extension without a file dialog.

An extension cannot read a path on disk, and a browser-action popup cannot own a file picker — it
closes the moment the OS dialog opens and takes its JavaScript with it. What an extension *can* do is
fetch a URL. So the refresh puts the file behind a loopback URL and the list page pulls it in by
itself.

This is not a daemon. It answers one successful GET and exits, or gives up after a timeout, so there
is nothing to remember to shut down. Bound to 127.0.0.1, so nothing off this machine can reach it.

Usage:
    ./serve-once.py link-captures-all.jsonl --port 8790 --timeout 900
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Serve one file on loopback, then exit.")
    p.add_argument("file", type=Path, help="the file to serve")
    p.add_argument("-p", "--port", type=int, default=8790)
    p.add_argument("-t", "--timeout", type=int, default=900, help="give up after this many seconds")
    p.add_argument("--quiet", action="store_true", help="say nothing unless something goes wrong")
    return p.parse_args()


class Handler(BaseHTTPRequestHandler):
    server_version = "link-keeper-serve-once/1.0"
    payload: bytes
    name: str
    quiet: bool
    served = threading.Event()

    def _cors(self) -> None:
        # The reader is a moz-extension page, whose origin is opaque; loopback is the boundary here.
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.lstrip("/") not in (self.name, ""):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Content-Length", str(len(self.payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(self.payload)
        if not self.quiet:
            print(f"  served {len(self.payload):,} bytes at {datetime.now():%H:%M:%S}", flush=True)
        Handler.served.set()

    def log_message(self, fmt: str, *args) -> None:
        pass


def main() -> int:
    args = parse_args()
    if not args.file.is_file():
        print(f"no such file: {args.file}", file=sys.stderr)
        return 1

    Handler.payload = args.file.read_bytes()
    Handler.name = args.file.name
    Handler.quiet = args.quiet

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        # Almost always a previous run still waiting; that one will serve the older file, so say so.
        print(f"port {args.port} is busy ({exc}). An earlier serve-once may still be waiting.",
              file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{args.port}/{args.file.name}"
    if not args.quiet:
        print(f"  waiting on {url}")
        print(f"  exits after the extension fetches it, or in {args.timeout // 60} min")

    threading.Thread(target=server.serve_forever, daemon=True).start()
    if not Handler.served.wait(timeout=args.timeout) and not args.quiet:
        print("  nobody fetched it; exiting", flush=True)
    server.shutdown()
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
