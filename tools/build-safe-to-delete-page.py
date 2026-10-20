#!/usr/bin/env python3
# DESC: Build the safe-to-delete page: every saved message or link from Telegram, Instagram, X and the phone, marked by whether Link Keeper holds it.
"""Browse what you saved, from every source, and see what is safe to delete where it came from.

Once links have been migrated into Link Keeper, the messages they came from are duplication, and some
of them carry more than the link. This renders one row per message (Telegram) or per link (Instagram
DMs, X DMs, the phone's share inbox), says which source and thread it came from, and gives each a verdict,
a mark to cycle (unmarked, to delete, deleted) and a list of what you marked.

"In Link Keeper" is what the extension holds, read with `tools/link-keeper.mjs links` (the live add-on, or
its latest backup when Firefox is closed). When that cannot be read, the import's `link-captures-all.jsonl`
stands in, and the page says which one it used.

The verdicts, from safest to least:

  migrated      every link in it is in Link Keeper, and the message carries nothing else. Deleting it
                loses nothing. (Instagram, X and phone rows are one link each, so this is all they get
                besides "not in Link Keeper".)
  your note     Telegram: links are held, but you also typed something. The note was never migrated.
  not captured  it has a link that Link Keeper does not hold. Deleting it loses the link.
  note only     Telegram: no link at all. Your own writing: code, reminders, drafts. Never migrated.
  media         Telegram: a photo, file or voice message. **Exported with media unchecked, so these were
                never downloaded and no copy exists anywhere.**

Nothing here deletes anything; none of these services has an API for that from a static page. The
output is a list you act on yourself.

The page is rebuilt only when its input changed: with `--only-if-changed` a fingerprint kept beside the
output (the rows as they would be drawn, what Link Keeper holds of them, and this code) is compared first,
and an unchanged page is not written again. Without the flag it always builds.

Usage:
    ./build-safe-to-delete-page.py [result.json] [-c all.jsonl] [-o safe-to-delete.html] [--only-if-changed]

Every input defaults to its file in DATA_DIR (see link_sources.py); the Telegram export is optional.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import link_sources as ls  # noqa: E402

# Text that is really just the link again, not a note worth keeping.
TRIVIAL = re.compile(r"^[\s\-–—:•>*•]*$")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render every saved message or link, flagging what Link Keeper already holds.")
    ls.add_input_arguments(p)
    p.add_argument("-o", "--output", type=Path, help="output path (default $DATA_DIR/safe-to-delete.html)")
    return p.parse_args()


def parts_of(msg: dict) -> list:
    text = msg.get("text", "")
    return text if isinstance(text, list) else [text]


def render_text(msg: dict) -> str:
    """Rebuild the message with its entities: links clickable, code monospaced."""
    out = []
    for part in parts_of(msg):
        if isinstance(part, str):
            out.append(html.escape(part))
            continue
        kind = part.get("type")
        body = html.escape(part.get("text", ""))
        if kind in ("link", "text_link"):
            href = html.escape(part.get("href") or part.get("text") or "")
            out.append(f'<a href="{href}" target="_blank" rel="noopener noreferrer">{body}</a>')
        elif kind in ("code", "pre"):
            out.append(f"<code>{body}</code>")
        elif kind == "bold":
            out.append(f"<b>{body}</b>")
        elif kind == "italic":
            out.append(f"<i>{body}</i>")
        else:
            out.append(body)
    return "".join(out)


def plain_text(msg: dict) -> str:
    return "".join(p if isinstance(p, str) else p.get("text", "") for p in parts_of(msg))


def links_of(msg: dict) -> list:
    return [e.get("text", "") for e in (msg.get("text_entities") or []) if e.get("type") == "link"]


def media_of(msg: dict):
    if msg.get("media_type") == "voice_message":
        return "voice message"
    if msg.get("media_type"):
        return msg["media_type"].replace("_", " ")
    if msg.get("photo"):
        return "photo"
    if msg.get("file"):
        return f"file · {msg.get('file_name') or 'unnamed'}"
    return None


def in_link_keeper(url: str, held: set) -> bool:
    return any(k in held for k in ls.match_keys(url))


def verdict(msg: dict, held: set) -> str:
    if media_of(msg):
        return "media"
    links = links_of(msg)
    if not links:
        return "note"
    text = plain_text(msg)
    for link in links:
        text = text.replace(link, " ")
    note_left = not TRIVIAL.match(text)
    unresolved = [l for l in links if not in_link_keeper(l, held)]
    if unresolved:
        return "uncaptured"
    return "yournote" if note_left else "migrated"


LABEL = {
    "migrated": "safe — in Link Keeper",
    "yournote": "in Link Keeper, but you wrote a note",
    "uncaptured": "not in Link Keeper",
    "note": "your note — never migrated",
    "media": "media — never exported",
}
VERDICTS = ["migrated", "yournote", "uncaptured", "note", "media"]
CLAMP_AT = 700

CSS = """
:root{--bg:#fbfaf8;--card:#fff;--ink:#1a1a1a;--dim:#6b6b6b;--line:#e4e0da;--accent:#7a5cff;
  --chip:#f1eee9;--safe:#17915c;--safe-bg:#e4f5ec;--warn:#c2422f;--keepc:#8a7a3f}
@media (prefers-color-scheme:dark){:root{--bg:#15161a;--card:#1e2126;--ink:#e8e6e3;--dim:#9a9793;
  --line:#2c2f34;--accent:#a992ff;--chip:#282c33;--safe:#4fcf95;--safe-bg:#17301f;--warn:#ff8b74;--keepc:#d8c47a}}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem 1.25rem 6rem;background:var(--bg);color:var(--ink);
  font:14.5px/1.55 ui-sans-serif,-apple-system,"Helvetica Neue",sans-serif}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 .2rem}
.sub{color:var(--dim);font-size:.88rem;margin:0 0 1rem}
.warn{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:.4rem;padding:.8rem 1rem;margin:0 0 1.2rem;font-size:.88rem}
.warn b{color:var(--warn)}
.bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;position:sticky;top:0;z-index:9;
  background:var(--bg);padding:.7rem 0;border-bottom:1px solid var(--line);margin-bottom:1rem}
