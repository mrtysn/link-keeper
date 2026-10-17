"""Serve the saved pages for test-extractors.zsh: x.com status pages, a GitHub repo, and plain pages.

/somehandle/status/<id> serves the page PAGES names for that id, whatever the handle: ...081 x-status.html,
...082 x-status-virtual.html, ...083 x-status-discover.html, ...084 x-status-virtual-discover.html; OTHER names the GitHub page and the plain pages
(a Wikipedia-shaped article, a blog post, a docs page) by path.
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
OTHER = {
    "/slopus/happy-cli": "github-repo.html",
    "/wiki/Suspension_bridge": "generic-wiki.html",
    "/blog/rewrote-build": "generic-blog.html",
    "/docs/getting-started": "generic-docs.html",
    # The reel, reached directly and from the reels feed, and a different reel's address over the same
    # page, as when Instagram has swapped the post but not yet its tags.
    "/reel/DedGyALCUWi/": "instagram-reel.html",
    "/reels/DedGyALCUWi/": "instagram-reel.html",
    "/reel/SomeOtherReel/": "instagram-reel.html",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r"^/[^/]+/status/(\d+)", self.path)
        page = PAGES.get(m.group(1)) if m else OTHER.get(self.path)
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
