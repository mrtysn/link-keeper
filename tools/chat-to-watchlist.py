#!/usr/bin/env python3
# DESC: Turn a chat export of film links into one browsable watchlist page with IMDb, Metacritic and RT scores.
"""Read a Telegram chat export and render every film and series in it as an HTML page.

A "maybe watch" chat is a pile of bare `imdb.com/title/tt…` links, typed names, and links to
places that are not IMDb at all. None of those carry a title, a poster or a score, so the page
resolves each one:

  imdb link  →  IMDb's own suggestion endpoint, by id — exact, no guessing
  typed name →  the same endpoint as a search; the top hit, marked `verify` on the card
  other link →  nothing automatic. Name the title in the overrides file (see below).

Scores come from three places, none of which needs a login or a key of yours: IMDb's public
GraphQL endpoint for the user rating, Metacritic's search API using the key metacritic.com
embeds in its own pages, and Rotten Tomatoes' search page for the tomatometer. A score counts
only when the title matches, the type matches (film or series) and the year is within one of
IMDb's, so a series gets its series score rather than a same-named film's.

Posters are inlined as base64, so the page is one file that works offline.

## The overrides file

Everything specific to one chat lives in a JSON file, never in this script:

    {
      "title":    "Maybe Watch",
      "skip":     ["chatter that is not a title"],
      "imdb":     {"ghost": "tt0099653"},
      "query":    {"netflix.com/title/81083590": "home for christmas",
                   "DRzh2VIjCf5": "good fortune"},
      "carousel": {"DWrDNdiDUNC": {"slides": ["rooster", "paradise 2025"], "linked": 6}}
    }

  skip      messages to drop whole, matched exactly — replies, jokes, anything not a title
  imdb      message text → IMDb id, for when the top hit is the wrong one
  query     any substring of a message (a url, an instagram shortcode) → what to search for.
            This is how a link that IMDb cannot resolve becomes a card. An empty string keeps
            the message in the unidentified list instead of guessing a title for it.
  carousel  an instagram shortcode → one search per slide, and which slide the link opened on.
            `tools/watch-reel.zsh` saves those slides; read them to get the titles.

Usage:
    chat-to-watchlist.py result.json -o watchlist.html [--overrides chat.json]

Requires: nothing outside the standard library.
"""

import argparse
import base64
import concurrent.futures as cf
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "importers"))
from telegram_export import load_export, message_text  # noqa: E402

E = html.escape
UA = {'User-Agent': 'Mozilla/5.0'}
TIMEOUT = 30
# The key metacritic.com ships in its own pages — public, not an account credential.
MC_KEY = '1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u'
# IMDb's name for a title is not always the one a score site files it under. An alias is tried
# only after the real title finds nothing, since the sites disagree with each other too: RT has
# "12 Monkeys" where Metacritic has "Twelve Monkeys". Keyed by normalised title.
ALIAS = {'12monkeys': 'Twelve Monkeys', 'jurydutypresents': 'Jury Duty'}

norm = lambda x: re.sub(r'[^a-z0-9]', '', html.unescape(x).lower().replace('&', 'and'))


def get(url, headers=None, **kw):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})}, **kw)
    return urllib.request.urlopen(req, timeout=TIMEOUT).read()


# --- what the chat holds -------------------------------------------------------------------

