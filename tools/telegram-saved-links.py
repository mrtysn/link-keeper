#!/usr/bin/env python3
# DESC: Turn a Telegram "Export chat history" result.json into a swipe-to-triage HTML page for its saved links.
"""Extract every link from a Telegram Desktop JSON chat export and build a review page.

The page is a Tinder-style card stack: one link per card, swipe right to keep, left to
drop, up to defer. Decisions live in localStorage for responsiveness and are exported to
a sidecar JSON that this script reads back on the next run, so a re-export does not throw
away triage work. Links already decided never re-enter the queue.

Two wrinkles in Telegram's export that this handles explicitly (see `importers/telegram_export.py`):

  * `.sh`, `.py`, `.so` and `.io` are real TLDs, so filenames pasted inside code snippets
    (`deploy.sh`, `server.py`) get entity-tagged as links. Anything without an http(s)
    scheme is listed separately instead of entering the triage queue — some are genuine
    sites typed without a scheme, some are filenames, and the difference is not
    mechanically decidable.
  * Link-preview metadata (title, author, description) is fetched by Telegram at send
    time and is NOT in the export. A bare `x.com/i/status/123` stays bare. The only
    context available is whatever text accompanied the link in the message, plus
    whatever Link Keeper's own captures carry, if `-c` finds one for the same link.

Queue order is by ascending domain frequency: the identifiable long tail comes first,
and the large single-domain runs land at the end where the bulk-decide action pays off.

Usage:
    ./telegram-saved-links.py <result.json> [-o out.html] [-t triage.json]

Output and the triage sidecar default into DATA_DIR (this repo's data/, or wherever
config.local.sh points it) rather than the current directory — see README.md.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "importers"))
from telegram_export import extract_links  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TRIAGE_DEFAULT = "telegram-links-triage.json"
CAPTURES_DEFAULT = "link-captures-all.jsonl"


def data_dir() -> Path:
    """Environment, then config.local.sh at the repo root, else this repo's own data/ —
    the same precedence tools/refresh.zsh and tools/extension-diff.py use."""
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


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build a swipe-to-triage HTML page from a Telegram JSON chat export.",
        epilog="Export from Telegram Desktop: chat menu -> Export chat history, "
        "format 'Machine-readable JSON', media unchecked.",
    )
    p.add_argument("export", type=Path, help="path to the export's result.json")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        help="output HTML path (default: $DATA_DIR/YYYY-MM-DD-telegram-saved-links.html)",
    )
    p.add_argument(
        "-t",
        "--triage",
        type=Path,
        help=f"triage state to preload, as saved from the page (default: $DATA_DIR/{TRIAGE_DEFAULT} if it exists)",
    )
    p.add_argument(
        "--urls",
        action="store_true",
        help="print 'URL<TAB>date' newest-first for pasting into the Link Keeper extension, and exit",
    )
    p.add_argument(
        "-c",
        "--captures",
        type=Path,
        help=f"Link Keeper capture JSONL (default: $DATA_DIR/{CAPTURES_DEFAULT} if it exists)",
    )
    return p.parse_args()


# --- extraction ----------------------------------------------------------------


def collect(export_path: Path) -> tuple[list[dict], list[dict], dict]:
    """Link entities from the export, in the short-key shape this page embeds."""
    linked, schemeless, stats = extract_links(export_path)
    shrink = lambda records: [
        {"u": r["url"], "h": r["host"], "p": r["tail"], "d": r["date"], "c": r["context"]} for r in records
    ]
    return shrink(linked), shrink(schemeless), stats


def group_by_host(records: list[dict]) -> list[tuple[str, list[dict]]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        groups[record["h"]].append(record)
    for items in groups.values():
        items.sort(key=lambda r: r["d"], reverse=True)
    return sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))


def queue_order(records: list[dict]) -> list[dict]:
    """Rarest domains first, so bulk-decide handles the big runs at the end."""
    counts = Counter(r["h"] for r in records)
    return sorted(records, key=lambda r: (counts[r["h"]], r["h"], r["d"]))


def match_keys(url: str) -> list[str]:
    """Keys a link and a capture can be joined on.

    A saved `x.com/i/status/123` and the captured `x.com/realhandle/status/123` are the
    same post with different paths, so the status id is the only reliable join for those.
    Everything else joins on the URL with scheme, `www.`, trailing slash and fragment
    normalised away.
    """
    keys = []
    bits = urlsplit(url)
    host = bits.netloc.lower().removeprefix("www.")
    path = bits.path.rstrip("/")
    keys.append(f"{host}{path}?{bits.query}" if bits.query else f"{host}{path}")
    if host in {"x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"}:
        marker = path.rsplit("/status/", 1)
        if len(marker) == 2 and marker[1].split("/")[0].isdigit():
            keys.append("status:" + marker[1].split("/")[0])
    return keys


def load_captures(path: Path | None) -> dict[str, dict]:
    """Index Link Keeper captures by every key they could be joined on. Last write wins."""
    candidate = path or data_dir() / CAPTURES_DEFAULT
    if not candidate.is_file():
        return {}

    index: dict[str, dict] = {}
    with candidate.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                print(f"skipping malformed capture on line {lineno}", file=sys.stderr)
                continue
            if not isinstance(record, dict) or not record.get("url"):
                continue
            keys = match_keys(record["url"])
            if record.get("status_id"):
                keys.append("status:" + str(record["status_id"]))
            if record.get("source_url"):
                keys.extend(match_keys(record["source_url"]))
            for key in keys:
                index[key] = record
    return index


def enrich(records: list[dict], captures: dict[str, dict]) -> int:
    """Attach capture data to links. Short keys — this ends up embedded in the page."""
    hits = 0
    for record in records:
        capture = next((captures[k] for k in match_keys(record["u"]) if k in captures), None)
        if not capture:
            continue
        hits += 1
        author = capture.get("author") or {}
        inner = [
            link.get("resolved") or link.get("href")
            for link in (capture.get("links") or [])
            if link.get("resolved") or link.get("href")
        ]
        quoted = capture.get("quoted") or {}
        extra = {
            "t": capture.get("title"),
            "a": author.get("handle") or author.get("name"),
            "b": capture.get("text") or capture.get("description") or capture.get("fallback_text"),
            "l": [u for u in dict.fromkeys(inner) if u != record["u"]],
            "n": capture.get("note"),
            "q": quoted.get("text"),
            "d": capture.get("posted"),
        }
        record["x"] = {k: v for k, v in extra.items() if v}
    return hits


def load_triage(path: Path | None) -> dict:
    candidate = path or data_dir() / TRIAGE_DEFAULT
    if not candidate.is_file():
        return {}
    try:
        blob = json.loads(candidate.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"ignoring unreadable triage file {candidate}: {exc}", file=sys.stderr)
        return {}
    decisions = blob.get("decisions", blob)
    if not isinstance(decisions, dict):
        return {}
    valid = {"keep", "drop", "skip"}
    return {k: v for k, v in decisions.items() if v in valid}


# --- page --------------------------------------------------------------------

CSS = """
:root {
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1a1a1a; --dim: #6b6b6b;
  --line: #e4e0da; --accent: #7a5cff; --chip: #f1eee9;
  --keep: #17915c; --keep-bg: #e4f5ec; --drop: #c2422f; --drop-bg: #fbe9e5;
  --skip: #8a7a3f; --shadow: 0 10px 30px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --panel: #22252a; --ink: #e8e6e3; --dim: #9a9793;
    --line: #2c2f34; --accent: #a992ff; --chip: #2a2e34;
    --keep: #4fcf95; --keep-bg: #17301f; --drop: #ff8b74; --drop-bg: #33191a;
    --skip: #d8c47a; --shadow: 0 14px 34px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.75rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
  font: 15px/1.6 ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .2rem; letter-spacing: -.02em; }
