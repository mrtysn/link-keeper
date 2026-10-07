#!/usr/bin/python3
# DESC: Firefox native-messaging helper: back Link Keeper's storage up to disk, and let local agents reach the live extension.
"""Link Keeper's bridge to the machine.

Firefox starts this when the extension connects (runtime.connectNative), and stops it when the
extension goes. While it runs it does two jobs:

  Backups  — the extension sends its whole storage and its stashes after changes; they are written
             to latest.json in the backup folder, plus backup-YYYY-MM-DD.json the first time each
             day (30 days kept), plus pre-restore-<time>.json before a restore (5 kept).
  Agents   — a Unix socket, readable by this user only, where tools/link-keeper.mjs sends one JSON
             request per connection: {"cmd": ..., "args": {...}}. The request goes to the extension,
             and its answer comes back on the same connection as one JSON line.

The backup folder is LINK_KEEPER_BACKUP_DIR, from the environment or the repo's config.local.sh.
The socket is $LINK_KEEPER_STATE_DIR/bridge.sock, by default ~/.local/state/link-keeper/.

Firefox caps a message to the extension at 1 MB, so a bigger one goes as chunks of CHUNK
characters: {"type": "chunk", "id", "part", "of", "data"}, joined and parsed on the other side.

/usr/bin/python3 on purpose: Firefox starts helpers with launchd's bare PATH. Python 3.9 syntax.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import socket
import struct
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHUNK = 800_000
KEEP_DAYS = 30
KEEP_PRE_RESTORE = 5
KEEP_UNDO = 30
REQUEST_TIMEOUT = 120


def config_value(name: str) -> str | None:
    """The environment's value, else config.local.sh's (NAME=value lines, $HOME expanded)."""
    if os.environ.get(name):
        return os.environ[name]
    conf = REPO / "config.local.sh"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        m = re.match(rf"^\s*(?:export\s+)?{name}=(.*)$", line)
        if m:
            value = m.group(1).strip().strip("\"'")
            return os.path.expandvars(os.path.expanduser(value)) or None
    return None


def state_dir() -> Path:
    return Path(config_value("LINK_KEEPER_STATE_DIR") or Path.home() / ".local/state/link-keeper")


def backup_dir() -> Path | None:
    value = config_value("LINK_KEEPER_BACKUP_DIR")
    return Path(value) if value else None


# --- talking to the extension -------------------------------------------------------------------

out_lock = threading.Lock()


def send(obj: dict) -> None:
    body = json.dumps(obj, ensure_ascii=False)
    if len(body.encode()) > CHUNK:
        cid = f"c{time.time_ns()}"
        # A character takes at most 6 bytes once escaped in the frame (\uXXXX), so CHUNK // 6 of
        # them always fit under CHUNK bytes.
        step = CHUNK // 6
        parts = [body[i:i + step] for i in range(0, len(body), step)]
        with out_lock:
            for n, part in enumerate(parts):
                write_frame(json.dumps({"type": "chunk", "id": cid, "part": n, "of": len(parts), "data": part}, ensure_ascii=False))
        return
    with out_lock:
        write_frame(body)


def write_frame(body: str) -> None:
    raw = body.encode()
    sys.stdout.buffer.write(struct.pack("@I", len(raw)) + raw)
    sys.stdout.buffer.flush()


def read_frame() -> dict | None:
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    return json.loads(sys.stdin.buffer.read(length))


# --- backups ------------------------------------------------------------------------------------

def write_atomic(path: Path, body: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(body)
    os.replace(tmp, path)


def write_backup(data: dict, reason: str) -> dict:
    folder = backup_dir()
    if not folder:
        return {"ok": False, "error": "no backup folder: set LINK_KEEPER_BACKUP_DIR in config.local.sh"}
    folder.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False)
    now = dt.datetime.now()
    if reason == "pre-restore":
        name = f"pre-restore-{now:%Y-%m-%d-%H%M%S}.json"
        write_atomic(folder / name, body)
        for old in sorted(folder.glob("pre-restore-*.json"))[:-KEEP_PRE_RESTORE]:
            old.unlink()
        return {"ok": True, "file": str(folder / name), "bytes": len(body)}
    write_atomic(folder / "latest.json", body)
    daily = folder / f"backup-{now:%Y-%m-%d}.json"
    if not daily.exists():
        write_atomic(daily, body)
    cutoff = f"backup-{now - dt.timedelta(days=KEEP_DAYS):%Y-%m-%d}.json"
    for old in folder.glob("backup-*.json"):
        if old.name < cutoff:
            old.unlink()
    return {"ok": True, "file": str(folder / "latest.json"), "bytes": len(body), "at": now.isoformat(timespec="seconds")}


def list_backups() -> dict:
    folder = backup_dir()
    if not folder or not folder.exists():
        return {"ok": True, "folder": str(folder) if folder else None, "backups": []}
    files = [p for p in folder.glob("*.json") if not p.name.startswith(".")]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return {"ok": True, "folder": str(folder), "backups": [
        {"name": p.name, "bytes": p.stat().st_size,
         "modified": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")} for p in files]}


def read_backup(name: str) -> dict:
    folder = backup_dir()
    if not folder:
        return {"ok": False, "error": "no backup folder is set"}
    # A bare file name in the backup folder, nothing else.
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.json", name or "") or name.startswith("."):
        return {"ok": False, "error": f"not a backup name: {name!r}"}
    path = folder / name
    if not path.exists():
        return {"ok": False, "error": f"no {name} in {folder}"}
    return {"ok": True, "name": name, "data": json.loads(path.read_text())}


# --- undo journal: what an agent's change replaced, newest last ----------------------------------

def undo_dir() -> Path:
    d = state_dir() / "undo"
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def journal_push(entry: dict) -> dict:
    name = f"{time.time_ns()}.json"
    write_atomic(undo_dir() / name, json.dumps(entry, ensure_ascii=False))
    for old in sorted(undo_dir().glob("*.json"))[:-KEEP_UNDO]:
        old.unlink()
    return {"ok": True, "id": name}


def journal_last() -> dict:
    files = sorted(undo_dir().glob("*.json"))
    if not files:
        return {"ok": False, "error": "no agent change to undo"}
    return {"ok": True, "id": files[-1].name, "entry": json.loads(files[-1].read_text())}


def journal_list() -> dict:
    entries = []
    for p in sorted(undo_dir().glob("*.json"), reverse=True):
        e = json.loads(p.read_text())
        entries.append({"id": p.name, "at": e.get("at"), "cmd": e.get("cmd"), "summary": e.get("summary")})
    return {"ok": True, "entries": entries}


def journal_drop(entry_id: str) -> dict:
    if not re.fullmatch(r"\d+\.json", entry_id or ""):
        return {"ok": False, "error": "not a journal id"}
    (undo_dir() / entry_id).unlink(missing_ok=True)
    return {"ok": True}


HOST_OPS = {
    "backup": lambda m: write_backup(m.get("data") or {}, m.get("reason") or "change"),
    "list-backups": lambda m: list_backups(),
    "read-backup": lambda m: read_backup(m.get("name") or ""),
    "journal-push": lambda m: journal_push(m.get("entry") or {}),
    "journal-last": lambda m: journal_last(),
    "journal-list": lambda m: journal_list(),
    "journal-drop": lambda m: journal_drop(m.get("entry_id") or ""),
}


def host_op(m: dict) -> None:
    try:
        result = HOST_OPS[m["op"]](m) if m.get("op") in HOST_OPS else {"ok": False, "error": f"unknown op {m.get('op')}"}
    except Exception as e:  # reported to the extension, which shows it
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    send({"type": "host-reply", "id": m.get("id"), "result": result})


# --- the agents' socket ---------------------------------------------------------------------------

waiting: dict[str, dict] = {}
waiting_lock = threading.Lock()
started = dt.datetime.now().isoformat(timespec="seconds")
hello: dict = {}
SOCK_INODE: dict = {}


def serve_client(conn: socket.socket) -> None:
    with conn:
        conn.settimeout(REQUEST_TIMEOUT)
        raw = b""
        while not raw.endswith(b"\n"):
            got = conn.recv(65536)
            if not got:
                break
            raw += got
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            conn.sendall(b'{"ok": false, "error": "send one JSON object and a newline"}\n')
            return
        if req.get("cmd") == "bridge-status":
            folder = backup_dir()
            result = {"ok": True, "live": True, "since": started, "extension": hello,
                      "backup_folder": str(folder) if folder else None}
        else:
            rid = f"r{time.time_ns()}"
            slot = {"event": threading.Event(), "result": None}
            with waiting_lock:
                waiting[rid] = slot
            send({"type": "request", "id": rid, "cmd": req.get("cmd"), "args": req.get("args") or {}})
            if slot["event"].wait(REQUEST_TIMEOUT):
                result = slot["result"]
            else:
                result = {"ok": False, "error": f"the extension did not answer within {REQUEST_TIMEOUT}s"}
            with waiting_lock:
                waiting.pop(rid, None)
        conn.sendall(json.dumps(result, ensure_ascii=False).encode() + b"\n")


def serve_socket(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    if path.exists() or path.is_symlink():
        path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        server.bind(str(path))
    finally:
        os.umask(old)
    SOCK_INODE["ino"] = os.stat(path).st_ino
    server.listen(8)
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


def main() -> None:
    sock = state_dir() / "bridge.sock"
    threading.Thread(target=serve_socket, args=(sock,), daemon=True).start()
    try:
        while True:
            m = read_frame()
            if m is None:
                break
            kind = m.get("type")
            if kind == "hello":
                hello.update({k: m[k] for k in ("version",) if k in m})
                folder = backup_dir()
                send({"type": "hello", "backup_folder": str(folder) if folder else None,
                      "error": None if folder else "no backup folder: set LINK_KEEPER_BACKUP_DIR in config.local.sh"})
            elif kind == "host":
                threading.Thread(target=host_op, args=(m,), daemon=True).start()
            elif kind == "reply":
                with waiting_lock:
                    slot = waiting.get(m.get("id"))
                if slot:
                    slot["result"] = m.get("result")
                    slot["event"].set()
    finally:
        # Only our own socket: another Firefox's bridge may have replaced it since.
        try:
            if sock.exists() and os.stat(sock).st_ino == SOCK_INODE.get("ino"):
                sock.unlink()
        except OSError:
            pass

if __name__ == "__main__":
    main()
