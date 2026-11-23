#!/usr/bin/env python3
# DESC: Check the sync server: tokens, pushing and pulling in order, resends, compaction into a snapshot.
"""Run: python3 sync-server/test_server.py (standard library, system Python)."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

A, B = "mac-a.secret-a", "mac-b.secret-b"


class SyncServer(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        folder = Path(self.dir.name)
        (folder / "tokens.json").write_text(json.dumps({
            "mac-a": hashlib.sha256(A.encode()).hexdigest(), "mac-b": hashlib.sha256(B.encode()).hexdigest()}))
        self.httpd = server.serve(folder, "127.0.0.1", 0)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.dir.cleanup()

    def call(self, method, path, token=None, body=None):
        req = urllib.request.Request(self.url + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health_needs_no_token(self):
        self.assertEqual(self.call("GET", "/healthz"), (200, {"ok": True}))

    def test_tokens(self):
        self.assertEqual(self.call("GET", "/v1/whoami")[0], 401)
        self.assertEqual(self.call("GET", "/v1/whoami", "mac-a.wrong")[0], 401)
        self.assertEqual(self.call("GET", "/v1/whoami", A)[1]["device"], "mac-a")
        self.assertEqual(self.call("GET", "/v1/whoami", B)[1]["device"], "mac-b")

    def test_push_pull_in_order_and_resend_is_skipped(self):
        self.assertEqual(self.call("POST", "/v1/ops", A, {"batches": [{"id": "a1", "blob": "x1"}, {"id": "a2", "blob": "x2"}]})[1]["seq"], 2)
        self.assertEqual(self.call("POST", "/v1/ops", B, {"batches": [{"id": "b1", "blob": "y1"}]})[1]["seq"], 3)
        again = self.call("POST", "/v1/ops", A, {"batches": [{"id": "a2", "blob": "x2"}]})[1]
        self.assertEqual((again["stored"], again["seq"]), (0, 3))
        got = self.call("GET", "/v1/ops?since=0", B)[1]
        self.assertEqual([(o["seq"], o["device"], o["blob"]) for o in got["ops"]], [(1, "mac-a", "x1"), (2, "mac-a", "x2"), (3, "mac-b", "y1")])
        page = self.call("GET", "/v1/ops?since=1&limit=1", B)[1]
        self.assertEqual(([o["seq"] for o in page["ops"]], page["more"], page["last"]), ([2], True, 3))

    def test_bad_batches_are_refused(self):
        self.assertEqual(self.call("POST", "/v1/ops", A, {"batches": [{"id": "has space", "blob": "x"}]})[0], 400)
        self.assertEqual(self.call("POST", "/v1/ops", A, {"batches": "no"})[0], 400)

    def test_snapshot_compacts_and_a_device_behind_is_told(self):
        self.assertEqual(self.call("GET", "/v1/snapshot", A)[0], 404)
        self.call("POST", "/v1/ops", A, {"batches": [{"id": f"a{i}", "blob": f"x{i}"} for i in range(1, 6)]})
        self.assertEqual(self.call("PUT", "/v1/snapshot", A, {"upto": 9, "blob": "s"})[0], 409)   # past the last batch
        put = self.call("PUT", "/v1/snapshot", A, {"upto": 3, "blob": "state-at-3"})[1]
        self.assertEqual((put["upto"], put["dropped"]), (3, 3))
        snap = self.call("GET", "/v1/snapshot", B)[1]
        self.assertEqual((snap["upto"], snap["device"], snap["blob"]), (3, "mac-a", "state-at-3"))
        code, behind = self.call("GET", "/v1/ops?since=1", B)
        self.assertEqual((code, behind["error"], behind["floor"]), (409, "behind", 3))
        self.assertEqual([o["seq"] for o in self.call("GET", "/v1/ops?since=3", B)[1]["ops"]], [4, 5])
        self.assertEqual(self.call("PUT", "/v1/snapshot", B, {"upto": 2, "blob": "older"})[0], 409)  # older than the one held

    def test_first_snapshot_on_an_empty_server(self):
        self.assertEqual(self.call("PUT", "/v1/snapshot", A, {"upto": 0, "blob": "seed"})[0], 200)
        self.assertEqual(self.call("GET", "/v1/ops?since=0", B)[1]["ops"], [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
