#!/usr/bin/env python3
# DESC: Download a version AMO already signed, when web-ext sign gave up waiting for approval.
"""Fetch the signed .xpi of a version already submitted to AMO.

`web-ext sign` submits, then polls for approval; if approval outlasts its wait it exits without a file,
and running it again fails with "This upload has already been submitted". The version is not lost —
this asks AMO's API for it and saves the signed file where web-ext would have.

Needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET in the environment, so run it under Doppler:

    doppler run --project firefox-signing --config prd -- tools/fetch-signed-xpi.py
    ... -- tools/fetch-signed-xpi.py --version 5.6

The add-on id and, by default, the version come from extension/manifest.json.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent / "extension"


def b64(raw: bytes) -> bytes:
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def jwt(key: str, secret: str) -> str:
    now = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps({"iss": key, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}).encode())
    sig = b64(hmac.new(secret.encode(), head + b"." + body, hashlib.sha256).digest())
    return (head + b"." + body + b"." + sig).decode()


def main() -> int:
    manifest = json.loads((EXT / "manifest.json").read_text())
    p = argparse.ArgumentParser(description="Download a version AMO already signed.")
    p.add_argument("--version", default=manifest["version"], help="default: the manifest's version")
    args = p.parse_args()

    key, secret = os.environ.get("WEB_EXT_API_KEY"), os.environ.get("WEB_EXT_API_SECRET")
    if not key or not secret:
        print("WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set; run under doppler", file=sys.stderr)
        return 2
    addon = manifest["browser_specific_settings"]["gecko"]["id"]

    def get(url: str):
        return urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"JWT {jwt(key, secret)}"}))

    info = json.load(get(f"https://addons.mozilla.org/api/v5/addons/addon/{addon}/versions/v{args.version}/"))
    file = info.get("file") or {}
    if file.get("status") != "public" or not file.get("url"):
        print(f"{args.version}: not signed yet (status {file.get('status')}); try again shortly", file=sys.stderr)
        return 1
    out = EXT / "web-ext-artifacts" / file["url"].rsplit("/", 1)[-1]
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(get(file["url"]).read())
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