.sub { color: var(--dim); margin: 0 0 1.4rem; font-size: .9rem; }
code { background: var(--chip); padding: .1rem .35rem; border-radius: .25rem; font-size: .85em; }

.tabs { display: flex; gap: .3rem; border-bottom: 1px solid var(--line); margin-bottom: 1.6rem; }
.tabs button {
  font: inherit; color: var(--dim); background: none; border: 0; cursor: pointer;
  padding: .6rem .9rem; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tabs button:hover { color: var(--ink); }
.panel[hidden] { display: none; }

/* --- triage --- */
.meter { height: 5px; background: var(--chip); border-radius: 3px; overflow: hidden; margin-bottom: .5rem; }
.meter i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .25s ease; }
.tally {
  display: flex; gap: 1rem; flex-wrap: wrap; color: var(--dim); font-size: .85rem;
  font-variant-numeric: tabular-nums; margin-bottom: 1.4rem;
}
.tally b { color: var(--ink); }
.tally .k b { color: var(--keep); } .tally .x b { color: var(--drop); } .tally .s b { color: var(--skip); }

#stage { position: relative; height: 24rem; margin: 0 auto 1.2rem; max-width: 34rem; touch-action: none; }
.card {
  position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--line);
  border-radius: 1rem; box-shadow: var(--shadow); padding: 1.6rem 1.5rem 1.4rem;
  display: flex; flex-direction: column; gap: .8rem; overflow: hidden;
  will-change: transform; user-select: none;
}
.card.top { cursor: grab; }
.card.top:active { cursor: grabbing; }
.card .mono {
  width: 2.6rem; height: 2.6rem; border-radius: .6rem; display: grid; place-items: center;
  font-weight: 700; font-size: 1.15rem; color: #fff; flex: none; letter-spacing: -.02em;
}
.card .head { display: flex; align-items: center; gap: .8rem; }
.card .host { font-size: 1.15rem; font-weight: 650; letter-spacing: -.01em; overflow-wrap: anywhere; }
.card .when { color: var(--dim); font-size: .8rem; font-variant-numeric: tabular-nums; }
.card .path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem;
  color: var(--dim); overflow-wrap: anywhere; max-height: 7.5rem; overflow: hidden;
}
.card .note {
  background: var(--chip); border-radius: .5rem; padding: .6rem .75rem; font-size: .9rem;
  max-height: 6rem; overflow: auto;
}
.card .title { font-size: 1rem; font-weight: 600; letter-spacing: -.01em; }
.card .body {
  font-size: .92rem; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical;
  overflow: hidden;
}
.card .inner { display: flex; flex-wrap: wrap; gap: .35rem; }
.card .inner a {
  font-size: .8rem; color: var(--accent); text-decoration: none; background: var(--chip);
  border-radius: 1rem; padding: .2rem .6rem; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.card .inner a:hover { text-decoration: underline; }
.card .bare { color: var(--dim); font-size: .82rem; font-style: italic; }
.card .foot { margin-top: auto; display: flex; align-items: center; gap: .8rem; }
.card .open {
  font: inherit; font-size: .9rem; color: var(--accent); background: none; text-decoration: none;
  border: 1px solid var(--line); border-radius: .5rem; padding: .4rem .8rem; cursor: pointer;
}
.card .open:hover { border-color: var(--accent); }
.card .siblings { color: var(--dim); font-size: .8rem; }
.stamp {
  position: absolute; top: 1.3rem; padding: .3rem .7rem; border-radius: .4rem; font-weight: 700;
  font-size: .95rem; letter-spacing: .08em; text-transform: uppercase; opacity: 0; pointer-events: none;
  border: 2px solid currentColor;
}
.stamp.keep { right: 1.3rem; color: var(--keep); background: var(--keep-bg); transform: rotate(9deg); }
.stamp.drop { left: 1.3rem; color: var(--drop); background: var(--drop-bg); transform: rotate(-9deg); }

.actions { display: flex; justify-content: center; align-items: center; gap: .6rem; flex-wrap: wrap; }
.actions button {
  font: inherit; cursor: pointer; border-radius: .6rem; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink); padding: .55rem 1rem;
}
.actions button:hover { border-color: var(--accent); }
.actions .no { color: var(--drop); } .actions .yes { color: var(--keep); }
.actions .no, .actions .yes { font-weight: 600; min-width: 7rem; }
.keys { text-align: center; color: var(--dim); font-size: .8rem; margin-top: .9rem; }
.keys kbd {
  background: var(--chip); border: 1px solid var(--line); border-bottom-width: 2px;
  border-radius: .3rem; padding: .05rem .35rem; font: inherit; font-size: .78rem;
}
.bulk { text-align: center; margin-top: 1rem; color: var(--dim); font-size: .85rem; }
.bulk button {
  font: inherit; font-size: .85rem; background: none; border: 0; color: var(--accent);
  cursor: pointer; text-decoration: underline; padding: 0 .2rem;
}
.done {
  text-align: center; padding: 3rem 1rem; border: 1px dashed var(--line); border-radius: 1rem;
  color: var(--dim);
}
.done b { color: var(--ink); display: block; font-size: 1.1rem; margin-bottom: .3rem; }

