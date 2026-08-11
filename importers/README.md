# Importers

Each script here reads one source of saved links and prints them in the format the extension's
*Add links* box accepts — nothing else. They do not talk to the extension, hold state, or write
files; the handoff is your clipboard.

```
./telegram.py ~/Downloads/Telegram\ Desktop/ChatExport_2026-08-10/result.json | pbcopy
```

Then: popup → **Add links** → paste → **Add**.

## The output contract

One link per line, newest first:

```
https://x.com/i/status/2086188444317819246	2026-08-09
https://news.ycombinator.com/item?id=49139102	2026-08-10
```

URL, then a tab, then the date it was **originally saved** — not today. That date is the point of
having importers at all: without it every link carries the timestamp of the paste, which flattens
years of saving into one minute and makes ordering meaningless.

`--json` emits the same thing as JSONL (`{"url": …, "saved_at": …}`), which the paste box also reads.
Use whichever is easier to produce.

Re-pasting is safe and useful: duplicates are matched on a normalised URL, and an entry that already
exists gets its date backfilled rather than being skipped.

## Writing another one

An importer is a filter — source in, `URL<TAB>date` out. That is the whole interface, so a new one
needs no registration and touches nothing else. Worth having:

- **OneTab** — its export is `url | title` per line, grouped by save time
- **Browser bookmarks** — Firefox's JSON backup and Chrome's `Bookmarks` file both carry `dateAdded`
- **Pocket / Instapaper / Raindrop** — all export CSV with a timestamp column

Keep dates in ISO form (`YYYY-MM-DD` or full ISO 8601). Anything `Date.parse` understands works, but
ISO is unambiguous across locales.

## telegram.py

Telegram marks URLs with `link` text entities, so links come out already parsed. Two wrinkles it
handles:

**Filenames look like links.** `.sh`, `.py`, `.so` and `.io` are real TLDs, so `deploy.sh` and
`server.py` pasted inside a code snippet get entity-tagged. Anything without an `http(s)` scheme is
withheld from the output — `--schemeless` lists those with their surrounding text so you can pick out
the genuine ones. In one 556-message export, 8 were withheld and only 2 were real sites.

**No titles.** Link previews are fetched by Telegram at send time and are absent from the export, so
a bare `x.com/i/status/123` stays bare. Resolving those needs a logged-in session, which is the
extension's job — read the page, and the author, text and images come with it.

`--stats` prints counts, the date span and the top domains without listing anything.