def read_export(export, ov):
    """One entry per thing worth looking up: (date, who, kind, value, raw)."""
    d = load_export(export)
    skip, imdb, query, carousel = (ov.get('skip') or []), (ov.get('imdb') or {}), (ov.get('query') or {}), (ov.get('carousel') or {})
    items = []
    for m in d.get('messages', []):
        if m.get('type') != 'message':
            continue
        t = message_text(m).strip()
        if not t or t in skip:
            continue
        date, who = m['date'][:10], m.get('from', '')
        tt = re.search(r'imdb\.com/title/(tt\d+)', t)
        car = next((v for k, v in carousel.items() if k in t), None)
        if t.lower() in imdb:
            items.append((date, who, 'search', imdb[t.lower()], t))
        elif tt:
            items.append((date, who, 'id', tt.group(1), t))
        elif car:
            for n, q in enumerate(car['slides'], 2):
                linked = ' — the slide the link opened on' if n == car.get('linked') else ''
                items.append((date, who, 'search', q, f'carousel slide {n}{linked}'))
        elif any(k in t for k in query):
            q = next(v for k, v in query.items() if k in t)
            # An empty query says: keep the message, but it names no single title to look up.
            items.append((date, who, 'search' if q else 'note', q or t, t))
        elif 'http' in t:
            items.append((date, who, 'link', re.search(r'https?://\S+', t).group(0), t))
        else:
            items.append((date, who, 'search', t, t))
    return d.get('name', ''), items


# --- IMDb: which title is this, and what do people rate it ---------------------------------

def suggest(q):
    q2 = urllib.parse.quote(q.lower())
    r = json.loads(get(f'https://v3.sg.media-imdb.com/suggestion/{q2[0]}/{q2}.json'))
    return [x for x in r.get('d', []) if x.get('id', '').startswith('tt')]


def resolve(item):
    """An id resolves exactly; anything else is the top hit and says so on the card."""
    kind, val = item[2], item[3]
    try:
        if kind in ('link', 'note'):
            return item, None
        hits = suggest(val)
        if not hits:
            return item, None
        info = hits[0] if kind == 'id' else dict(hits[0], guessed=True)
        if info.get('i', {}).get('imageUrl'):
            poster = get(info['i']['imageUrl'].replace('._V1_.jpg', '._V1_UX220_.jpg'))
            info['poster'] = 'data:image/jpeg;base64,' + base64.b64encode(poster).decode()
    except Exception as e:
        print(f'  ! {val}: {e}', file=sys.stderr)
        return item, None
    return item, info


def imdb_ratings(ids):
    q = '{ titles(ids:[%s]) { id ratingsSummary { aggregateRating voteCount } } }' % ','.join(f'"{i}"' for i in ids)
    body = get('https://caching.graphql.imdb.com/', data=json.dumps({'query': q}).encode(),
               headers={**UA, 'Content-Type': 'application/json', 'x-imdb-client-name': 'imdb-web-next'})
    return {t['id']: t['ratingsSummary'] for t in json.loads(body)['data']['titles'] if t}


# --- critic scores ---------------------------------------------------------------------------

def pick(rows, title, year, tv):
    """The row that is this title: same name, same type, within a year of IMDb's."""
    t = norm(title)
    bare = lambda r: norm(re.sub(r'\s*\(\d{4}\)$', '', r['title']))
    rows = ([r for r in rows if bare(r) in (t, norm(ALIAS.get(t, '')))]
            or [r for r in rows if len(t) > 6 and t in bare(r)])
    # A site's year is its own release, which can trail IMDb's by more than a year on a foreign
    # or festival title — so an unambiguous name match outranks the year filter.
    if year:
        near = [r for r in rows if r['year'] and abs(r['year'] - year) <= 1]
        # An unambiguous name match survives a wider gap, but never a different decade's title.
        rows = near or ([r for r in rows if r['year'] and abs(r['year'] - year) <= 3][:1] if len(rows) == 1 else [])
    rows.sort(key=lambda r: (r['tv'] != tv, abs((r['year'] or 0) - (year or 0)), not r['score']))
    return rows[0] if rows else None


def metacritic(title, year, tv):
    d = json.loads(get(f'https://backend.metacritic.com/finder/metacritic/search/{urllib.parse.quote(title)}/web'
                       f'?apiKey={MC_KEY}&offset=0&limit=30'))
    rows = [{'title': x['title'], 'year': x.get('premiereYear'),
             'score': (x.get('criticScoreSummary') or {}).get('score'), 'tv': x['type'] == 'show',
             'url': f"https://www.metacritic.com/{'movie' if x['type'] == 'movie' else 'tv'}/{x['slug']}/"}
            for x in d['data']['items'] if x.get('type') in ('movie', 'show')]
    return pick(rows, title, year, tv)


