#!/usr/bin/env python3
# DESC: Render a capture JSONL as one self-contained HTML page for browsing at a glance.
"""Turn capture records into a page you can scan.

Reads the JSONL that the extension exports or that `importers/enrich-x.py` produces, and writes a
single self-contained HTML file — no server, no build, no network except the image thumbnails, which
point at the original CDN rather than being embedded so the file stays small.

The sorting that matters is by what still needs doing. Every card lands in one of three buckets:

  needs a look   no link in the post, but it names a repo or tool, or points at its own replies.
                 The thing you saved it for is not in the payload.
  has a link     the destination came through. Nothing further to do.
  self-contained no link and none implied — the post itself is the content.

Usage:
    ./captures-to-html.py captures.jsonl -o page.html
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

NAMES_CODE = re.compile(
    r"\b(github|repo|repository|open.?sourced?|source code|npm|pip install|cli|library|"
    r"free|tool|app|extension|plugin)\b", re.I)
POINTS_AT_REPLIES = re.compile(
    r"\b(in|below|check|see)\s+(the\s+)?(repl(y|ies)|comments?|thread)\b"
    r"|\b(link|repo|code|source|github)\s+(is\s+)?(in|below|👇)|👇|🧵", re.I)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Render capture JSONL as one browsable HTML page.")
    p.add_argument("captures", type=Path, help="JSONL of capture records")
    p.add_argument("-o", "--output", type=Path,
                   help="output path (default ./YYYY-MM-DD-captures.html)")
    return p.parse_args()


def bucket(rec: dict) -> str:
    if rec.get("links") or rec.get("reply_links"):
        return "linked"
    text = rec.get("text") or ""
    if rec.get("needs_replies") or POINTS_AT_REPLIES.search(text) or NAMES_CODE.search(text):
        return "look"
    return "self"


def load(path: Path) -> list[dict]:
    out = []
    # split("\n") rather than splitlines(): the latter also breaks on U+2028/U+2029, which appear
    # raw inside tweet text and would tear a record in two.
    for lineno, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"skipping malformed line {lineno}", file=sys.stderr)
    return out


CSS = """
:root {
  --bg:#fbfaf8; --card:#fff; --ink:#1a1a1a; --dim:#6b6b6b; --line:#e4e0da; --accent:#7a5cff;
  --chip:#f1eee9; --look:#c2422f; --look-bg:#fbe9e5; --linked:#17915c; --linked-bg:#e4f5ec;
  --shadow:0 1px 2px rgba(0,0,0,.05), 0 4px 14px rgba(0,0,0,.05);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#15161a; --card:#1e2126; --ink:#e8e6e3; --dim:#9a9793; --line:#2c2f34; --accent:#a992ff;
    --chip:#282c33; --look:#ff8b74; --look-bg:#33191a; --linked:#4fcf95; --linked-bg:#17301f;
    --shadow:0 1px 2px rgba(0,0,0,.3), 0 6px 18px rgba(0,0,0,.35);
  }
}
*{box-sizing:border-box}
body{margin:0;padding:1.75rem 1.25rem 5rem;background:var(--bg);color:var(--ink);
  font:14px/1.5 ui-sans-serif,-apple-system,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:96rem;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .2rem;letter-spacing:-.02em}
.sub{color:var(--dim);margin:0 0 1.2rem;font-size:.88rem}
.bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;position:sticky;top:0;z-index:9;
  background:var(--bg);padding:.75rem 0;margin-bottom:1.2rem;border-bottom:1px solid var(--line)}
#q{flex:1 1 18rem;padding:.5rem .8rem;font:inherit;color:var(--ink);background:var(--card);
  border:1px solid var(--line);border-radius:.5rem}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
.chip{border:1px solid var(--line);background:var(--card);color:var(--dim);border-radius:1rem;
  padding:.35rem .8rem;font-size:.82rem;cursor:pointer;font-variant-numeric:tabular-nums}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
select{font:inherit;font-size:.85rem;padding:.4rem .6rem;background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(21rem,1fr));gap:.9rem;align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:.7rem;box-shadow:var(--shadow);
  padding:.85rem .9rem;display:flex;flex-direction:column;gap:.5rem;overflow:hidden}
.card.look{border-left:3px solid var(--look)}
.card.linked{border-left:3px solid var(--linked)}
.top{display:flex;gap:.5rem;align-items:baseline}
.who{font-weight:650}
.who a{color:inherit;text-decoration:none}
.who a:hover{color:var(--accent)}
.when{color:var(--dim);font-size:.76rem;font-variant-numeric:tabular-nums;margin-left:auto;white-space:nowrap}
.title{font-weight:600;font-size:.95rem}
.text{font-size:.87rem;white-space:pre-wrap;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}
.card.open .text{-webkit-line-clamp:unset;display:block}
.more{align-self:flex-start;background:none;border:0;color:var(--accent);font:inherit;font-size:.78rem;
  cursor:pointer;padding:0}