#q{flex:1 1 14rem;padding:.45rem .75rem;font:inherit;background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:.45rem}
#ticked{min-width:9.5rem}
#ticked[data-mode=none]{border-color:var(--accent);color:var(--accent)}
#ticked[data-mode=ticked]{border-color:var(--keepc);color:var(--keepc)}
#ticked[data-mode=deleted]{border-color:var(--safe);color:var(--safe)}
.chip{border:1px solid var(--line);background:var(--card);color:var(--dim);border-radius:1rem;
  padding:.3rem .75rem;font-size:.8rem;cursor:pointer;font-variant-numeric:tabular-nums}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
button.act{font:inherit;font-size:.82rem;cursor:pointer;background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:.45rem;padding:.4rem .7rem}
button.act:hover{border-color:var(--accent)}
button.act.go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.msg{display:grid;grid-template-columns:1.5rem 1fr;gap:.7rem;background:var(--card);
  border:1px solid var(--line);border-radius:.55rem;padding:.7rem .85rem;margin-bottom:.5rem}
.msg.v-migrated{border-left:3px solid var(--safe)}
.msg.v-uncaptured,.msg.v-media{border-left:3px solid var(--warn)}
.msg.v-note,.msg.v-yournote{border-left:3px solid var(--keepc)}
.msg .state{width:1.5rem;height:1.5rem;margin-top:.15rem;padding:0;cursor:pointer;font:inherit;
  font-size:.9rem;line-height:1;border:1px solid var(--line);border-radius:.35rem;
  background:var(--card);color:var(--dim)}
