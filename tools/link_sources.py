# DESC: Shared by the safe-to-delete and link-triage pages: read the links of every source, know which ones Link Keeper holds, skip a rebuild when nothing changed.
"""What `build-safe-to-delete-page.py` and `build-link-triage-page.py` have in common.

Four sources feed the import, and both pages show all of them:

  telegram   an "Export chat history" result.json (or Saved Messages)
  instagram  `link-captures-ig.jsonl`: one record per link, with `account`, `thread`, `senders`, `saved_at`
  x          `link-captures-xdm.jsonl`: the X archive's direct messages, same fields
  phone      `link-inbox.tsv`: `URL<TAB>date` lines from the phone's share sheet (and the Saved Messages puller)

This module reads them into one shape, joins links on the same keys the extension uses, asks the
extension what it holds (`tools/link-keeper.mjs links`, live or from the latest backup) and falls back to
the import's own capture file, and keeps the small fingerprint that lets an import skip a page whose
input has not changed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "importers"))
from telegram_export import load_export, split_url  # noqa: E402,F401

SOURCES = [("telegram", "Telegram"), ("instagram", "Instagram"), ("x", "X"), ("phone", "Phone")]
SOURCE_LABEL = dict(SOURCES)

# Default input names inside DATA_DIR, as tools/import-links.zsh writes them.
IG_NAME = "link-captures-ig.jsonl"
X_NAME = "link-captures-xdm.jsonl"
INBOX_NAME = "link-inbox.tsv"
CAPTURES_NAME = "link-captures-all.jsonl"

X_HOSTS = {"x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"}


def data_dir() -> Path:
    """Environment, then config.local.sh at the repo root, else this repo's own data/ —
    the same precedence tools/import-links.zsh and tools/extension-diff.py use."""
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"]).expanduser()
    cfg = REPO / "config.local.sh"
    if cfg.is_file():
        out = subprocess.run(["zsh", "-c", 'source "$1" && print -r -- "${DATA_DIR:-}"', "zsh", str(cfg)],
                             capture_output=True, text=True)
        value = out.stdout.strip()
        if out.returncode == 0 and value:
            return Path(value).expanduser()
    return REPO / "data"


# --- keys ------------------------------------------------------------------------


def match_keys(url: str) -> list:
    """Keys a link and a capture can be joined on, the way the extension joins them.

    A saved `x.com/i/status/123` and the held `x.com/realhandle/status/123` are the same post with
    different paths, so the status id is the only reliable join for those. Everything else joins on the
    URL with scheme, `www.`, trailing slash and fragment normalised away.
    """
    bits = urlsplit(url)
    host = bits.netloc.lower().removeprefix("www.")
    path = bits.path.rstrip("/")
    keys = [f"{host}{path}?{bits.query}" if bits.query else f"{host}{path}"]
    if host in X_HOSTS:
        marker = path.rsplit("/status/", 1)
        if len(marker) == 2 and marker[1].split("/")[0].isdigit():
            keys.append("status:" + marker[1].split("/")[0])
    return keys


def identity(url: str) -> str:
    """One key per link, for putting the same link from two places together: the status id when there is one."""
    return match_keys(url)[-1]


def as_list(value) -> list:
    if value is None or value == "":
        return []
    return list(value) if isinstance(value, list) else [value]


def thread_label(slug: str) -> str:
    """An Instagram thread folder is `name_<number>`; the number says nothing to a reader."""
    return re.sub(r"_\d{6,}$", "", str(slug)) or str(slug)


def digest_of(obj) -> str:
    blob = json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# --- reading the sources ----------------------------------------------------------


def read_jsonl(path: Path | None) -> list:
    """Records of a JSONL file; missing, empty or malformed lines are skipped."""
    if not path or not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def merge_links(rows: list) -> list:
    """One entry per link: origins joined, the earliest date kept, first title and text kept."""
    merged: dict = {}
    for r in rows:
        key = identity(r["url"])
        if key not in merged:
            merged[key] = dict(r, threads=list(r["threads"]), senders=list(r["senders"]), accounts=list(r["accounts"]))
            continue
        m = merged[key]
        for field in ("threads", "senders", "accounts"):
            m[field] += [v for v in r[field] if v not in m[field]]
        if r["date"] and (not m["date"] or r["date"] < m["date"]):
            m["date"] = r["date"]
        for field in ("title", "author", "text"):
            if not m.get(field) and r.get(field):
                m[field] = r[field]
    return list(merged.values())


def read_dm_captures(path: Path | None, source: str) -> list:
    """Instagram's or X's capture records as link rows. Each record is one link, with where it came from."""
    rows = []
    for rec in read_jsonl(path):
        url = rec.get("url")
        if not url:
            continue
        author = rec.get("author") or {}
        rows.append({
            "source": source, "url": url, "date": (rec.get("saved_at") or "")[:10],
            "threads": [thread_label(t) for t in as_list(rec.get("thread"))],
            "senders": [str(s) for s in as_list(rec.get("senders"))],
            "accounts": [str(a) for a in as_list(rec.get("account"))],
            "title": rec.get("title") or "", "author": author.get("handle") or author.get("name") or "",
            "text": rec.get("text") or "", "kind": rec.get("kind") or "",
        })
    return merge_links(rows)


def read_phone_inbox(path: Path | None) -> list:
    """`URL<TAB>date` lines, as the receiver and the Saved Messages puller append them."""
    if not path or not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        parts = line.rstrip("\r").split("\t")
        if not parts or not parts[0].startswith(("http://", "https://")):
            continue
        rows.append({"source": "phone", "url": parts[0].strip(), "date": (parts[1] if len(parts) > 1 else "")[:10],
                     "threads": ["share inbox"], "senders": [], "accounts": [],
                     "title": "", "author": "", "text": "", "kind": ""})
    return merge_links(rows)


def read_telegram(path: Path | None) -> tuple:
    """(chat name, messages) of an export; ("Telegram", []) when there is none."""
    if not path or not path.is_file():
        return "Telegram", []
    data = load_export(path)
    return str(data.get("name") or data.get("type") or "chat"), data.get("messages") or []


class Inputs:
    """The paths a page reads, each defaulting to its place in DATA_DIR when that file exists."""

    def __init__(self, args) -> None:
        base = data_dir()
        self.base = base

        def pick(given, name):
            if given:
                return given
            candidate = base / name
            return candidate if candidate.is_file() else None

        self.telegram = args.export if args.export and args.export.is_file() else None
        self.instagram = pick(args.instagram, IG_NAME)
        self.x = pick(args.x, X_NAME)
        self.inbox = pick(args.inbox, INBOX_NAME)
        self.captures = pick(args.captures, CAPTURES_NAME)


def add_input_arguments(p) -> None:
    p.add_argument("export", nargs="?", type=Path, help="a Telegram export's result.json (optional)")
    p.add_argument("--instagram", type=Path, help=f"Instagram link records (default: $DATA_DIR/{IG_NAME})")
    p.add_argument("--x", type=Path, help=f"X direct-message link records (default: $DATA_DIR/{X_NAME})")
    p.add_argument("--inbox", type=Path, help=f"phone share inbox, URL<TAB>date (default: $DATA_DIR/{INBOX_NAME})")
    p.add_argument("-c", "--captures", type=Path, help=f"the import's capture file (default: $DATA_DIR/{CAPTURES_NAME})")
    p.add_argument("--only-if-changed", action="store_true",
                   help="skip, with one line saying so, when the page's input is the same as at its last build")
    p.add_argument("--fingerprint", type=Path, help="where the input's fingerprint is kept (default: beside the output)")


# --- what Link Keeper holds ---------------------------------------------------------


def link_keeper_command() -> list:
    """`node tools/link-keeper.mjs`, or whatever LINK_KEEPER_CLI says (the tests point it at a stand-in)."""
    custom = os.environ.get("LINK_KEEPER_CLI")
    if custom:
        return shlex.split(custom)
    node = shutil.which("node") or "node"
    return [node, str(REPO / "tools" / "link-keeper.mjs")]


def keys_of_links(links: list) -> set:
    keys: set = set()
    for rec in links:
        for u in (rec.get("url"), rec.get("source_url")):
            if u:
                keys.update(match_keys(u))
        if rec.get("key"):
            keys.add(rec["key"])
    return keys


def held_from_add_on() -> tuple:
    """(keys, where they were read from) as `link-keeper.mjs links` reports them; raises when it cannot."""
    cmd = link_keeper_command() + ["links", "--filter", "all", "--all", "--json"]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"could not run link-keeper: {exc}")
    if done.returncode != 0:
        raise RuntimeError((done.stderr.strip() or done.stdout.strip() or f"exit {done.returncode}").splitlines()[0])
    try:
        links = json.loads(done.stdout)["links"]
    except (json.JSONDecodeError, KeyError, TypeError):
        raise RuntimeError("link-keeper did not answer with a list of links")
    # Firefox closed: the CLI reads the latest backup and says so on stderr: "(from the backup of <time>; ...)".
    said = re.match(r"\(from the (.+?); Firefox", done.stderr.strip())
    return keys_of_links(links), (f"the {said.group(1)}" if said else "the live add-on")


def held_keys(captures: Path | None) -> tuple:
    """(keys, what they came from, why the add-on could not be read or "").

    The add-on's own list when it can be read; else the import's capture file, which holds every link
    the import found, whether or not the extension has taken it in yet.
    """
    reason = ""
    try:
        keys, where = held_from_add_on()
        return keys, where, ""
    except RuntimeError as exc:
        reason = str(exc)
    keys = keys_of_links(read_jsonl(captures))
    where = f"{captures.name}, the import's capture file" if captures else "no capture file"
    return keys, where, reason


# --- skipping a rebuild nobody needs ----------------------------------------------


def code_digest(*files: Path) -> str:
    """The code that draws a page, so that a changed layout rebuilds even when the input has not."""
    h = hashlib.sha256()
    for f in (Path(__file__), *files):
        h.update(f.read_bytes())
    return h.hexdigest()


def fingerprint_path(output: Path, given: Path | None) -> Path:
    return given or output.with_suffix(".fingerprint")


def unchanged(output: Path, fingerprint: Path, digest: str) -> bool:
    try:
        return output.is_file() and fingerprint.read_text(encoding="utf-8").strip() == digest
    except OSError:
        return False


def remember(fingerprint: Path, digest: str) -> None:
    fingerprint.parent.mkdir(parents=True, exist_ok=True)
    fingerprint.write_text(digest + "\n", encoding="utf-8")