/* --- lists --- */
.note-box {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: .4rem; padding: .9rem 1.1rem; margin: 0 0 1.6rem; color: var(--dim); font-size: .9rem;
}
.note-box strong { color: var(--ink); }
#q {
  width: 100%; padding: .65rem .85rem; font: inherit; color: var(--ink); margin-bottom: .4rem;
  background: var(--panel); border: 1px solid var(--line); border-radius: .5rem;
}
#q:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
#count { color: var(--dim); font-size: .85rem; margin-bottom: 1rem; }
.host-group { margin: 1.6rem 0 0; border-top: 1px solid var(--line); padding-top: .9rem; }
.host-group > h2 { font-size: .95rem; margin: 0 0 .6rem; display: flex; gap: .6rem; align-items: baseline; font-weight: 600; }
.host-group > h2 .n {
  background: var(--chip); color: var(--dim); border-radius: 1rem; padding: .1rem .5rem;
  font-size: .75rem; font-variant-numeric: tabular-nums;
}
ol.links { list-style: none; margin: 0; padding: 0; }
ol.links li { display: grid; grid-template-columns: 1.4rem 5.5rem 1fr; gap: .7rem; padding: .3rem 0; align-items: baseline; }
ol.links time { color: var(--dim); font-size: .8rem; font-variant-numeric: tabular-nums; }
ol.links a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
ol.links a:hover { text-decoration: underline; }
ol.links .ctx { display: block; color: var(--dim); font-size: .85rem; overflow-wrap: anywhere; }
ol.links .ttl { display: block; font-weight: 600; overflow-wrap: anywhere; }
ol.links .mark { font-size: .9rem; text-align: center; }
li[data-verdict="keep"] .mark { color: var(--keep); }
li[data-verdict="drop"] .mark { color: var(--drop); }
li[data-verdict="drop"] a { opacity: .5; text-decoration: line-through; }
li[data-verdict="skip"] .mark { color: var(--skip); }
.hidden { display: none !important; }