.msg .state:hover{border-color:var(--accent)}
.msg[data-state=ticked] .state{border-color:var(--keepc);color:var(--keepc);font-weight:700}
.msg[data-state=deleted] .state{border-color:var(--safe);background:var(--safe);color:#fff;font-weight:700}
.msg[data-state=ticked]{background:var(--chip)}
.msg[data-state=deleted]{opacity:.5}
.msg[data-state=deleted] .body{text-decoration:line-through}
.head{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;font-size:.76rem;color:var(--dim);margin-bottom:.2rem}
.head .v{padding:.05rem .45rem;border-radius:1rem;background:var(--chip)}
.head .v.migrated{background:var(--safe-bg);color:var(--safe);font-weight:600}
.head .v.uncaptured,.head .v.media{color:var(--warn)}
.body{white-space:pre-wrap;overflow-wrap:anywhere}
.body a{color:var(--accent)}
.body code{background:var(--chip);padding:0 .25rem;border-radius:.2rem;font-size:.88em}
.clamp{max-height:11rem;overflow:hidden;position:relative}
.clamp::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2.5rem;
  background:linear-gradient(transparent,var(--card))}
.more{background:none;border:0;color:var(--accent);font:inherit;font-size:.78rem;cursor:pointer;padding:.2rem 0}
.hidden{display:none!important}
#out{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
  padding:.6rem 1.25rem;display:flex;gap:.6rem;align-items:center;font-size:.85rem}
#out b{font-variant-numeric:tabular-nums}
select{font:inherit;font-size:.82rem;background:var(--card);color:var(--ink);border:1px solid var(--line);
  border-radius:.45rem;padding:.4rem .5rem;max-width:16rem}
