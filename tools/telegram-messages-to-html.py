#!/usr/bin/env python3
# DESC: Render a Telegram chat export as a scrollable page, marking which messages migration made redundant.
"""Browse a Telegram export and see what is safe to delete.

Once the links from a Saved Messages chat have been migrated into Link Keeper, some of those messages
are pure duplication and some are not. This renders every message with a verdict on which is which,
plus a tick box per message and a list of what you ticked.

The verdicts, from safest to least:

  migrated      every link in it is captured, and the message carries nothing else — no note of your
                own, no media. Deleting it loses nothing.
  your note     links are captured, but you also typed something. The note was never migrated.
  not captured  it has a link that nothing resolved. Deleting it loses the link.
  note only     no link at all. Your own writing — code, reminders, drafts. Never migrated.
  media         a photo, file or voice message. **Exported with media unchecked, so these were never
                downloaded and no copy exists anywhere.**

Nothing here deletes anything; Telegram has no API for that from a static page. The output is a list
you act on yourself.

Usage:
    ./telegram-messages-to-html.py result.json -c captures.jsonl -o messages.html
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

# Text that is really just the link again, not a note worth keeping.
TRIVIAL = re.compile(r"^[\s\-–—:•>*•]*$")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render a Telegram export, flagging messages migration made redundant.")
    p.add_argument("export", type=Path, help="the export's result.json")
    p.add_argument("-c", "--captures", type=Path, help="capture JSONL, to know which links were resolved")
    p.add_argument("-o", "--output", type=Path, help="output path (default ./YYYY-MM-DD-saved-messages.html)")
    return p.parse_args()


def match_keys(url: str) -> list[str]:
    """Same normalisation the extension uses, so 'captured' means the same thing on both sides."""
    bits = urlsplit(url)
    host = bits.netloc.lower().removeprefix("www.")
    path = bits.path.rstrip("/")
    keys = [f"{host}{path}?{bits.query}" if bits.query else f"{host}{path}"]
    if host in {"x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"}:
        m = re.search(r"/status/(\d+)", path)
        if m:
            keys.append("status:" + m.group(1))
    return keys


def load_captured(path: Path | None) -> set[str]:
    if not path or not path.is_file():
        return set()
    keys: set[str] = set()
    for line in path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        for u in (rec.get("url"), rec.get("source_url")):
            if u:
                keys.update(match_keys(u))
    return keys


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


def links_of(msg: dict) -> list[str]:
    return [e.get("text", "") for e in (msg.get("text_entities") or []) if e.get("type") == "link"]


def media_of(msg: dict) -> str | None:
    if msg.get("media_type") == "voice_message":
        return "voice message"
    if msg.get("media_type"):
        return msg["media_type"].replace("_", " ")
    if msg.get("photo"):
        return "photo"
    if msg.get("file"):
        return f"file · {msg.get('file_name') or 'unnamed'}"
    return None


def verdict(msg: dict, captured: set[str]) -> str:
    if media_of(msg):
        return "media"
    links = links_of(msg)
    if not links:
        return "note"
    text = plain_text(msg)
    for link in links:
        text = text.replace(link, " ")
    note_left = not TRIVIAL.match(text)
    unresolved = [l for l in links if not any(k in captured for k in match_keys(l))]
    if unresolved:
        return "uncaptured"
    return "yournote" if note_left else "migrated"


LABEL = {
    "migrated": "migrated — safe to delete",
    "yournote": "captured, but you wrote a note",
    "uncaptured": "link not captured",
    "note": "your note — never migrated",
    "media": "media — never exported",
}

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
#sort{min-width:8.5rem}
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
pre#ids{max-height:12rem;overflow:auto;background:var(--chip);border-radius:.4rem;padding:.6rem;
  font-size:.8rem;white-space:pre-wrap;margin:.6rem 0 0}
"""

JS = r"""
const KEY = 'tg-states';
const OLD_KEY = 'tg-delete-ticks';
const rows = [...document.querySelectorAll('.msg')];
const q = document.getElementById('q');
let filter = 'all';

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
  for (const r of rows) {
    const st = stateOf(r);
    const tickOk = tickMode === 'all' || tickMode === st;
    const hit = tickOk
      && (filter === 'all' || r.dataset.verdict === filter)
      && (!term || r.dataset.hay.includes(term));
    r.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  document.getElementById('n-shown').textContent = shown;
}

for (const f of ['all', 'migrated', 'yournote', 'uncaptured', 'note', 'media']) {
  document.getElementById('f-' + f).onclick = () => {
    filter = f;
    for (const o of ['all', 'migrated', 'yournote', 'uncaptured', 'note', 'media'])
      document.getElementById('f-' + o).setAttribute('aria-pressed', String(o === f));
    apply();
  };
}
q.addEventListener('input', apply);

/* Message ids increase with time, so they order the chat without parsing dates. Reordering moves the
 * existing nodes rather than rebuilding them, so tick state and expanded bodies survive. */
const container = rows[0]?.parentNode;
const sortBtn = document.getElementById('sort');
sortBtn.onclick = () => {
  const oldest = sortBtn.dataset.dir !== 'oldest';
  sortBtn.dataset.dir = oldest ? 'oldest' : 'newest';
  sortBtn.textContent = oldest ? 'oldest first ↑' : 'newest first ↓';
  const dir = oldest ? 1 : -1;
  const anchor = document.getElementById('ids');
  [...rows]
    .sort((a, b) => dir * ((+a.dataset.id || 0) - (+b.dataset.id || 0)))
    .forEach(r => container.insertBefore(r, anchor));
  localStorage.setItem('tg-sort', sortBtn.dataset.dir);
};

// Remember which way round it was left.
if (localStorage.getItem('tg-sort') === 'oldest') sortBtn.click();

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
  const lines = picked.map(r => `${r.dataset.id}\t${r.dataset.date}\t${(r.dataset.hay || '').slice(0, 70)}`);
  const box = document.getElementById('ids');
  box.textContent = lines.join('\n') || 'nothing ticked';
  box.classList.remove('hidden');
  navigator.clipboard.writeText(picked.map(r => r.dataset.id).join('\n')).catch(() => {});
};

/* Remember where you were, by message rather than by pixel: a filter change, a re-sort or a
 * regenerated file all move the pixel offset, but the topmost visible message is still the place you
 * had got to. Restored after the first layout so the offsets are real.
 */
const POS_KEY = 'tg-scroll-anchor';

function topmostVisible() {
  for (const r of rows) {
    if (r.classList.contains('hidden')) continue;
    if (r.getBoundingClientRect().bottom > 80) return r;
  }
  return null;
}

let posTimer = null;
addEventListener('scroll', () => {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    const r = topmostVisible();
    if (r) localStorage.setItem(POS_KEY, r.dataset.id);
  }, 150);
}, { passive: true });

function restorePosition() {
  const id = localStorage.getItem(POS_KEY);
  if (!id) return;
  const target = rows.find(r => r.dataset.id === id);
  if (!target || target.classList.contains('hidden')) return;
  // Leave the sticky toolbar clear of it.
  const y = target.getBoundingClientRect().top + scrollY - 72;
  scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  target.style.transition = 'outline-color .8s ease';
  target.style.outline = '2px solid var(--accent)';
  setTimeout(() => { target.style.outlineColor = 'transparent'; }, 900);
}

count();
apply();
requestAnimationFrame(restorePosition);
"""