/* --- results --- */
.bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1.4rem; }
.bar button, .bar label {
  font: inherit; font-size: .9rem; cursor: pointer; border-radius: .6rem;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: .5rem .9rem;
}
.bar button:hover, .bar label:hover { border-color: var(--accent); }
.bar input[type=file] { display: none; }
#saved-hint { color: var(--dim); font-size: .85rem; align-self: center; }
pre#md {
  background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; padding: 1rem;
  overflow: auto; max-height: 30rem; font-size: .85rem; white-space: pre-wrap; overflow-wrap: anywhere;
}
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--dim); font-size: .82rem; }
@media (max-width: 34rem) {
  #stage { height: 26rem; }
  ol.links li { grid-template-columns: 1.2rem 1fr; }
  ol.links time { grid-column: 2; }
}
"""

JS = r"""
const DATA = JSON.parse(document.getElementById('data').textContent);
const KEY = 'tg-links-triage-v1';
const VERDICTS = ['keep', 'drop', 'skip'];

let decisions = Object.assign({}, DATA.seeded, load());
const undo = [];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed.decisions || parsed)) {
      if (VERDICTS.includes(v)) out[k] = v;
    }
    return out;
  } catch (e) { return {}; }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ decisions, at: new Date().toISOString() }));
  } catch (e) { /* private browsing — the export button is the fallback */ }
}

const byUrl = new Map(DATA.links.map(l => [l.u, l]));
const hostCounts = {};
for (const l of DATA.links) hostCounts[l.h] = (hostCounts[l.h] || 0) + 1;

function pending() { return DATA.queue.filter(u => !decisions[u]); }
function tallyOf(v) { return Object.values(decisions).filter(x => x === v).length; }

/* --- monogram colour: stable hue per host, no palette to maintain --- */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/* --- card stack --- */
const stage = document.getElementById('stage');
const meter = document.querySelector('.meter i');

function cardEl(link, top) {
  const el = document.createElement('article');
  el.className = 'card' + (top ? ' top' : '');
  const siblings = hostCounts[link.h] - 1;
  const initial = (link.h.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
  el.innerHTML = `
    <div class="head">
      <div class="mono" style="background:hsl(${hue(link.h)} 58% 45%)">${initial}</div>
      <div>
        <div class="host"></div>
        <div class="when"></div>
      </div>
    </div>
    <div class="path"></div>
    <div class="foot">
      <a class="open" target="_blank" rel="noopener noreferrer">Open ↗</a>
      <span class="siblings"></span>
    </div>
    <div class="stamp keep">keep</div>
    <div class="stamp drop">drop</div>`;
  el.querySelector('.host').textContent = link.h;
  el.querySelector('.when').textContent = 'saved ' + (link.d || 'unknown');
  el.querySelector('.path').textContent = link.p;
  el.querySelector('.open').href = link.u;
  el.querySelector('.siblings').textContent =
    siblings > 0 ? `${siblings} more from this domain` : 'only one from this domain';

  const path = el.querySelector('.path');
  const x = link.x;

  if (x) {
    // Captured by the extension: lead with what the page actually says.
    if (x.t || x.a) {
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = x.a && x.t && !x.t.includes(x.a) ? `${x.a} — ${x.t}` : (x.t || x.a);
      path.before(title);
    }
    if (x.b) {
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = x.b;
      path.before(body);
    }
    if (x.q) {
      const quote = document.createElement('div');
      quote.className = 'note';
      quote.textContent = '↱ ' + x.q;
      path.before(quote);
    }
    if (x.l?.length) {
      const inner = document.createElement('div');
      inner.className = 'inner';
      for (const url of x.l.slice(0, 6)) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = url.replace(/^https?:\/\/(www\.)?/, '');
        inner.append(a);
      }
      path.before(inner);
    }
  } else {
    const bare = document.createElement('div');
    bare.className = 'bare';
    bare.textContent = 'No capture yet — open it, or sweep this domain with the extension.';
    path.before(bare);
  }

  // The Telegram-side note, if you typed anything alongside the link.
  for (const text of [link.c, x?.n].filter(Boolean)) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    path.after(note);
  }
  return el;
}

