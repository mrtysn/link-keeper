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
One Firefox profile owns it (.owner.json in it): the profile of the Firefox that started this helper,
read from that Firefox's -profile or -P argument ("default" with neither, as a Dock launch has). A
helper started by any other profile, such as a copy of the owner's profile or another session's test
Firefox with the add-on installed, neither writes nor reads its backups and leaves the socket alone. The folder is claimed by the first
profile to send a backup at least half the size of its latest.json, so a near-empty profile never can.
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
import subprocess
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


# --- which profile owns the backup folder ---------------------------------------------------------

OWNER_FILE = ".owner.json"
FOREIGN = ("another Firefox profile backs up to {folder}, so this one is left out of it: its backups are "
           "not written and the folder's are not read. Give this profile a folder of its own with "
           "LINK_KEEPER_BACKUP_DIR in the environment Firefox starts with, or, if this is now your main "
           "profile, delete {folder}/.owner.json and it takes the folder over")


def firefox_profile(args: str | None = None) -> str:
    """Which profile the Firefox that started this helper runs: its -profile path, its -P name, or
    "default". A copy of a profile is a different folder, so it never passes for the original."""
    if args is None:
        try:
            args = subprocess.run(["ps", "-o", "args=", "-p", str(os.getppid())], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            args = ""
    m = re.search(r"(?:^|\s)--?profile[\s=]+(\S+)", args)
    if m:
        return "path:" + os.path.realpath(m.group(1))
    m = re.search(r"(?:^|\s)-P\s+(\S+)", args)
    return "name:" + m.group(1) if m else "default"


PROFILE = firefox_profile()


def owner() -> str | None:
    folder = backup_dir()
    try:
        return json.loads((folder / OWNER_FILE).read_text()).get("profile") if folder else None
    except (OSError, ValueError):
        return None


def foreign() -> str | None:
    """Why this helper's profile may not use the backup folder, or None when it may."""
    own = owner()
    if own and own != PROFILE:
        return FOREIGN.format(folder=backup_dir())
    return None


def link_count(data: dict) -> int:
    sessions = data.get("sessions") or []
    return sum(len(s.get("tabs") or []) for s in sessions) + len((data.get("storage") or {}).get("items") or [])


def claim_or_refuse(folder: Path, data: dict) -> str | None:
    """With no owner yet: a backup at least half the size of latest.json is written, and claims the
    folder for its profile when it names one; a smaller one is refused."""
    if owner():
        return None
    try:
        before = link_count(json.loads((folder / "latest.json").read_text()))
    except (OSError, ValueError):
        before = 0
    now = link_count(data)
    if now * 2 < before:
        return (f"not written: this backup holds {now} links and {folder}/latest.json {before}, so it is "
                "probably another Firefox profile's; give that profile a folder of its own with LINK_KEEPER_BACKUP_DIR")
    write_atomic(folder / OWNER_FILE, json.dumps({"profile": PROFILE, "since": dt.datetime.now().isoformat(timespec="seconds")}))
    return None


def write_backup(data: dict, reason: str) -> dict:
    folder = backup_dir()
    if not folder:
        return {"ok": False, "error": "no backup folder: set LINK_KEEPER_BACKUP_DIR in config.local.sh"}
    if foreign():
        return {"ok": False, "error": foreign()}
    folder.mkdir(parents=True, exist_ok=True)
    if reason != "pre-restore":
        refused = claim_or_refuse(folder, data)
        if refused:
            return {"ok": False, "error": refused}
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
    if foreign():
        return {"ok": False, "error": foreign()}
    folder = backup_dir()
    if not folder or not folder.exists():
        return {"ok": True, "folder": str(folder) if folder else None, "backups": []}
    files = [p for p in folder.glob("*.json") if not p.name.startswith(".")]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return {"ok": True, "folder": str(folder), "backups": [
        {"name": p.name, "bytes": p.stat().st_size,
         "modified": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")} for p in files]}


def read_backup(name: str) -> dict:
    if foreign():
        return {"ok": False, "error": foreign()}
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


# --- refresh -------------------------------------------------------------------------------------
# Links' "Refresh from exports" button: tools/refresh.zsh, run detached so it outlives this helper, with
# the PATH an app started outside a shell lacks (asdf's shims, Homebrew). Only that script runs, and
# --offline is the one choice the page makes. Its output goes to the log the Link Refresh app used;
# each run starts with a "--- refresh" line and ends with "--- exit <code>".
REFRESH_LOG = Path.home() / "Library/Logs/link-refresh.log"


def refresh_pid_file() -> Path:
    return state_dir() / "refresh.json"


# The run this helper started: it must be reaped (poll) or it lingers as a zombie that kill(pid, 0)
# still finds, and the button would wait forever. A run from an earlier helper is not our child, so
# for that one kill(pid, 0) is the test.
_refresh_proc = None


def refresh_running() -> dict | None:
    try:
        run = json.loads(refresh_pid_file().read_text())
        pid = int(run["pid"])
        if _refresh_proc is not None and _refresh_proc.pid == pid:
            return run if _refresh_proc.poll() is None else None
        os.kill(pid, 0)
        return run
    except (OSError, ValueError, KeyError):
        return None


def refresh_start(offline: bool) -> dict:
    global _refresh_proc
    if refresh_running():
        return {"ok": False, "error": "a refresh is already running"}
    script = REPO / "tools" / "refresh.zsh"
    if not script.exists():
        return {"ok": False, "error": f"no refresh script at {script}"}
    REFRESH_LOG.parent.mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now().isoformat(timespec="seconds")
    flags = "--no-open" + (" --offline" if offline else "")
    with REFRESH_LOG.open("a") as log:
        log.write(f"--- refresh {started}{' (offline)' if offline else ''}\n")
    env = dict(os.environ, PATH=f"{Path.home()}/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    proc = subprocess.Popen(
        ["/bin/zsh", "-c", f'"$0" {flags}; print -- "--- exit $?"', str(script)],
        stdin=subprocess.DEVNULL, stdout=REFRESH_LOG.open("a"), stderr=subprocess.STDOUT,
        cwd=str(REPO), env=env, start_new_session=True)
    _refresh_proc = proc
    refresh_pid_file().parent.mkdir(parents=True, exist_ok=True)
    refresh_pid_file().write_text(json.dumps({"pid": proc.pid, "started": started, "offline": offline}))
    return {"ok": True, "pid": proc.pid, "started": started}


def refresh_status() -> dict:
    """Whether a refresh runs, and the last run's lines so far (its exit code once it ended)."""
    run = refresh_running()
    lines: list = []
    if REFRESH_LOG.exists():
        text = REFRESH_LOG.read_text(errors="replace").splitlines()[-400:]
        start = max((i for i, l in enumerate(text) if l.startswith("--- refresh ")), default=None)
        lines = text[start:] if start is not None else []
    code = next((l[len("--- exit "):] for l in reversed(lines) if l.startswith("--- exit ")), None)
    return {"ok": True, "running": bool(run), "started": run["started"] if run else None,
            "lines": lines[-40:], "exit": int(code) if code and code.isdigit() else None}


HOST_OPS = {
    "backup": lambda m: write_backup(m.get("data") or {}, m.get("reason") or "change"),
    "list-backups": lambda m: list_backups(),
    "read-backup": lambda m: read_backup(m.get("name") or ""),
    "journal-push": lambda m: journal_push(m.get("entry") or {}),
    "journal-last": lambda m: journal_last(),
    "journal-list": lambda m: journal_list(),
    "journal-drop": lambda m: journal_drop(m.get("entry_id") or ""),
    "refresh-start": lambda m: refresh_start(bool(m.get("offline"))),
    "refresh-status": lambda m: refresh_status(),
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


def bind_socket(path: Path) -> socket.socket:
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
    server.settimeout(SOCK_CHECK_S)
    return server


def serve_socket(path: Path) -> None:
    """Serves the shell's requests for as long as Firefox runs this helper. A socket file that goes
    missing meanwhile (a second helper that started and quit takes its own with it, or a cleanup of
    the state folder) is made again, so `link-keeper` never falls back to a stale backup while
    Firefox is open. One another helper has put in its place is left to that helper."""
    server = bind_socket(path)
    while True:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            if not (path.exists() or path.is_symlink()):
                server.close()
                server = bind_socket(path)
            continue
        conn.settimeout(None)
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


SOCK_CHECK_S = 5


def main() -> None:
    sock = state_dir() / "bridge.sock"
    serving = False
    try:
        while True:
            m = read_frame()
            if m is None:
                break
            kind = m.get("type")
            if kind == "hello":
                hello.update({k: m[k] for k in ("version",) if k in m})
                folder = backup_dir()
                # The shell's socket reaches the profile that owns the backups, never another one.
                if not serving and not foreign():
                    threading.Thread(target=serve_socket, args=(sock,), daemon=True).start()
                    serving = True
                send({"type": "hello", "backup_folder": str(folder) if folder else None,
                      "error": foreign() or (None if folder else "no backup folder: set LINK_KEEPER_BACKUP_DIR in config.local.sh")})
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
            if serving and sock.exists() and os.stat(sock).st_ino == SOCK_INODE.get("ino"):
                sock.unlink()
        except OSError:
            pass

if __name__ == "__main__":
    main()