.bar .sep{flex-basis:100%;height:0}
.head .src{padding:.05rem .45rem;border-radius:.3rem;background:var(--accent);color:#fff;font-weight:600}
.head .src.x{background:#444}.head .src.instagram{background:#c13584}.head .src.phone{background:#2f7d6d}
.head .thr{color:var(--ink);font-weight:600}
@media (max-width:700px){.bar{position:static}#out{flex-wrap:wrap;gap:.3rem .6rem;padding:.4rem .8rem}}
h2.grp{font-size:.95rem;margin:1.3rem 0 .5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.msg .ttl{display:block;font-weight:600}
.msg .url{display:block;font-size:.85rem;overflow-wrap:anywhere;margin-top:.15rem}
.basis{font-size:.82rem;color:var(--dim);margin:0 0 1rem}
.basis.fallback{color:var(--warn)}
details.marks{font-size:.82rem;color:var(--dim);margin:.2rem 0 1rem}
details.marks summary{cursor:pointer}
pre#ids{max-height:12rem;overflow:auto;background:var(--chip);border-radius:.4rem;padding:.6rem;
  font-size:.8rem;white-space:pre-wrap;margin:.6rem 0 0}
"""

JS = r"""
const KEY = 'tg-states';
const OLD_KEY = 'tg-delete-ticks';
const rows = [...document.querySelectorAll('.msg')];
const q = document.getElementById('q');
let filter = 'all';
let srcFilter = 'all';
let threadFilter = 'all';

/* Three states per message: unmarked, to-delete, deleted. "deleted" means you have actually removed
 * it in Telegram, so the two together are a worklist and a record of what is done. */
const STATES = ['none', 'ticked', 'deleted'];
const GLYPH = { none: '·', ticked: '✓', deleted: '✕' };
let states = {};
try { states = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { states = {}; }
if (!Object.keys(states).length) {
  // Carry over ticks made before this had three states.
  try {
    for (const id of JSON.parse(localStorage.getItem(OLD_KEY) || '[]')) states[id] = 'ticked';
  } catch (e) { /* nothing to carry */ }
}
// Marks made when the page held Telegram only are keyed by the bare message number.
for (const k of Object.keys(states)) {
  if (/^\d+$/.test(k)) { states['tg:' + k] = states[k]; delete states[k]; }
}

const stateOf = r => states[r.dataset.id] || 'none';

function paint(r) {
  const st = stateOf(r);
  r.dataset.state = st;
  r.querySelector('.state').textContent = GLYPH[st];
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(states));
}

function setState(r, st) {
  if (st === 'none') delete states[r.dataset.id];
  else states[r.dataset.id] = st;
  paint(r);
}

rows.forEach(r => {
  r.dataset.hay = r.textContent.toLowerCase();
  paint(r);
  r.querySelector('.state').onclick = () => {
    setState(r, STATES[(STATES.indexOf(stateOf(r)) + 1) % STATES.length]);
    save();
    count();
    if (document.getElementById('ticked').dataset.mode !== 'all') apply();
  };
  const more = r.querySelector('.more');
  if (more) more.onclick = () => {
    const body = r.querySelector('.body');
    body.classList.toggle('clamp');
    more.textContent = body.classList.contains('clamp') ? 'more' : 'less';
  };
});

function count() {
  const all = Object.values(states);
  document.getElementById('n-ticked').textContent = all.filter(v => v === 'ticked').length;
  document.getElementById('n-deleted').textContent = all.filter(v => v === 'deleted').length;
}

function apply() {
  const term = q.value.trim().toLowerCase();
  const tickMode = document.getElementById('ticked').dataset.mode;
  let shown = 0;
  const tally = { all: 0 };
  for (const r of rows) {
    const st = stateOf(r);
    const tickOk = tickMode === 'all' || tickMode === st;
    const others = tickOk
      && (srcFilter === 'all' || r.dataset.source === srcFilter)
      && (threadFilter === 'all' || r.dataset.threads.split('|').includes(threadFilter))
      && (!term || r.dataset.hay.includes(term));
    if (others) { tally.all++; tally[r.dataset.verdict] = (tally[r.dataset.verdict] || 0) + 1; }
    const hit = others && (filter === 'all' || r.dataset.verdict === filter);
    r.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  // The verdict chips count what the other filters leave, so they never promise rows that are not there.
  for (const b of VERDICT_CHIPS) b.textContent = `${b.dataset.label} ${tally[b.dataset.vchip] || 0}`;
  document.getElementById('n-shown').textContent = shown;
  if (typeof groupCounts === 'function') groupCounts();
}

const VERDICT_CHIPS = [...document.querySelectorAll('[data-vchip]')];
VERDICT_CHIPS.forEach(b => b.onclick = () => {
  filter = b.dataset.vchip;
  VERDICT_CHIPS.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  apply();
});

/* The thread list follows the source: a thread belongs to the source that holds it. */
const threadSel = document.getElementById('thread');
const SRC_CHIPS = [...document.querySelectorAll('[data-schip]')];
function fillThreads() {
  const seen = new Map();
  for (const r of rows) {
    if (srcFilter !== 'all' && r.dataset.source !== srcFilter) continue;
    for (const t of r.dataset.threads.split('|')) if (t) seen.set(t, (seen.get(t) || 0) + 1);
  }
  threadSel.textContent = '';
  const all = new Option('all threads', 'all');
  threadSel.add(all);
  for (const [t, n] of [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    threadSel.add(new Option(`${t} (${n})`, t));
  threadSel.hidden = seen.size < 2;
  threadFilter = 'all';
}
SRC_CHIPS.forEach(b => b.onclick = () => {
  srcFilter = b.dataset.schip;
  SRC_CHIPS.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  fillThreads();
  apply();
});
threadSel.onchange = () => { threadFilter = threadSel.value; apply(); };
fillThreads();
q.addEventListener('input', apply);

/* Rows arrive newest first; data-seq numbers them oldest first. Reordering moves the existing nodes
 * rather than rebuilding them, so marks and expanded bodies survive. "by source" puts a heading in front
 * of each source and thread. */
const container = rows[0]?.parentNode;
const viewSel = document.getElementById('view');
const anchor = document.getElementById('ids');
function arrange() {
  const mode = viewSel.value;
  container.querySelectorAll('.grp').forEach(g => g.remove());
  const seq = r => +r.dataset.seq || 0;
  let list = [...rows];
  if (mode === 'oldest') list.sort((a, b) => seq(a) - seq(b));
  else if (mode === 'newest') list.sort((a, b) => seq(b) - seq(a));
  else list.sort((a, b) => (+a.dataset.srcorder - +b.dataset.srcorder)
    || a.dataset.thread1.localeCompare(b.dataset.thread1) || seq(b) - seq(a));
  let last = null;
  for (const r of list) {
    if (mode === 'source') {
      const g = `${r.dataset.srclabel} · ${r.dataset.thread1 || 'no thread'}`;
      if (g !== last) {
        const h = document.createElement('h2');
        h.className = 'grp';
        h.dataset.group = g;
        container.insertBefore(h, anchor);
        last = g;
      }
    }
    container.insertBefore(r, anchor);
  }
  groupCounts();
  try { localStorage.setItem('tg-view', mode); } catch (e) { /* no storage */ }
}
function groupCounts() {
  document.querySelectorAll('.grp').forEach(h => {
    let n = 0, el = h.nextElementSibling;
    while (el && !el.classList.contains('grp') && el.id !== 'ids') {
      if (el.classList.contains('msg') && !el.classList.contains('hidden')) n++;
      el = el.nextElementSibling;
    }
    h.textContent = `${h.dataset.group} · ${n}`;
    h.classList.toggle('hidden', n === 0);
  });
}
viewSel.onchange = arrange;
try { const v = localStorage.getItem('tg-view'); if (v) viewSel.value = v; } catch (e) { /* no storage */ }
if (!viewSel.value) viewSel.value = 'newest';
arrange();

const LABELS = { all: 'show: all', none: 'show: unmarked', ticked: 'show: to delete', deleted: 'show: deleted' };
const ORDER = ['all', 'none', 'ticked', 'deleted'];
const tickBtn = document.getElementById('ticked');
tickBtn.onclick = () => {
  const next = ORDER[(ORDER.indexOf(tickBtn.dataset.mode) + 1) % ORDER.length];
  tickBtn.dataset.mode = next;
  tickBtn.textContent = LABELS[next];
  localStorage.setItem('tg-tickmode', next);
  apply();
};
const savedMode = localStorage.getItem('tg-tickmode');
if (savedMode && savedMode !== 'all') {
  tickBtn.dataset.mode = savedMode;
  tickBtn.textContent = LABELS[savedMode];
}

/* Nothing here changes more than one message at a time. The marks are the only record of what has
 * already been deleted in Telegram, and no button is worth the risk of rewriting them wholesale.
 * Starting over means clearing this page's local storage by hand, which is rare and deliberate.
 */
document.getElementById('show-ids').onclick = () => {
  const picked = rows.filter(r => stateOf(r) === 'ticked');
  const lines = picked.map(r => `${r.dataset.srclabel}\t${r.dataset.thread1}\t${r.dataset.ref}\t${r.dataset.date}\t${(r.dataset.hay || '').slice(0, 70)}`);
  const box = document.getElementById('ids');
  box.textContent = lines.join('\n') || 'nothing ticked';
  box.classList.remove('hidden');
  navigator.clipboard.writeText(picked.map(r => r.dataset.ref).join('\n')).catch(() => {});
};

/* Marks live in this browser's storage for this file. Moving to a new file name starts empty, so they
 * can be carried by hand: copy them from the old page (its console: copy(localStorage['tg-states']))
 * and paste them here. Existing marks are never overwritten by a paste, only added to. */
document.getElementById('copy-marks').onclick = () => {
  navigator.clipboard.writeText(JSON.stringify(states)).catch(() => {});
  document.getElementById('marks-hint').textContent = `copied ${Object.keys(states).length} marks`;
};
document.getElementById('paste-marks').onclick = () => {
  const raw = prompt('Paste the marks JSON (from "copy marks", or localStorage[\'tg-states\'] of the old page):');
  if (!raw) return;
  try {
    const incoming = JSON.parse(raw);
    let n = 0;
    for (const [k, v] of Object.entries(incoming)) {
      const id = /^\d+$/.test(k) ? 'tg:' + k : k;
      if (STATES.includes(v) && v !== 'none' && !states[id]) { states[id] = v; n++; }
    }
    save(); rows.forEach(paint); count(); apply();
    document.getElementById('marks-hint').textContent = `added ${n} marks`;
  } catch (e) {
    document.getElementById('marks-hint').textContent = 'could not read that';
  }
};

/* Remember where you were, by message rather than by pixel: a filter change, a re-sort or a
 * regenerated file all move the pixel offset, but the topmost visible message is still where you had
 * got to.
 *
 * The browser restores scroll itself on reload, and it does so *after* scripts run — so it silently
 * overrode this. scrollRestoration = 'manual' takes that away from it. The restore then runs twice,
 * once after layout and once after load, because late-arriving layout can move everything.
 */
history.scrollRestoration = 'manual';

const POS_KEY = 'tg-scroll-anchor';
let restoring = false;

function topmostVisible() {
  for (const r of rows) {
    if (r.classList.contains('hidden')) continue;
    if (r.getBoundingClientRect().bottom > 90) return r;
  }
  return null;
}

let posTimer = null;
addEventListener('scroll', () => {
  if (restoring) return;          // never record the position the restore itself lands on
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    const r = topmostVisible();
    if (r) localStorage.setItem(POS_KEY, r.dataset.id);
  }, 150);
}, { passive: true });

function restorePosition(flash) {
  const id = localStorage.getItem(POS_KEY);
  if (!id) return;
  const target = rows.find(r => r.dataset.id === id);
  if (!target || target.classList.contains('hidden')) return;

  restoring = true;
  const y = target.getBoundingClientRect().top + scrollY - 76;   // clear of the sticky toolbar
  scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  setTimeout(() => { restoring = false; }, 120);

  if (flash) {
    target.style.transition = 'outline-color .8s ease';
    target.style.outline = '2px solid var(--accent)';
    setTimeout(() => { target.style.outlineColor = 'transparent'; }, 1000);
  }
}

count();
apply();
requestAnimationFrame(() => restorePosition(true));
addEventListener('load', () => restorePosition(false));
"""


def telegram_rows(chat: str, messages: list, held: set) -> list:
    rows = []
    for msg in messages:
        v = verdict(msg, held)
        when = (msg.get("date") or "")[:16].replace("T", " ")
        plain = plain_text(msg)
        extra = []
        if media_of(msg):
            extra.append(media_of(msg))
        if msg.get("forwarded_from"):
            extra.append(f'forwarded from {msg["forwarded_from"]}')
        rows.append({
            "id": f"tg:{msg.get('id')}", "ref": str(msg.get("id")), "source": "telegram", "threads": [chat],
            "senders": [], "accounts": [], "when": when, "verdict": v,
            "body": render_text(msg) or "<i>(no text)</i>", "long": len(plain) > CLAMP_AT, "extra": extra,
            "number": f"#{msg.get('id')}",
        })
    return rows


def link_rows(records: list, held: set) -> list:
    """One row per link of Instagram, X or the phone: held or not, and nothing else it could carry."""
    e = html.escape
    rows = []
    for r in records:
        v = "migrated" if in_link_keeper(r["url"], held) else "uncaptured"
        head = " — ".join(x for x in (r.get("author"), r.get("title")) if x)
        body = (f'<span class="ttl">{e(head)}</span>' if head else "") + (e(r["text"]) if r.get("text") else "")
        body += f'<a class="url" href="{e(r["url"])}" target="_blank" rel="noopener noreferrer">{e(r["url"])}</a>'
        extra = []
        if r.get("accounts"):
            extra.append("account " + ", ".join(r["accounts"]))
        if r.get("senders"):
            extra.append("sent by " + ", ".join(r["senders"]))
        key = ls.identity(r["url"])
        rows.append({
            "id": f"{r['source'][:2]}:" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10], "ref": r["url"],
            "source": r["source"], "threads": r["threads"], "senders": r["senders"], "accounts": r["accounts"],
            "when": r["date"], "verdict": v, "body": body, "long": len(r.get("text") or "") > CLAMP_AT,
            "extra": extra, "number": "",
        })
    return rows


def row_html(r: dict, seq: int) -> str:
    e = html.escape
    src = r["source"]
    threads = r["threads"] or []
    head = [f'<span class="v {r["verdict"]}">{e(LABEL[r["verdict"]])}</span>',
            f'<span class="src {src}">{e(ls.SOURCE_LABEL[src])}</span>']
    if threads:
        head.append(f'<span class="thr">{e(", ".join(threads))}</span>')
    head.append(f'<span>{e(r["when"])}</span>')
    if r["number"]:
        head.append(f'<span>{e(r["number"])}</span>')
    head += [f"<span>{e(x)}</span>" for x in r["extra"]]
    return (
        f'<div class="msg v-{r["verdict"]}" data-id="{e(r["id"])}" data-ref="{e(r["ref"])}" data-verdict="{r["verdict"]}" '
        f'data-source="{src}" data-srclabel="{e(ls.SOURCE_LABEL[src])}" data-srcorder="{[k for k, _ in ls.SOURCES].index(src)}" '
        f'data-threads="{e("|".join(threads))}" data-thread1="{e(threads[0] if threads else "")}" '
        f'data-seq="{seq}" data-date="{e(r["when"])}">'
        f'<button class="state" title="click to cycle: unmarked → to delete → deleted">·</button>'
        f'<div><div class="head">{"".join(head)}</div>'
        f'<div class="body{" clamp" if r["long"] else ""}">{r["body"]}</div>'
        + ('<button class="more">more</button>' if r["long"] else "")
        + "</div></div>"
    )


def build(args: argparse.Namespace) -> tuple:
    """(rows, held, basis, why the add-on was not read, the inputs) for the page as it would be drawn now."""
    inp = ls.Inputs(args)
    chat, messages = ls.read_telegram(inp.telegram)
    held, basis, why = ls.held_keys(inp.captures)
    rows = []
    rows += telegram_rows(chat, messages, held)
    rows += link_rows(ls.read_dm_captures(inp.instagram, "instagram"), held)
    rows += link_rows(ls.read_dm_captures(inp.x, "x"), held)
    rows += link_rows(ls.read_phone_inbox(inp.inbox), held)
    # Newest first; ties keep the order they were read in.
    rows.sort(key=lambda r: r["when"], reverse=True)
    return rows, held, basis, why, inp


def main() -> int:
    args = parse_args()
    if args.export and not args.export.is_file():
        print(f"no such file: {args.export}", file=sys.stderr)
        return 1

    rows, held, basis, why, inp = build(args)
    if not rows:
        print("nothing to show: no Telegram export, no Instagram or X link records, no phone inbox", file=sys.stderr)
        return 1

    out = args.output or ls.data_dir() / "safe-to-delete.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    fp = ls.fingerprint_path(out, args.fingerprint)
    # What the page shows, plus which kind of basis it says it has used, plus the code that draws it.
    digest = ls.digest_of([[{k: v for k, v in r.items()} for r in rows], basis, bool(why),
                           ls.code_digest(Path(__file__))])
    if args.only_if_changed and ls.unchanged(out, fp, digest):
        print(f"safe-to-delete page: skipped, nothing changed since its last build ({len(rows)} rows)")
        return 0

    e = html.escape
    counts: Counter = Counter(r["verdict"] for r in rows)
    by_source: Counter = Counter(r["source"] for r in rows)
    body_rows = "\n".join(row_html(r, len(rows) - i) for i, r in enumerate(rows))

    vchips = [("all", "all")]
    for v, text in (("migrated", "safe"), ("yournote", "+ note"), ("uncaptured", "not in Link Keeper"),
                    ("note", "notes"), ("media", "media")):
        if counts[v] or v in ("migrated", "uncaptured"):
            vchips.append((v, text))
    vchip_html = "\n  ".join(
        f'<button class="chip" data-vchip="{v}" data-label="{e(t)}" aria-pressed="{"true" if v == "all" else "false"}">{e(t)} {counts[v] if v != "all" else len(rows)}</button>'
        for v, t in vchips)
    schips = [("all", f"every source {len(rows)}")] + [
        (k, f"{n} {by_source[k]}") for k, n in ls.SOURCES if by_source[k]]
    schip_html = "\n  ".join(
        f'<button class="chip" data-schip="{k}" aria-pressed="{"true" if k == "all" else "false"}">{e(t)}</button>'
        for k, t in schips)

    source_list = ", ".join(f"{label} {by_source[k]}" for k, label in ls.SOURCES if by_source[k])
    basis_html = (
        f'<p class="basis fallback">Safe means present in {e(basis)}. Link Keeper itself could not be read '
        f'({e(why)}), so this is the import\'s file, which holds every link the import found whether or not the '
        f'extension has taken it in yet.</p>' if why else
        f'<p class="basis">Safe means Link Keeper holds the link: read from {e(basis)}, {len(held)} keys.</p>')
    media_warn = (
        " <b>media</b> is the dangerous one: that Telegram export ran with media unchecked, so no photo, file "
        "or voice message was ever downloaded and no copy of them exists anywhere but Telegram."
        if counts["media"] else "")
    note_warn = (" The Telegram messages marked <b>+ note</b>, <b>notes</b> and <b>media</b> contain something "
                 "that was never migrated." if (counts["yournote"] or counts["note"] or counts["media"]) else "")

    out.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Safe to delete — {len(rows)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
<h1>Safe to delete: {len(rows)} saved messages and links</h1>
<p class="sub"><b id="n-shown">{len(rows)}</b> shown · from {e(source_list)}</p>
{basis_html}
<p class="warn"><b>Read before deleting.</b> Only <b>safe</b> can go: every link in it is in Link Keeper and
it holds nothing else. <b>Not in Link Keeper</b> means deleting it loses the link.{note_warn}{media_warn}</p>

<details class="marks"><summary>Marks are remembered in this browser, per file name</summary>
  <p>Moved from another page or browser? Copy the marks there and paste them here; marks already set are kept.
  From the old <code>saved-messages.html</code>, run <code>copy(localStorage['tg-states'])</code> in its console.</p>
  <button class="act" id="copy-marks">copy marks</button> <button class="act" id="paste-marks">paste marks</button>
  <span id="marks-hint"></span>
</details>

<div class="bar">
  <input id="q" type="search" placeholder="Search…" autocomplete="off">
  {vchip_html}
  <span class="sep"></span>
  {schip_html}
  <select id="thread" title="Only one thread of the chosen source" hidden></select>
  <select id="view" title="Order and grouping">
    <option value="newest">newest first</option>
    <option value="oldest">oldest first</option>
    <option value="source">by source and thread</option>
  </select>
  <button class="act" id="ticked" data-mode="all" title="Filter by mark: all → unmarked → to delete → deleted">show: all</button>
</div>

{body_rows}

<pre id="ids" class="hidden"></pre>
</div>
<div id="out">
  <span><b id="n-ticked">0</b> to delete · <b id="n-deleted">0</b> deleted</span>
  <button class="act go" id="show-ids">list the to-delete &amp; copy refs</button>
  <span style="color:var(--dim)">Click a badge to cycle <b>·</b> → <b>✓</b> → <b>✕</b>.</span>
</div>
<script>{JS}</script>
</body></html>
""", encoding="utf-8")
    ls.remember(fp, digest)

    print(f"{len(rows)} rows → {out}  (safe means: {basis}{'; add-on not read: ' + why if why else ''})")
    for k, label in ls.SOURCES:
        if by_source[k]:
            print(f"  {by_source[k]:>4}  {label}")
    for k in VERDICTS:
        if counts[k]:
            print(f"  {counts[k]:>4}  {LABEL[k]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