function render() {
  const queue = pending();
  const total = DATA.queue.length;
  const done = total - queue.length;
  meter.style.width = total ? (done / total * 100) + '%' : '100%';
  document.getElementById('pos').textContent = `${done} / ${total} decided`;
  document.getElementById('t-keep').textContent = tallyOf('keep');
  document.getElementById('t-drop').textContent = tallyOf('drop');
  document.getElementById('t-skip').textContent = tallyOf('skip');
  document.getElementById('undo-btn').disabled = undo.length === 0;

  stage.textContent = '';
  if (!queue.length) {
    const box = document.createElement('div');
    box.className = 'done';
    box.innerHTML = '<b>Queue empty.</b>Nothing left undecided. The Results tab has your keep list.';
    stage.append(box);
    document.getElementById('bulk').textContent = '';
    return;
  }

  // Two ghosts behind the live card give the stack depth without animating them.
  queue.slice(0, 3).reverse().forEach((url, i, arr) => {
    const depth = arr.length - 1 - i;
    const el = cardEl(byUrl.get(url), depth === 0);
    el.style.transform = `translateY(${depth * 9}px) scale(${1 - depth * 0.035})`;
    el.style.opacity = depth > 1 ? '.55' : '1';
    el.style.zIndex = String(10 - depth);
    stage.append(el);
  });

  arm(stage.querySelector('.card.top'), byUrl.get(queue[0]));
  bulkHint(byUrl.get(queue[0]), queue);
}

function bulkHint(link, queue) {
  const same = queue.filter(u => byUrl.get(u).h === link.h).length;
  const box = document.getElementById('bulk');
  box.textContent = '';
  if (same < 3) return;
  box.append(document.createTextNode(`${same} undecided from ${link.h} — `));
  for (const [verdict, label] of [['keep', 'keep all'], ['drop', 'drop all']]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      undo.push(queue.filter(u => byUrl.get(u).h === link.h).map(u => ({ url: u, prev: decisions[u] })));
      for (const u of queue) if (byUrl.get(u).h === link.h) decisions[u] = verdict;
      persist(); render(); refreshLists();
    };
    box.append(b);
  }
}

/* --- drag --- */
const THRESHOLD = 105;

function arm(card, link) {
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  const move = (x, y) => {
    dx = x - startX; dy = y - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const p = Math.min(Math.abs(dx) / THRESHOLD, 1);
    card.querySelector('.stamp.keep').style.opacity = dx > 0 ? p : 0;
    card.querySelector('.stamp.drop').style.opacity = dx < 0 ? p : 0;
  };

  card.addEventListener('pointerdown', e => {
    if (e.target.closest('.open')) return;   // let the link through
    dragging = true; startX = e.clientX; startY = e.clientY;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });

  card.addEventListener('pointermove', e => { if (dragging) move(e.clientX, e.clientY); });

  card.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform .28s ease-out, opacity .28s ease-out';
    if (Math.abs(dx) >= THRESHOLD) {
      commit(link.u, dx > 0 ? 'keep' : 'drop', card, dx > 0 ? 1 : -1);
    } else if (dy < -THRESHOLD) {
      commit(link.u, 'skip', card, 0, -1);
    } else {
      card.style.transform = '';
      card.querySelectorAll('.stamp').forEach(s => s.style.opacity = 0);
    }
  });
  card.addEventListener('pointercancel', () => { dragging = false; card.style.transform = ''; });
}

function commit(url, verdict, card, xdir = 0, ydir = 0) {
  undo.push([{ url, prev: decisions[url] }]);
  decisions[url] = verdict;
  persist();
  if (card) {
    card.style.transform =
      `translate(${xdir * 620}px, ${ydir * 620 + (ydir ? 0 : 40)}px) rotate(${xdir * 22}deg)`;
    card.style.opacity = '0';
    setTimeout(() => { render(); refreshLists(); }, 190);
  } else {
    render(); refreshLists();
  }
}