.links{display:flex;flex-wrap:wrap;gap:.3rem}
.links a{font-size:.78rem;color:#fff;background:var(--linked);text-decoration:none;border-radius:1rem;
  padding:.15rem .55rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.links.replies a{background:transparent;border:1px dashed var(--line);color:var(--dim)}
.links.replies a.from-author{border-style:solid;border-color:var(--linked);color:var(--linked)}
.shots{display:flex;gap:.3rem;flex-wrap:wrap}
.shots img{height:5rem;max-width:100%;object-fit:cover;border-radius:.35rem;border:1px solid var(--line);background:var(--chip)}
.acts{display:flex;gap:.35rem;align-items:center}
.acts .go{font-size:.78rem;text-decoration:none;color:var(--accent);border:1px solid var(--line);
  border-radius:.4rem;padding:.25rem .6rem}
.acts .go:hover{border-color:var(--accent)}
.acts .copy{font:inherit;font-size:.78rem;cursor:pointer;background:var(--card);color:var(--dim);
  border:1px solid var(--line);border-radius:.4rem;padding:.25rem .6rem}
.acts .copy:hover{border-color:var(--accent);color:var(--ink)}
.meta{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;font-size:.74rem;color:var(--dim);margin-top:auto}
.tag{background:var(--chip);border-radius:1rem;padding:.1rem .5rem}
.tag.look{background:var(--look-bg);color:var(--look);font-weight:600}
.tag.art{background:var(--accent);color:#fff}
.hidden{display:none!important}
.empty{grid-column:1/-1;text-align:center;padding:4rem;color:var(--dim);border:1px dashed var(--line);border-radius:.8rem}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.8rem}
code{background:var(--chip);padding:0 .25rem;border-radius:.2rem}
"""

JS = r"""
const cards = [...document.querySelectorAll('.card')];
const q = document.getElementById('q');
let bucket = 'all';

cards.forEach(c => {
  c.dataset.hay = c.textContent.toLowerCase();
  const more = c.querySelector('.more');
  if (more) more.onclick = () => {
    c.classList.toggle('open');
    more.textContent = c.classList.contains('open') ? 'less' : 'more';
  };
});

function apply() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const c of cards) {
    const hit = (bucket === 'all' || c.dataset.bucket === bucket)
      && (!term || c.dataset.hay.includes(term));
    c.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  document.getElementById('shown').textContent = shown;
  document.getElementById('none').classList.toggle('hidden', shown > 0);
}

for (const b of ['all', 'look', 'linked', 'self']) {
  document.getElementById('f-' + b).onclick = () => {
    bucket = b;
    for (const o of ['all', 'look', 'linked', 'self'])
      document.getElementById('f-' + o).setAttribute('aria-pressed', String(o === b));
    apply();
  };
}

document.getElementById('sort').onchange = e => {
  const grid = document.getElementById('grid');
  const key = e.target.value;
  const sorted = [...cards].sort((a, b) => {
    if (key === 'oldest') return (a.dataset.date || '').localeCompare(b.dataset.date || '');
    if (key === 'replies') return (+b.dataset.replies || 0) - (+a.dataset.replies || 0);
    if (key === 'author') return (a.dataset.author || '').localeCompare(b.dataset.author || '');
    return (b.dataset.date || '').localeCompare(a.dataset.date || '');
  });
  for (const c of sorted) grid.append(c);
};

for (const b of document.querySelectorAll('.copy')) {
  b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.url);
    const was = b.textContent; b.textContent = 'copied';
    setTimeout(() => (b.textContent = was), 1200);
  };
}

/* The handoff into the extension: filter to a bucket, copy the set, paste into Add links. */
document.getElementById('copy-shown').onclick = async () => {
  const urls = cards.filter(c => !c.classList.contains('hidden'))
    .map(c => c.querySelector('.acts .go').href);
  const btn = document.getElementById('copy-shown');
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    btn.textContent = `copied ${urls.length}`;
  } catch (e) {
    btn.textContent = 'clipboard blocked';
  }
  setTimeout(() => (btn.textContent = 'copy shown URLs'), 1600);
};