def rotten(title, year, tv):
    page = get('https://www.rottentomatoes.com/search?search=' + urllib.parse.quote(title)).decode()
    rows = []
    for m in re.finditer(r'<search-page-media-row(.*?)</search-page-media-row>', page, re.S):
        b = m.group(1)
        # Film rows spell the attributes with hyphens, series rows without: release-year / releaseyear.
        attr = lambda k: (re.search(k.replace('-', '-?') + r'="([^"]*)"', b) or [None, ''])[1]
        link = re.search(r'href="([^"]+)"[^>]*slot="title">\s*(.*?)\s*</a>', b, re.S)
        if not link:
            continue
        y = attr('release-year') or attr('start-year')
        rows.append({'title': link.group(2), 'year': int(y) if y.isdigit() else None,
                     'score': attr('tomatometer-score') or None, 'url': link.group(1),
                     'tv': '/tv/' in link.group(1)})
    return pick(rows, title, year, tv)


def add_scores(pair):
    item, info = pair
    if not (info and info.get('l')):
        return pair
    title, alias = info['l'], ALIAS.get(norm(info['l']))
    for key, fetch in (('mc', metacritic), ('rt', rotten)):
        try:
            tv = 'TV' in info.get('q', '')
            info[key] = fetch(title, info.get('y'), tv) or (alias and fetch(alias, info.get('y'), tv))
        except Exception as e:
            info[key] = None
            print(f'  ! {key} {info["l"]}: {e}', file=sys.stderr)
    return pair


# --- the page --------------------------------------------------------------------------------

ICON = {
    'IMDb': '<svg viewBox="0 0 32 16" width="22" height="11" aria-label="IMDb"><rect width="32" height="16" rx="3" fill="#f5c518"/><text x="16" y="12" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="10" fill="#000">IMDb</text></svg>',
    'MC': '<svg viewBox="0 0 16 16" width="12" height="12" aria-label="Metacritic"><circle cx="8" cy="8" r="7.5" fill="#000"/><circle cx="8" cy="8" r="6" fill="#ffbd3f"/><text x="8" y="11.6" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="9.5" fill="#000">m</text></svg>',
    'RT': '<svg viewBox="0 0 16 16" width="12" height="12" aria-label="Rotten Tomatoes"><circle cx="8" cy="9.2" r="6.3" fill="#fa320a"/><path d="M8 3.4c-1-1.6-2.6-2-3.6-1.6 1 .3 1.8 1 2.2 1.8-1.3-.4-2.6 0-3.2.8 1.3-.2 2.6.1 3.6.9L8 4.6l1 .7c1-.8 2.3-1.1 3.6-.9-.6-.8-1.9-1.2-3.2-.8.4-.8 1.2-1.5 2.2-1.8-1-.4-2.6 0-3.6 1.6z" fill="#00912d"/></svg>',
}

CSS = '''
:root{--bg:#fafaf8;--fg:#1b1b1b;--mut:#6b6b6b;--card:#fff;--line:#e4e2dc;--acc:#b8860b}
@media (prefers-color-scheme:dark){:root{--bg:#131313;--fg:#eee;--mut:#9a9a9a;--card:#1d1d1d;--line:#2c2c2c;--acc:#e0b040}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:28px} .lead{color:var(--mut);margin:0 0 20px}
.sort{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 18px;color:var(--mut);font-size:13px}
.sort button{display:inline-flex;align-items:center;gap:5px;font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
.sort button[aria-pressed=true]{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
.sort .dir{min-width:.7em;text-align:center;color:var(--acc)} .sort .dir.idle{color:var(--mut);opacity:.35}
/* every card the same height, so the footer row lines up across the grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));grid-auto-rows:1fr;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column}
.card:hover{border-color:var(--acc)}
.card img,.noimg{width:100%;aspect-ratio:2/3;object-fit:cover;background:var(--line);display:block}
.meta{padding:10px 12px 12px;display:flex;flex-direction:column;flex:1}
.title{font-weight:600;line-height:1.3;height:2.6em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sub,.cast,.who{color:var(--mut);font-size:13px}
.cast{margin-top:4px;line-height:1.35;height:2.7em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.note{margin-top:6px;font-size:12px;line-height:1.35;height:2.7em;color:var(--acc);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.who{margin-top:auto;padding-top:8px;font-size:12px}
.scores{margin-bottom:8px;display:flex;flex-wrap:nowrap;gap:3px}
.sc{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;font-size:11.5px;font-weight:600;padding:1px 4px;border-radius:5px;border:1px solid var(--line);cursor:pointer}
.sc:hover{border-color:var(--acc)} .sc.none{color:var(--mut);font-weight:400;cursor:default}
h2{margin:36px 0 10px;font-size:18px} ul{padding-left:18px} li{margin:6px 0;word-break:break-all} a{color:var(--acc)}
'''

