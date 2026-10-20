#!/usr/bin/env python3
# DESC: Check the helper's read-page: Obscura reads local fixture pages with the extension's readers, and refuses walls.
"""Serve a few pages on 127.0.0.1 and read them through native/link-keeper-bridge.py's read_page, which runs
Obscura (tools/agent-browser/install-obscura.zsh) with extension/extractors.js: an article comes back as a
record with its text and links, a "Just a moment..." page and a login redirect come back as walls, and a
port with nothing on it is an error. No network beyond loopback.

    tools/test-agent-browser.py
"""

from __future__ import annotations

import http.server
import importlib.util
import os
import socket
import sys
import threading
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


PAGES = {
    "/article": "<title>A tool worth trying</title><article><h1>A tool worth trying</h1>"
                + "<p>" + "This paragraph explains the tool at some length. " * 12 + "</p>"
                + '<p>Get it at <a href="https://example.com/tool">example.com/tool</a>.</p></article>',
    "/captcha": "<title>Just a moment...</title><p>Checking your browser before accessing the site.</p>",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/old":
            self.send_response(302)
            self.send_header("Location", "/login?next=/old")
            self.end_headers()
            return
        body = PAGES.get(self.path.split("?")[0], "<title>Sign in</title><form><input name=user></form>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


spec = importlib.util.spec_from_file_location("bridge", repo / "native" / "link-keeper-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
if not bridge.OBSCURA.exists():
    sys.exit(f"Obscura is not installed: run {repo}/tools/agent-browser/install-obscura.zsh")

# Obscura refuses private addresses (its SSRF guard); only this test, serving on loopback, allows them.
os.environ["OBSCURA_ALLOW_PRIVATE_NETWORK"] = "1"
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_address[1]}"

res = bridge.read_page(f"{base}/article")
rec = res.get("record") or {}
check("an article comes back as a record", res.get("ok") and rec.get("kind") == "page", str(res)[:300])
check("...with its title and text", rec.get("title") == "A tool worth trying" and "explains the tool" in (rec.get("text") or ""), str(rec)[:300])
check("...and its links", any(l.get("href") == "https://example.com/tool" for l in rec.get("links") or []), str(rec.get("links")))

res = bridge.read_page(f"{base}/captcha")
check("a captcha page is a wall, not a record", not res["ok"] and res.get("wall", {}).get("kind") == "captcha", str(res))

res = bridge.read_page(f"{base}/old")
check("a redirect to a login page is a wall", not res["ok"] and res.get("wall", {}).get("kind") == "login", str(res))

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    dead = s.getsockname()[1]
res = bridge.read_page(f"http://127.0.0.1:{dead}/")
check("a port with nothing on it is an error, not a record", not res["ok"] and "error" in res, str(res))
check("only web pages are read", bridge.read_page("file:///etc/hosts") == {"ok": False, "error": "only web pages"})

server.shutdown()
if failed:
    sys.exit("\nsome checks failed")
print("all passed")