function decide(verdict) {
  const queue = pending();
  if (!queue.length) return;
  const card = stage.querySelector('.card.top');
  const dir = verdict === 'keep' ? 1 : verdict === 'drop' ? -1 : 0;
  card.style.transition = 'transform .28s ease-out, opacity .28s ease-out';
  commit(queue[0], verdict, card, dir, verdict === 'skip' ? -1 : 0);
}

function undoLast() {
  const batch = undo.pop();
  if (!batch) return;
  for (const { url, prev } of batch) {
    if (prev) decisions[url] = prev; else delete decisions[url];
  }
  persist(); render(); refreshLists();
}

document.getElementById('keep-btn').onclick = () => decide('keep');
document.getElementById('drop-btn').onclick = () => decide('drop');
document.getElementById('skip-btn').onclick = () => decide('skip');
document.getElementById('undo-btn').onclick = undoLast;

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if (document.getElementById('p-triage').hidden) return;
  const k = e.key.toLowerCase();
  if (e.key === 'ArrowRight' || k === 'k') { e.preventDefault(); decide('keep'); }
  else if (e.key === 'ArrowLeft' || k === 'd') { e.preventDefault(); decide('drop'); }
  else if (e.key === 'ArrowUp' || k === 's') { e.preventDefault(); decide('skip'); }
  else if (k === 'u' || (k === 'z' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undoLast(); }
  else if (k === 'o') {
    const q = pending();
    if (q.length) window.open(q[0], '_blank', 'noopener');
  }
});

/* --- tabs --- */
const tabs = [...document.querySelectorAll('.tabs button')];
tabs.forEach(btn => btn.onclick = () => {
  tabs.forEach(b => {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    document.getElementById(b.dataset.panel).hidden = !on;
  });
  if (btn.dataset.panel === 'p-results') refreshResults();
});

/* --- all-links list --- */
const rows = [...document.querySelectorAll('ol.links li')];
rows.forEach(li => li.dataset.hay = li.textContent.toLowerCase());
const groups = [...document.querySelectorAll('.host-group')];
const q = document.getElementById('q');

function refreshLists() {
  for (const li of rows) {
    const v = decisions[li.dataset.url];
    li.dataset.verdict = v || '';
    li.querySelector('.mark').textContent = v === 'keep' ? '✓' : v === 'drop' ? '✕' : v === 'skip' ? '·' : '';
  }
}

function filter() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const li of rows) {
    const hit = !term || li.dataset.hay.includes(term);
    li.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  for (const g of groups) g.classList.toggle('hidden', !g.querySelector('ol.links li:not(.hidden)'));
  document.getElementById('count').textContent =
    term ? `${shown} of ${rows.length} shown` : `${rows.length} links`;
}
q.addEventListener('input', filter);