JS = '''
document.querySelectorAll('.sc[data-href]').forEach(b => b.addEventListener('click', e => {
  e.preventDefault(); e.stopPropagation(); window.open(b.dataset.href, '_blank');
}));
const grid = document.getElementById('grid');
const btns = document.querySelectorAll('.sort button');
let cur = 'order', desc = false;
btns.forEach(btn => btn.addEventListener('click', () => {
  const k = btn.dataset.sort;
  // first click: scores high to low, chat order oldest first; the same button again flips it
  desc = k === cur ? !desc : k !== 'order';
  cur = k;
  btns.forEach(b => {
    b.setAttribute('aria-pressed', b === btn);
    const d = b.querySelector('.dir');
    d.textContent = b === btn ? (desc ? '\\u2193' : '\\u2191') : '\\u2195';
    d.classList.toggle('idle', b !== btn);
  });
  const cards = [...grid.children];
  const ord = c => +c.dataset.order;
  const val = c => c.dataset[k] === '' ? null : parseFloat(c.dataset[k]);
  cards.sort((a, b) => {
    if (k === 'order') return desc ? ord(b) - ord(a) : ord(a) - ord(b);
    const x = val(a), y = val(b);
    if (x === null || y === null) return (x === null) - (y === null) || ord(a) - ord(b);  // unscored last either way
    return (desc ? y - x : x - y) || ord(a) - ord(b);
  });
  cards.forEach(c => grid.appendChild(c));
}));
'''


def badge(label, r, suffix=''):
    icon = ICON[label]
    if not r or not r.get('score'):
        return f'<span class="sc none" title="no {label} score">{icon} –</span>'
    tip = f' title="{r["votes"]:,} votes"' if r.get('votes') else ''
    return f'<span class="sc" data-href="{E(r["url"])}"{tip}>{icon} {E(str(r["score"]))}{suffix}</span>'


def card(info, who, date, raw, order):
    poster = f'<img src="{info["poster"]}" alt="">' if info.get('poster') else '<div class="noimg"></div>'
    source = ('from an Instagram reel' if 'instagram.com' in raw else
              'from a shared link' if 'http' in raw else
              f'from {raw}' if raw.startswith('carousel') else f'from “{raw[:60]}”')
    note = f'<div class="note" title="{E(raw)}">{E(source)} — verify</div>' if info.get('guessed') else '<div class="note"></div>'
    num = lambda k: str((info.get(k) or {}).get('score') or '')
    scores = badge('IMDb', info.get('imdb')) + badge('MC', info.get('mc')) + badge('RT', info.get('rt'), '%')
    return (f'<a class="card" href="https://www.imdb.com/title/{info["id"]}/" target="_blank" data-order="{order}"'
            f' data-imdb="{num("imdb")}" data-mc="{num("mc")}" data-rt="{num("rt")}">\n'
            f'{poster}<div class="meta"><div class="scores">{scores}</div>'
            f'<div class="title" title="{E(info["l"])}">{E(info["l"])}</div>\n'
            f'<div class="sub">{E(str(info.get("y", "")))} · {E(info.get("q", "").replace("feature", "film"))}</div>\n'
            f'<div class="cast">{E(info.get("s", ""))}</div>{note}\n'
            f'<div class="who">{E(who.split()[0] if who else "")} · {date}</div></div></a>')


