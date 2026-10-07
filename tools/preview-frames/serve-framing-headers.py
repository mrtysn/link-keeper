"""Serve pages that forbid framing, for test-preview-frames.zsh.

/plain   no framing headers
/xfo     X-Frame-Options: DENY
/csp     Content-Security-Policy with frame-ancestors 'none'
/outer   an ordinary web page that frames /xfo, and says in its title whether that loaded

A framed page posts "framed:<path>" to its parent once it runs.
Usage: serve-framing-headers.py <port>
"""
import http.server
import sys


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/outer":
            body = (b'<!doctype html><title>outer</title><iframe src="/xfo"></iframe><script>'
                    b'addEventListener("message", e => { document.title = e.data; });</script>')
        else:
            body = b'<!doctype html><title>x</title><script>parent.postMessage("framed:" + location.pathname, "*")</script>ok'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        if path == "/xfo":
            self.send_header("X-Frame-Options", "DENY")
        if path == "/csp":
            self.send_header("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