def main() -> int:
    args = parse_args()
    if not args.export.is_file():
        print(f"no such file: {args.export}", file=sys.stderr)
        return 1

    data = json.loads(args.export.read_text(encoding="utf-8"))
    msgs = data.get("messages") or []
    captured = load_captured(args.captures)

    rows = []
    counts: Counter[str] = Counter()
    for msg in sorted(msgs, key=lambda m: m.get("date") or "", reverse=True):
        v = verdict(msg, captured)
        counts[v] += 1
        when = (msg.get("date") or "")[:16].replace("T", " ")
        body = render_text(msg) or "<i>(no text)</i>"
        media = media_of(msg)
        long_body = len(plain_text(msg)) > 700

        head = [f'<span class="v {v}">{html.escape(LABEL[v])}</span>', f"<span>{html.escape(when)}</span>",
                f'<span>#{msg.get("id")}</span>']
        if media:
            head.append(f'<span>{html.escape(media)}</span>')
        if msg.get("forwarded_from"):
            head.append(f'<span>forwarded from {html.escape(str(msg["forwarded_from"]))}</span>')

        rows.append(
            f'<div class="msg v-{v}" data-id="{msg.get("id")}" data-verdict="{v}" data-date="{html.escape(when)}">'
            f'<button class="state" title="click to cycle: unmarked → to delete → deleted">·</button>'
            f'<div><div class="head">{"".join(head)}</div>'
            f'<div class="body{" clamp" if long_body else ""}">{body}</div>'
            + ('<button class="more">more</button>' if long_body else "")
            + "</div></div>"
        )

    out = args.output or Path.cwd() / f"{date.today().isoformat()}-saved-messages.html"
    out.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saved messages — {len(msgs)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
<h1>{len(msgs)} saved messages</h1>
<p class="sub"><b id="n-shown">{len(msgs)}</b> shown · newest first · from
<code>{html.escape(args.export.name)}</code>{f" · checked against {len(captured)} capture keys" if captured else ""}</p>

<p class="warn"><b>Read before deleting.</b> Only <b>migrated</b> is safe: every link in it is
captured and the message holds nothing else. The other four all contain something that was never
migrated. <b>media</b> is the dangerous one — that export ran with media unchecked, so no photo, file
or voice message was ever downloaded and no copy of them exists anywhere but Telegram.</p>

<div class="bar">
  <input id="q" type="search" placeholder="Search the messages…" autocomplete="off">
  <button class="chip" id="f-all" aria-pressed="true">all {len(msgs)}</button>
  <button class="chip" id="f-migrated">safe {counts['migrated']}</button>
  <button class="chip" id="f-yournote">+ note {counts['yournote']}</button>
  <button class="chip" id="f-uncaptured">not captured {counts['uncaptured']}</button>
  <button class="chip" id="f-note">notes {counts['note']}</button>
  <button class="chip" id="f-media">media {counts['media']}</button>
  <button class="act" id="sort" data-dir="newest" title="Flip the order">newest first ↓</button>
  <button class="act" id="ticked" data-mode="all" title="Filter by mark: all → unmarked → to delete → deleted">show: all</button>
</div>

{chr(10).join(rows)}

<pre id="ids" class="hidden"></pre>
</div>
<div id="out">
  <span><b id="n-ticked">0</b> to delete · <b id="n-deleted">0</b> deleted</span>
  <button class="act go" id="show-ids">list the to-delete &amp; copy IDs</button>
  <span style="color:var(--dim)">Click a message's badge to cycle <b>·</b> → <b>✓</b> → <b>✕</b>.
  Marks are remembered in this browser.</span>
</div>
<script>{JS}</script>
</body></html>
""", encoding="utf-8")

    print(f"{len(msgs)} messages → {out}")
    for k in ("migrated", "yournote", "uncaptured", "note", "media"):
        print(f"  {counts[k]:>4}  {LABEL[k]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