def render(title, chat, res):
    cards, others = [], []
    for (date, who, kind, val, raw), info in res:
        if info and info.get('l'):
            cards.append(card(info, who, date, raw, len(cards)))
        else:
            link = f'<a href="{E(val)}" target="_blank">{E(raw)}</a>' if kind == 'link' else E(raw)
            others.append(f'<li>{link} <span class="who">{E(who.split()[0] if who else "")} · {date}</span></li>')

    # Every figure below is counted from the data, so a rebuild cannot leave this text stale.
    found = [i for _, i in res if i and i.get('l')]
    dates = sorted(d for (d, *_), i in res if i and i.get('l'))
    guessed = sum(1 for i in found if i.get('guessed'))
    missing = sum(1 for i in found for k in ('mc', 'rt') if not (i.get(k) or {}).get('score'))
    lead = (f'{len(cards)} titles shared in the Telegram “{E(chat)}” group'
            + (f', {dates[0]} to {dates[-1]}' if dates else '') + '. '
            + (f'{guessed} were identified from a name, a link or a reel rather than an IMDb link'
               f' — those cards say <b>verify</b>. ' if guessed else '')
            + (f'{missing} critic scores are missing because the title is not listed.' if missing else ''))

    sort_buttons = ('<button data-sort="order" aria-pressed="true">Chat order<span class="dir">↑</span></button>'
                    + ''.join(f'<button data-sort="{k}">{ICON[label]} {name}<span class="dir idle">↕</span></button>'
                              for k, label, name in (('imdb', 'IMDb', 'IMDb'), ('mc', 'MC', 'Metacritic'),
                                                     ('rt', 'RT', 'Rotten Tomatoes'))))
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{E(title)}</title>
<style>{CSS}</style></head><body><main>
<h1>{E(title)}</h1><p class="lead">{lead}</p>
<div class="sort" role="group" aria-label="Sort by">Sort:{sort_buttons}</div>
<div class="grid" id="grid">{''.join(cards)}</div>
<h2>Not identified ({len(others)})</h2><ul>{''.join(others)}</ul>
</main><script>{JS}</script></body></html>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('export', help="a Telegram chat export's result.json")
    ap.add_argument('-o', '--out', required=True, help='HTML file to write')
    ap.add_argument('--overrides', help='JSON file of per-chat fixes (see the header)')
    ap.add_argument('-j', '--jobs', type=int, default=8, help='parallel lookups (default 8)')
    a = ap.parse_args()

    ov = json.loads(Path(a.overrides).read_text(encoding='utf-8')) if a.overrides else {}
    chat, items = read_export(a.export, ov)
    print(f'{len(items)} candidates from “{chat}”')

    with cf.ThreadPoolExecutor(a.jobs) as ex:
        res = list(ex.map(resolve, items))
        res = list(ex.map(add_scores, res))

    ids = sorted({i['id'] for _, i in res if i and i.get('l')})
    try:
        ratings = imdb_ratings(ids) if ids else {}
    except Exception as e:
        print(f'  ! imdb ratings: {e}', file=sys.stderr)
        ratings = {}
    for _, i in res:
        if i and i.get('l'):
            r = ratings.get(i['id']) or {}
            i['imdb'] = {'score': r.get('aggregateRating'), 'votes': r.get('voteCount'),
                         'url': f'https://www.imdb.com/title/{i["id"]}/ratings/'}

    Path(a.out).write_text(render(ov.get('title') or chat or 'Watchlist', chat, res), encoding='utf-8')
    found = sum(1 for _, i in res if i and i.get('l'))
    print(f'{found} titles, {len(res) - found} unidentified → {a.out}')
    for (date, who, kind, val, raw), info in res:
        if info and info.get('guessed'):
            print(f'  guess: {raw[:60]} → {info["l"]} {info.get("y", "")}')


if __name__ == '__main__':
    main()
