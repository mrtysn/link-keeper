#!/usr/bin/env python3
# DESC: Check the open-local-files helper's framing and refusals, without opening anything.
#
# Runs native/open-local-files.py in dry-run mode with native-messaging framed input and checks
# that only file: URLs naming existing files get through.
#
# Usage: tools/test-open-local-files.py

import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

if "-h" in sys.argv or "--help" in sys.argv:
    print(__doc__ or open(__file__).read().split("\n\n")[0])
    sys.exit(0)

helper = Path(__file__).resolve().parent.parent / "native" / "open-local-files.py"


def call(msg):
    body = json.dumps(msg).encode()
    out = subprocess.run(["/usr/bin/python3", str(helper)], input=struct.pack("@I", len(body)) + body,
                         capture_output=True, env={**os.environ, "LINK_KEEPER_OPEN_DRY_RUN": "1"}, check=True).stdout
    (n,) = struct.unpack("@I", out[:4])
    return json.loads(out[4:4 + n])


with tempfile.TemporaryDirectory() as d:
    real = Path(d) / "report with space.html"
    real.write_text("<h1>x</h1>")
    real_url = real.as_uri()

    r = call({"open": [real_url, "https://example.com/", "file:///no/such/file.html",
                       "file://otherhost/share/x.html", 42]})
    assert r["ok"], r
    assert r["opened"] == [real_url], r
    assert r["dry_run"][:3] == ["open", "-g", "-a"] and r["dry_run"][4:] == [real_url], r
    reasons = {f["url"]: f["error"] for f in r["failed"]}
    assert reasons["https://example.com/"] == "not a local file: URL", reasons
    assert reasons["file:///no/such/file.html"] == "file no longer exists", reasons
    assert reasons["file://otherhost/share/x.html"] == "not a local file: URL", reasons
    print("ok   only existing local files get through; the rest are refused with a reason")

    r = call({"run": "rm -rf /"})
    assert r == {"ok": False, "error": 'expected {"open": [urls]}'}, r
    print("ok   anything but an open request is refused")

    r = call({"open": ["https://example.com/"]})
    assert r["ok"] and not r["opened"] and "dry_run" not in r, r
    print("ok   nothing to open means no command at all")

print("3 checks passed")
