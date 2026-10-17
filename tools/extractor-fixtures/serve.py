"""Serve the saved x.com status pages and GitHub repo page for test-extractors.zsh.

/somehandle/status/<id> serves the page PAGES names for that id, whatever the handle: ...081 x-status.html,
...082 x-status-virtual.html, ...083 x-status-discover.html, ...084 x-status-virtual-discover.html; /slopus/happy-cli serves github-repo.html.
Usage: serve.py <port>
"""
import http.server
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
PAGES = {
    "2009295329057702081": "x-status.html",
    "2009295329057702082": "x-status-virtual.html",
    "2009295329057702083": "x-status-discover.html",
    "2009295329057702084": "x-status-virtual-discover.html",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r"^/[^/]+/status/(\d+)", self.path)
        page = PAGES.get(m.group(1)) if m else "github-repo.html" if self.path == "/slopus/happy-cli" else None
        if not page:
            self.send_error(404)
            return
        body = (HERE / page).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
