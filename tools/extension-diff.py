#!/usr/bin/env python3
# DESC: Report which captures in the rebuilt JSONL the Firefox extension does not hold yet.
"""Compare the extension's stored captures with the file the refresh last built.

The refresh hands its result over once, on a loopback port, and the extension only has it if its list
page collected it in that window. Nothing on disk records whether that happened. This reads the answer
out of Firefox itself: the add-on's `storage.local` lives in an IndexedDB database in the profile,
which is copied to a temporary directory (so the live one is never opened) and decoded.

Matching uses the extension's own key — x.com posts by status id, everything else by host, path and
query — so a capture counts as held when its key appears anywhere in the stored captures.

The worklist half is checked too: links in `link-unresolved.tsv` are the ones the handoff queues for
the browser, and each should appear in the stored list.

Usage:
    ./extension-diff.py                                  # $DATA_DIR/link-captures-all.jsonl
    ./extension-diff.py path/to/link-captures-all.jsonl
    ./extension-diff.py --all                            # list every missing capture, not just 20

DATA_DIR comes from the environment, else from config.local.sh at this repo's root.

Exit status: 0 when the extension holds everything, 1 when something is missing, 2 when a file or the
extension's storage cannot be read.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
STORE_NAME = "storage-local-data"

# Structured clone words: a tag in the high 32 bits, its datum in the low 32.
TAG_STRING = 0xFFFF0004
TAG_ARRAY = 0xFFFF0007
LATIN1 = 0x80000000


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Report captures the Firefox extension does not hold yet.")
    p.add_argument("captures", nargs="?", type=Path,
                   help="capture JSONL (default: $DATA_DIR/link-captures-all.jsonl)")
    p.add_argument("--id", help="add-on id (default: read from ../extension/manifest.json)")
    p.add_argument("--all", action="store_true", help="list every missing capture")
    return p.parse_args()


def fail(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 2


def tilde(p: Path) -> str:
    s, home = str(p), str(Path.home())
    return "~" + s[len(home):] if s.startswith(home) else s


def stamp(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")


def data_dir() -> Path | None:
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"]).expanduser()
    cfg = REPO / "config.local.sh"
    if not cfg.is_file():
        return None
    out = subprocess.run(["zsh", "-c", 'source "$1" && print -r -- "${DATA_DIR:-}"', "zsh", str(cfg)],
                         capture_output=True, text=True)
    value = out.stdout.strip()
    return Path(value) if out.returncode == 0 and value else None


def load_extension_url():
    spec = importlib.util.spec_from_file_location("extension_url", HERE / "extension-url.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --- the extension's key, mirrored from keyOf() in background.js -----------------------------------

def key_of(url: str) -> str:
    try:
        u = urlsplit(url)
    except ValueError:
        return url
    if not u.scheme or not u.netloc:
        return url
    host = (u.hostname or "").lower().removeprefix("www.")
    parts = u.path.split("/")
    if host in ("x.com", "twitter.com") and "status" in parts:
        i = parts.index("status")
        if i + 1 < len(parts) and parts[i + 1].isdigit():
            return f"status:{parts[i + 1]}"
    path = u.path[:-1] if u.path.endswith("/") else u.path
    return host + path + (f"?{u.query}" if u.query else "")


# --- snappy, raw and framed ------------------------------------------------------------------------

def snappy_raw(buf: bytes) -> bytes:
    pos = n = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            break
    out = bytearray()
    while pos < len(buf):
        tag = buf[pos]
        pos += 1
        kind = tag & 3
        if kind == 0:
            ln = tag >> 2
            if ln >= 60:
                width = ln - 59
                ln = int.from_bytes(buf[pos:pos + width], "little")
                pos += width
            ln += 1
            out += buf[pos:pos + ln]
            pos += ln
            continue
        if kind == 1:
            ln, off = ((tag >> 2) & 7) + 4, ((tag >> 5) << 8) | buf[pos]
            pos += 1
        elif kind == 2:
            ln, off = (tag >> 2) + 1, int.from_bytes(buf[pos:pos + 2], "little")
            pos += 2
        else:
            ln, off = (tag >> 2) + 1, int.from_bytes(buf[pos:pos + 4], "little")
            pos += 4
        start = len(out) - off
        for i in range(ln):  # a copy may overlap its own output
            out.append(out[start + i])
    if len(out) != n:
        raise ValueError(f"snappy: expected {n} bytes, got {len(out)}")
    return bytes(out)


def snappy_framed(buf: bytes) -> bytes:
    pos, out = 0, bytearray()
    while pos < len(buf):
        kind = buf[pos]
        ln = int.from_bytes(buf[pos + 1:pos + 4], "little")
        body = buf[pos + 4:pos + 4 + ln]
        pos += 4 + ln
        if kind == 0x00:
            out += snappy_raw(body[4:])  # the first four bytes are a checksum
        elif kind == 0x01:
            out += body[4:]
    return bytes(out)


# --- structured clone: only the parts JSON-shaped storage uses -------------------------------------

def clone_strings(blob: bytes) -> list[str]:
    """Every string record, read by its length header rather than guessed from the bytes."""
    found, pos = [], 0
    while pos + 8 <= len(blob):
        word = struct.unpack_from("<Q", blob, pos)[0]
        pos += 8
        if word >> 32 != TAG_STRING:
            continue
        datum = word & 0xFFFFFFFF
        length, latin1 = datum & ~LATIN1, bool(datum & LATIN1)
        size = length if latin1 else length * 2
        raw = blob[pos:pos + size]
        found.append(raw.decode("latin1") if latin1 else raw.decode("utf-16le", errors="replace"))
        pos += (size + 7) & ~7
    return found


def clone_array_length(blob: bytes) -> int | None:
    """Length of a top-level array: the word after the clone header."""
    if len(blob) < 16:
        return None
    word = struct.unpack_from("<Q", blob, 8)[0]
    return word & 0xFFFFFFFF if word >> 32 == TAG_ARRAY else None


# --- reading the add-on's storage ------------------------------------------------------------------

def read_storage(profile: Path, uuid: str) -> tuple[dict[str, bytes], dict[str, Path]]:
    """Decoded value per storage.local key, and the file each value was last written to."""
    roots = sorted((profile / "storage" / "default").glob(f"moz-extension+++{uuid}*"))
    dbs = [db for root in roots for db in (root / "idb").glob("*.sqlite")]
    if not dbs:
        raise FileNotFoundError(f"no IndexedDB for moz-extension://{uuid} in {tilde(profile)}")
    with tempfile.TemporaryDirectory() as tmp:
        for db in dbs:
            copy = Path(tmp) / db.name
            for suffix in ("", "-wal", "-shm"):
                src = db.with_name(db.name + suffix)
                if src.exists():
                    shutil.copyfile(src, copy.with_name(copy.name + suffix))
            con = sqlite3.connect(copy)
            try:
                names = {row[0] for row in con.execute("select name from object_store")}
                if STORE_NAME not in names:
                    continue
                values, written = {}, {}
                files = db.with_suffix(".files")
                for key, data, file_ids in con.execute(
                        "select key, data, file_ids from object_data join object_store "
                        "on object_store.id = object_data.object_store_id where object_store.name = ?",
                        (STORE_NAME,)):
                    name = bytes(b - 1 for b in key[1:]).decode("latin1")  # IndexedDB string key
                    ref = next((t[1:] for t in (file_ids or "").split() if t.startswith(".")), None)
                    if ref:
                        path = files / ref
                        raw = path.read_bytes()
                        values[name] = snappy_framed(raw) if raw[:4] == b"\xff\x06\x00\x00" else raw
                        written[name] = path
                    else:
                        values[name] = snappy_raw(data)
                        written[name] = db
                return values, written
            finally:
                con.close()
    raise FileNotFoundError(f"no {STORE_NAME} object store for moz-extension://{uuid}")


# --- the comparison --------------------------------------------------------------------------------

def read_jsonl(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def main() -> int:
    args = parse_args()

    captures_path = args.captures
    if not captures_path:
        d = data_dir()
        if not d:
            return fail("no capture file given, and DATA_DIR is set neither in the environment nor in "
                        "config.local.sh")
        captures_path = d / "link-captures-all.jsonl"
    if not captures_path.is_file():
        return fail(f"no such capture file: {captures_path}")
    outdir = captures_path.parent

    ext_url = load_extension_url()
    ident = ext_url.addon_id(args.id)
    if not ident:
        return fail("could not determine the add-on id")
    install = ext_url.install_for(ident)
    if not install:
        return fail(f"no install of {ident} recorded in any Firefox profile")
    profile, uuid = install

    try:
        values, written = read_storage(profile, uuid)
    except (OSError, sqlite3.Error, ValueError) as exc:
        return fail(f"could not read the extension's storage: {exc}")

    stored = values.get("captures", b"")
    stored_keys = {key_of(s) for s in clone_strings(stored) if s.startswith(("http://", "https://"))}
    listed = values.get("items", b"")
    listed_keys = {key_of(s) for s in clone_strings(listed) if s.startswith(("http://", "https://"))}

    records = read_jsonl(captures_path)
    missing = [r for r in records if key_of(r.get("url") or r.get("source_url") or "") not in stored_keys]
    missing.sort(key=lambda r: r.get("saved_at") or r.get("captured_at") or "", reverse=True)

    print(f"capture file   {tilde(captures_path)}  {len(records)} captures, built {stamp(captures_path)}")
    handoff = outdir / "link-handoff.json"
    if handoff.is_file():
        note = ("  older than the capture file, so the last build was never offered"
                if handoff.stat().st_mtime < captures_path.stat().st_mtime - 60 else "")
        print(f"last handoff   {handoff.name} written {stamp(handoff)}{note}")
    count = clone_array_length(stored)
    held = f"{count} captures" if count is not None else "captures"
    since = f", last stored {stamp(written['captures'])}" if "captures" in written else ""
    print(f"extension      {held}{since}  ({profile.name})")

    print(f"\nmissing        {len(missing)} of {len(records)} captures")
    shown = missing if args.all else missing[:20]
    for r in shown:
        when = (r.get("saved_at") or r.get("captured_at") or "?")[:10]
        print(f"  {when}  {r.get('kind') or '?':<9} {r.get('url') or r.get('source_url')}")
    if len(shown) < len(missing):
        print(f"  … {len(missing) - len(shown)} more (--all)")

    unresolved = outdir / "link-unresolved.tsv"
    queue_missing = 0
    if unresolved.is_file():
        queue = [line.split("\t")[0] for line in unresolved.read_text(encoding="utf-8").splitlines()
                 if line.startswith(("http://", "https://"))]
        queue_missing = sum(1 for u in set(queue) if key_of(u) not in listed_keys)
        print(f"\nworklist       {queue_missing} of {len(set(queue))} unresolved links not in the list")

    return 1 if missing or queue_missing else 0


if __name__ == "__main__":
    sys.exit(main())
