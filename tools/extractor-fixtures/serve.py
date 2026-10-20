"""Serve the saved pages for test-extractors.zsh: x.com status pages, a GitHub repo, and plain pages.

/somehandle/status/<id> serves the page PAGES names for that id, whatever the handle: ...081 x-status.html,
...082 x-status-virtual.html, ...083 x-status-discover.html, ...084 x-status-virtual-discover.html; OTHER names the GitHub page and the plain pages
(a Wikipedia-shaped article, a blog post, a docs page) by path. Walls for the capture queue: /reel/Walled/
redirects to an Instagram-shaped login page under /accounts/login/, and /cdn-cgi/challenge is a Cloudflare one.
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
    "/cdn-cgi/challenge": "cloudflare-challenge.html",
    "/accounts/login/": "login-page.html",
    # An app that draws its text 1.5 s after load.
    "/app/late": "app-late.html",
    # A listing with no paragraphs, as an app or a store front draws itself.
    "/app/listing": "app-listing.html",
    # A page that holds its main thread for 15 s after load, so a read of it gets no answer.
    "/app/busy": "app-busy.html",
    # Hacker News's rate-limit page, as it answers once requests come too fast.
    "/hn/item": "hn-rate-limit.html",
    # Reddit as old Reddit and new Reddit draw a post, and old Reddit a subreddit.
    "/r/godot/comments/1su9f83/how_would_i_achieve_this_in_godot_cant_wrap_my/": "reddit-old-post.html",
    "/r/slopsmith/": "reddit-old-listing.html",
    "/r/firefox/comments/1s3t2iu/x/": "reddit-new-post.html",
    # A YouTube search with its results only in the page's data.
    "/results": "youtube-results.html",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/reel/Walled/":
            self.send_response(302)
            self.send_header("Location", "/accounts/login/?next=%2Freel%2FWalled%2F")
            self.end_headers()
            return
        if self.path.startswith("/accounts/login/?"):
            self.path = "/accounts/login/"
        m = re.match(r"^/[^/]+/status/(\d+)", self.path)
        page = PAGES.get(m.group(1)) if m else OTHER.get(self.path.split("?")[0])
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