/* --- results --- */
function markdown() {
  const kept = DATA.links.filter(l => decisions[l.u] === 'keep');
  const byHost = {};
  for (const l of kept) (byHost[l.h] = byHost[l.h] || []).push(l);
  const hosts = Object.keys(byHost).sort((a, b) => byHost[b].length - byHost[a].length || a.localeCompare(b));
  const lines = [`# Kept links (${kept.length})`, ''];
  for (const h of hosts) {
    lines.push(`## ${h}`, '');
    for (const l of byHost[h].sort((a, b) => b.d.localeCompare(a.d))) {
      const x = l.x;
      const label = x?.t ? (x.a && !x.t.includes(x.a) ? `${x.a} — ${x.t}` : x.t) : null;
      lines.push(label ? `- [${label}](${l.u}) _(${l.d})_` : `- ${l.u} _(${l.d})_`);
      if (x?.b) lines.push(`  > ${x.b.replace(/\s+/g, ' ').slice(0, 400)}`);
      for (const inner of (x?.l || [])) lines.push(`  - ↳ ${inner}`);
      const note = l.c || x?.n;
      if (note) lines.push(`  — ${note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* The sweep list: what you still have no page data for. Paste into the extension. */
function needsCapture() {
  return DATA.links.filter(l => !l.x && decisions[l.u] !== 'drop').map(l => l.u);
}

function refreshResults() {
  const counts = { keep: tallyOf('keep'), drop: tallyOf('drop'), skip: tallyOf('skip') };
  counts.left = DATA.queue.length - counts.keep - counts.drop - counts.skip;
  document.getElementById('r-summary').textContent =
    `${counts.keep} kept · ${counts.drop} dropped · ${counts.skip} deferred · ${counts.left} undecided`;
  document.getElementById('md').textContent = markdown();
}

document.getElementById('save-btn').onclick = () => {
  const blob = new Blob([JSON.stringify({ decisions, at: new Date().toISOString() }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = DATA.triageName;
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById('saved-hint').textContent =
    `saved — keep it next to this file and re-run the script to preserve it`;
};

document.getElementById('load-input').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = parsed.decisions || parsed;
    let n = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (VERDICTS.includes(v)) { decisions[k] = v; n++; }
    }
    persist(); render(); refreshLists(); refreshResults();
    document.getElementById('saved-hint').textContent = `loaded ${n} decisions`;
  } catch (err) {
    document.getElementById('saved-hint').textContent = 'could not read that file';
  }
};

document.getElementById('sweep-btn').onclick = async () => {
  const urls = needsCapture();
  const btn = document.getElementById('sweep-btn');
  if (!urls.length) { btn.textContent = 'Everything has a capture'; return; }
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    btn.textContent = `${urls.length} URLs copied`;
  } catch (e) {
    btn.textContent = 'Clipboard blocked — see the list below';
    document.getElementById('md').textContent = urls.join('\n');
  }
  setTimeout(() => btn.textContent = 'Copy URLs needing capture', 2200);
};

document.getElementById('copy-btn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(markdown());
    document.getElementById('copy-btn').textContent = 'Copied';
    setTimeout(() => document.getElementById('copy-btn').textContent = 'Copy markdown', 1400);
  } catch (e) {
    document.getElementById('copy-btn').textContent = 'Select the text below instead';
  }
};

document.getElementById('reset-btn').onclick = () => {
  if (!confirm('Clear every decision on this page? The saved JSON file is not touched.')) return;
  decisions = {}; undo.length = 0; persist(); render(); refreshLists(); refreshResults();
};

render();
refreshLists();
filter();
"""


def title_of(record: dict) -> str:
    """The captured headline for a link, as a list-row prefix. Empty when uncaptured."""
    extra = record.get("x") or {}
    title, author = extra.get("t"), extra.get("a")
    if not title and not author:
        return ""
    label = f"{author} — {title}" if title and author and author not in title else (title or author)
    return f'<span class="ttl">{html.escape(label)}</span>'


def render_page(linked: list[dict], unschemed: list[dict], stats: dict, seeded: dict, triage_name: str) -> str:
    e = html.escape
    groups = group_by_host(linked)
    years = Counter(r["d"][:4] for r in linked if r["d"])
    span = f"{stats['dates'][0]} → {stats['dates'][-1]}" if stats["dates"] else "unknown"
    year_html = " · ".join(f"{e(y)} <b>{n}</b>" for y, n in sorted(years.items()))

    sections = []
    for host, items in groups:
        rows = "\n".join(
            f'        <li data-url="{e(r["u"])}"><span class="mark"></span><time>{e(r["d"])}</time>'
            f'<span>{title_of(r)}'
            f'<a href="{e(r["u"])}" target="_blank" rel="noopener noreferrer">{e(r["u"])}</a>'
            + (f'<span class="ctx">{e(r["c"])}</span>' if r["c"] else "")
            + "</span></li>"
            for r in items
        )
        sections.append(
            f'      <section class="host-group">\n'
            f'        <h2>{e(host)} <span class="n">{len(items)}</span></h2>\n'
            f'        <ol class="links">\n{rows}\n        </ol>\n      </section>'
        )

    unschemed_html = ""
    if unschemed:
        rows = "\n".join(
            f'        <li><span class="mark"></span><time>{e(r["d"])}</time>'
            f'<span><code>{e(r["u"])}</code>'
            + (f'<span class="ctx">{e(r["c"])}</span>' if r["c"] else "")
            + "</span></li>"
            for r in sorted(unschemed, key=lambda r: r["d"], reverse=True)
        )
        unschemed_html = (
            '      <section class="host-group">\n'
            f'        <h2>no scheme — check by hand <span class="n">{len(unschemed)}</span></h2>\n'
            '        <p class="note-box">Telegram tagged these as links because <code>.sh</code>, '
            '<code>.py</code> and <code>.so</code> are valid TLDs. Some are real sites typed without '
            '<code>https://</code>, some are filenames from code snippets. Not mechanically separable, '
            'so they sit out of the triage queue rather than being dropped.</p>\n'
            f'        <ol class="links">\n{rows}\n        </ol>\n      </section>'
        )

    payload = {
        "links": linked,
        "queue": [r["u"] for r in queue_order(linked)],
        "seeded": seeded,
        "triageName": triage_name,
    }
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    seeded_note = (
        f'<p class="note-box">Preloaded <strong>{len(seeded)}</strong> decisions from '
        f"<code>{e(triage_name)}</code>; those links are out of the queue.</p>"
        if seeded
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram saved links — triage</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>Telegram saved links</h1>
  <p class="sub">{stats["links"]} links from <code>{e(str(stats["chat"]))}</code> · {e(span)} · {len(groups)} domains</p>

  <div class="tabs" role="tablist">
    <button role="tab" data-panel="p-triage" aria-selected="true">Triage</button>
    <button role="tab" data-panel="p-all" aria-selected="false">All links</button>
    <button role="tab" data-panel="p-results" aria-selected="false">Results</button>
  </div>

  <section class="panel" id="p-triage">
    {seeded_note}
    <div class="meter"><i></i></div>
    <div class="tally">
      <span id="pos">0 / 0 decided</span>
      <span class="k">keep <b id="t-keep">0</b></span>
      <span class="x">drop <b id="t-drop">0</b></span>
      <span class="s">deferred <b id="t-skip">0</b></span>
    </div>

    <div id="stage"></div>

    <div class="actions">
      <button class="no" id="drop-btn">← Drop</button>
      <button id="skip-btn">↑ Later</button>
      <button id="undo-btn">Undo</button>
      <button class="yes" id="keep-btn">Keep →</button>
    </div>
    <p class="keys">
      Drag the card, or <kbd>←</kbd> drop · <kbd>→</kbd> keep · <kbd>↑</kbd> later ·
      <kbd>o</kbd> open · <kbd>u</kbd> undo
    </p>
    <p class="bulk" id="bulk"></p>
  </section>

  <section class="panel" id="p-all" hidden>
    <p class="note-box">Per year: {year_html}<br>
    <strong>No page titles.</strong> Telegram fetches link previews at send time and leaves them out
    of the export, so a bare <code>x.com/i/status/…</code> stays bare — only
    {stats["with_context"]} of {stats["links"]} links carry any text you typed alongside them.</p>
    <input id="q" type="search" placeholder="Filter by URL or note…" autocomplete="off" spellcheck="false">
    <div id="count"></div>
{chr(10).join(sections)}
{unschemed_html}
  </section>

  <section class="panel" id="p-results" hidden>
    <div class="bar">
      <button id="save-btn">Save progress ({e(triage_name)})</button>
      <label for="load-input">Load progress<input id="load-input" type="file" accept=".json"></label>
      <button id="copy-btn">Copy markdown</button>
      <button id="sweep-btn">Copy URLs needing capture</button>
      <button id="reset-btn">Reset</button>
      <span id="saved-hint"></span>
    </div>
    <p class="note-box"><strong id="r-summary"></strong><br>
    Decisions live in this browser's localStorage, which does not survive regenerating the page.
    Save the JSON beside this file and the script picks it up on the next run:
    <code>./tools/telegram-saved-links.py &lt;result.json&gt;</code></p>
    <pre id="md"></pre>
  </section>

  <footer>
    Generated by <code>tools/telegram-saved-links.py</code> on {date.today().isoformat()}.
  </footer>
</div>
<script id="data" type="application/json">{data_json}</script>
<script>{JS}</script>
</body>
</html>
"""


def main() -> int:
    args = parse_args()
    if not args.export.is_file():
        print(f"no such file: {args.export}", file=sys.stderr)
        return 1

    linked, unschemed, stats = collect(args.export)
    if not linked and not unschemed:
        print("no link entities found in this export", file=sys.stderr)
        return 1

    # The extension's paste box reads "URL<TAB>date", so the Telegram save dates survive the
    # handoff instead of collapsing to the moment of the paste.
    if args.urls:
        try:
            for record in sorted(linked, key=lambda r: r["d"], reverse=True):
                print(f"{record['u']}\t{record['d']}")
        except BrokenPipeError:
            # Piping into head/less closes stdout early; that is not an error.
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0

    captures = load_captures(args.captures)
    enriched = enrich(linked, captures)

    seeded_all = load_triage(args.triage)
    urls = {r["u"] for r in linked}
    seeded = {k: v for k, v in seeded_all.items() if k in urls}

    triage_name = (args.triage or data_dir() / TRIAGE_DEFAULT).name
    out = args.output or data_dir() / f"{date.today().isoformat()}-telegram-saved-links.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_page(linked, unschemed, stats, seeded, triage_name), encoding="utf-8")

    print(f"{stats['links']} links across {stats['messages']} messages")
    if unschemed:
        print(f"{stats['schemeless']} schemeless entities listed outside the queue")
    if captures:
        print(f"{enriched} links enriched from browser captures ({stats['links'] - enriched} still bare)")
    if seeded:
        print(f"preloaded {len(seeded)} decisions; {stats['links'] - len(seeded)} left to triage")
    stale = len(seeded_all) - len(seeded)
    if stale:
        print(f"{stale} saved decisions refer to links not in this export (kept in the file, unused)")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