q.addEventListener('input', apply);
apply();
"""


def card_html(rec: dict) -> str:
    e = html.escape
    b = bucket(rec)
    author = rec.get("author") or {}
    handle = author.get("handle") or ""
    name = author.get("name") or ""
    url = rec.get("url") or ""
    posted = (rec.get("posted") or "")
    saved = (rec.get("saved_at") or "")[:10]
    text = rec.get("text") or ""
    title = rec.get("title") or ""
    is_article = rec.get("kind") == "x-article"

    bits = [f'<div class="card {b}" data-bucket="{b}" data-date="{e(saved)}"'
            f' data-replies="{rec.get("replies") or 0}" data-author="{e(handle)}">']

    bits.append('<div class="top">')
    who = e(handle) if handle else e(url[:40])
    bits.append(f'<span class="who"><a href="{e(url)}" target="_blank" rel="noopener noreferrer">{who}</a></span>')
    if name and name != handle.lstrip("@"):
        bits.append(f'<span style="color:var(--dim);font-size:.78rem">{e(name)}</span>')
    if saved:
        bits.append(f'<span class="when">saved {e(saved)}</span>')
    bits.append("</div>")

    if is_article and title:
        bits.append(f'<div class="title">{e(title)}</div>')

    if text:
        bits.append(f'<div class="text">{e(text)}</div>')
        if len(text) > 320:
            bits.append('<button class="more">more</button>')

    if rec.get("links"):
        bits.append('<div class="links">')
        for link in rec["links"][:6]:
            href = link.get("resolved") or link.get("href") or ""
            label = re.sub(r"^https?://(www\.)?", "", href)[:44]
            bits.append(f'<a href="{e(href)}" target="_blank" rel="noopener noreferrer">{e(label)}</a>')
        bits.append("</div>")

    if rec.get("reply_links"):
        bits.append('<div class="links replies">')
        for link in rec["reply_links"][:6]:
            href = link.get("resolved") or link.get("href") or ""
            label = re.sub(r"^https?://(www\.)?", "", href)[:40]
            who = link.get("from") or "?"
            cls = " from-author" if link.get("self") else ""
            bits.append(f'<a class="reply{cls}" href="{e(href)}" target="_blank" rel="noopener noreferrer"'
                        f' title="from a reply by {e(who)}">↩ {e(label)}</a>')
        bits.append("</div>")

    pics = [u for u in (rec.get("images") or []) if u.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".webp"))]
    if pics:
        bits.append('<div class="shots">')
        for src in pics[:3]:
            bits.append(f'<a href="{e(src)}" target="_blank" rel="noopener noreferrer">'
                        f'<img src="{e(src)}" loading="lazy" alt=""></a>')
        bits.append("</div>")

    bits.append('<div class="acts">')
    bits.append(f'<a class="go" href="{e(url)}" target="_blank" rel="noopener noreferrer">open post ↗</a>')
    bits.append(f'<button class="copy" data-url="{e(url)}">copy url</button>')
    bits.append("</div>")

    bits.append('<div class="meta">')
    if b == "look":
        bits.append('<span class="tag look">needs a look</span>')
    if is_article:
        bits.append('<span class="tag art">article</span>')
    if rec.get("code_blocks"):
        bits.append(f'<span class="tag">{len(rec["code_blocks"])} code</span>')
    if rec.get("replies"):
        bits.append(f'<span class="tag">{rec["replies"]} replies</span>')
    if (rec.get("media") or []):
        bits.append(f'<span class="tag">{e(", ".join(rec["media"]))}</span>')
    if posted:
        bits.append(f'<span>{e(posted[:16])}</span>')
    bits.append("</div></div>")
    return "\n".join(bits)


def main() -> int:
    args = parse_args()
    if not args.captures.is_file():
        print(f"no such file: {args.captures}", file=sys.stderr)
        return 1

    recs = load(args.captures)
    if not recs:
        print("no records", file=sys.stderr)
        return 1

    recs.sort(key=lambda r: (r.get("saved_at") or ""), reverse=True)
    buckets = Counter(bucket(r) for r in recs)
    handles = len({(r.get("author") or {}).get("handle") for r in recs})
    with_links = sum(len(r.get("links") or []) for r in recs)

    out = args.output or Path.cwd() / f"{date.today().isoformat()}-captures.html"
    cards = "\n".join(card_html(r) for r in recs)

    out.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Captures — {len(recs)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
<h1>{len(recs)} captures</h1>
<p class="sub"><b id="shown">{len(recs)}</b> shown · {handles} accounts · {with_links} links recovered ·
generated {date.today().isoformat()} from <code>{html.escape(args.captures.name)}</code></p>

<div class="bar">
  <input id="q" type="search" placeholder="Filter by text, handle, link…" autocomplete="off" spellcheck="false">
  <button class="chip" id="f-all" aria-pressed="true">all {len(recs)}</button>
  <button class="chip" id="f-look">needs a look {buckets.get('look', 0)}</button>
  <button class="chip" id="f-linked">has a link {buckets.get('linked', 0)}</button>
  <button class="chip" id="f-self">self-contained {buckets.get('self', 0)}</button>
  <button class="chip" id="copy-shown" title="Copy the URLs of every card currently shown">copy shown URLs</button>
  <select id="sort">
    <option value="newest">newest saved</option>
    <option value="oldest">oldest saved</option>
    <option value="replies">most replies</option>
    <option value="author">by account</option>
  </select>
</div>

<div class="grid" id="grid">
{cards}
<div class="empty hidden" id="none">Nothing matches.</div>
</div>

<footer>
<b>needs a look</b> — no link in the post, but it names a tool or points at its own replies, so the
thing you saved it for is not in the data. Those are the ones to open in the browser.<br>
<b>has a link</b> — the destination came through; nothing further to do.
<b>self-contained</b> — no link and none implied; the post is the content.<br>
Thumbnails load from Twitter's CDN, so images need a connection. Generated by
<code>tools/captures-to-html.py</code>.
</footer>
</div>
<script>{JS}</script>
</body></html>
""", encoding="utf-8")

    print(f"{len(recs)} captures → {out}")
    for name, label in [("look", "needs a look"), ("linked", "has a link"), ("self", "self-contained")]:
        print(f"  {buckets.get(name, 0):>4}  {label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
