# Link Keeper

A Firefox extension for working through a pile of saved links. It holds a list, sends you to
the next one **in the tab you are already looking at**, and captures the ones worth keeping —
title, author, body text, and any URLs embedded in the page. Export the result as a file when
you are done.

It exists for the case an export cannot solve. A saved `x.com/i/status/123` is a dead link on
paper: no title, no author, nothing, because X shows none of that to an unauthenticated
fetch. Your logged-in browser is the only place that URL means anything, so the reading
happens there.

**Everything is manual.** No page is read, and no link is opened, unless you press a key.
There are no content scripts, no background tabs, and no automation of your browsing.

## Layout

| Path | Role |
|---|---|
| `extension/` | the add-on — load `extension/manifest.json` in Firefox |
| `importers/` | scripts that turn an existing pile of saved links into paste-ready lines, dates intact |
| `receiver/` | tiny HTTP endpoint an always-on box runs — the phone's shares land here |
| `android/` | the share-sheet app that sends them (`build.zsh`, no Gradle) |
| `native/` | the helper that reopens stashed local-file tabs — `native/install.zsh` registers it with Firefox |
| `tools/` | `refresh.zsh` — the one command that rebuilds everything from the newest exports<br>`extension-diff.py` — read the add-on's storage out of the Firefox profile and list the captures it does not hold yet<br>`fetch-signed-xpi.py` — download a version AMO signed after web-ext stopped waiting<br>`stash-status.py` — list the tab stashes the add-on holds, read out of the profile's bookmarks<br>`test-stash.mjs` — run the tab stash against a fake browser and prove no tab is lost<br>`test-stash-import.mjs` — check every format the stash import reads<br>`run-in-headless-firefox.zsh` — run a WebExtension script, alone or beside the real extension, in a throwaway headless Firefox<br>`e2e-stash.js` — the stash checks that script runs against real tabs and bookmarks<br>`test-open-local-files.py` — check the local-file helper refuses everything but existing files<br>`preview-pages/preview.zsh` — render the popup, list and stashed-tabs pages in any browser with a fake extension API and real capture text<br>`captures-to-html.py` — render an exported capture JSONL as one browsable page<br>`telegram-messages-to-html.py` — render a Telegram export, flagging which messages migration made redundant<br>`telegram-saved-links.py` — a swipe-to-triage page for a Telegram export's raw links, keep/drop/defer<br>`watch-reel.zsh` — turn an Instagram reel or carousel into a transcript, keyframes and slides an agent can read<br>`chat-to-watchlist.py` — render a chat export of film links as one page with IMDb, Metacritic and RT scores<br>`reels-to-captures.py` — convert those packs into capture records the extension displays<br>`make-app.zsh` — wrap the refresh in a Spotlight-launchable macOS app |

## After an export: one command

    link-refresh

or, on macOS, ⌘-space → **Link Refresh**. `tools/make-app.zsh` builds that into `~/Applications` as a
plain bundle — a plist and a shell script, no Automator — and it reports what happened as a
notification. An app launched from Spotlight inherits almost no PATH, so the runner restores asdf's
shims and Homebrew before anything else; without that, `python3` is simply absent.

That is the whole routine, and it covers both sources: the newest export under Telegram's download
folder, and — if one exists — the newest Instagram export that actually contains messages. It resolves
every link it can without a browser, rebuilds both HTML views, and then holds the result on a loopback
port. Open the extension's list page and it collects the file itself — no dialog, nothing to paste.

Better still, exports are optional altogether once the phone-share path is up: the `android/` share
target puts **Link Keeper** in Android's share sheet, POSTs the link to the `receiver/` endpoint on
any always-on box you own (over Tailscale, so nothing crosses the open internet), and the refresh
mirrors that inbox before rebuilding. Share → pick Link Keeper → done; no messenger in the loop.
Links queue on the phone when the endpoint is unreachable and ride along with the next share.

Two alternative intakes exist for the same inbox: `importers/telegram-pull.py` reads Saved Messages
directly through Telegram's API (needs a my.telegram.org login), and plain chat exports keep working
as the manual fallback. All three feed the same refresh; `config.local.sh.example` shows the knobs.

Rebuilt files land in `data/` at the repo root by default — nothing to set up. Copy
`config.local.sh.example` to `config.local.sh` only if you want `DATA_DIR` pointed somewhere else;
nothing machine-specific is committed. Symlink `tools/refresh.zsh` onto your PATH as
`link-refresh`, or call it by path.

Only links that resolved to nothing need anything more, and the command prints those.

## Install

Requires Firefox 142 or newer. No build step, no dependencies.

`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select
`extension/manifest.json`.

Temporary add-ons unload when Firefox restarts, so that route is for trying unsigned changes.
The permanent install is a build signed through [AMO](https://addons.mozilla.org/developers/)'s
unlisted channel: nothing is listed or published, and the signed `.xpi` is installable only by
whoever holds the file. A signature covers exactly the files it was issued for, so every change
ships as a new version.

1. Raise `version` in `extension/manifest.json`; AMO refuses a version it has already signed.
2. The AMO API credentials, from https://addons.mozilla.org/developers/addon/api/key/, live in
   Doppler: project `firefox-signing`, config `prd`, as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`
   — the names web-ext reads. The same keys sign every Firefox extension on this account. A copy
   sits in the login keychain as `amo-jwt-issuer` and `amo-jwt-secret`; a rotated key goes to both.
3. Sign from `extension/`:

       doppler run --project firefox-signing --config prd -- npx web-ext sign --channel unlisted

   If approval outlasts web-ext's wait, it exits without a file and a rerun reports "already
   submitted"; `tools/fetch-signed-xpi.py`, run under the same `doppler run`, downloads the signed
   version instead.
4. Open the new file in `extension/web-ext-artifacts/` with Firefox and confirm the install. It
   replaces the previous version in place; the pinned add-on id keeps the list and captures.

## Use

Three keys, and you never leave the tab you are in.

| Key | What it does |
|---|---|
| `Ctrl+Shift+J` | load the next link from the list in the current tab |
| `Ctrl+Shift+K` | keep this page — read it and store the capture |
| `Ctrl+Shift+U` | add the page you are on to the list |
| `Ctrl+Shift+X` | skip this one — an explicit rejection — and advance |
| `Ctrl+Shift+S` | stash tabs — see [Stashing tabs](#stashing-tabs) (`Alt+Shift+S` off macOS, where Firefox's screenshot owns the other) |

Every one of these is also a **popup button** and a **right-click menu** item, so the keyboard
is optional. Right-clicking a *link* offers "Add this link to Link Keeper" — queueing something
without visiting it, which the keyboard cannot do.

So the loop is: `Ctrl+Shift+J`, read it, `Ctrl+Shift+K` if it is worth keeping, `Ctrl+Shift+J`
again. Stop whenever. The list remembers where you were, across restarts.

On macOS these are bound with `MacCtrl`, so they are the literal **Control** key — not Command.
`"Ctrl"` in a WebExtension `suggested_key` means Command on macOS, and `Cmd+Shift+J` is
Firefox's own Browser Console, so Control is both freer and less surprising. Rebind any of them
in `about:addons` → gear → *Manage Extension Shortcuts*.

Loading a link marks it **seen**. Keeping it marks it **kept**. **Skip** marks it `skipped`, which
is a deliberate rejection rather than "opened it, moved on" — the list filters the two separately.

The popup shows the same actions as buttons, a progress bar, what is coming next, and a box
for attaching a note to the next thing you keep. One action is filled at a time: **Keep** while a
list item is open in the tab, **Next** otherwise.

### Cards — judging what you have read

Two stages, in this order, because the order is forced:

1. **Read.** Walk the list with `Ctrl+Shift+J` and press `Ctrl+Shift+K` on anything worth reading.
   This is an ingest, not a verdict — it pulls the page's author, text, links and images into the
   store.
2. **Judge.** Open *Cards* and go through what you have read as a shuffled deck. Right keeps, left
   drops, up defers to the next session. `o` opens, `u` undoes.

The deck runs over **captures**, never over bare URLs. A card has to be judgeable, and
`x.com/i/status/2086188444317819246` tells you nothing — that opacity is the entire reason this
extension exists. So a card only appears once the page behind it has been read, and then it carries
the headline, the text, the embedded links, the images and the screenshot preview.

A verdict never deletes anything. Dropping sets a flag, visible in the list as `✕ Drop`, and one
click reverses it. Deferring records nothing, so the card returns next session.

The deck is shuffled fresh each visit: ordered by date it would be 133 x.com cards in a row, and
mixing the domains keeps each card an actual decision.

### Stashing tabs

OneTab's move, kept apart from the reading list. **Stash** (`Ctrl+Shift+S`, the popup, the page's
right-click menu, or right-click on the tab strip) folds tabs into a saved group and closes them:
the selected tabs if you have selected several, otherwise the whole window. *Stashed tabs* opens in
their place.

The **Stash** submenu — on a page, and on a tab in the tab strip — and the row under the popup's
Stash button take other scopes too: **only this tab**, **tabs to the left**, **tabs to the right**,
**all except this one**, and **every window** (one stash per window). On the tab strip, "this tab" is
the one you right-clicked. **Never stash this site** in the same submenu puts a site on a list that
stashing leaves open; **Settings** on the Stashed tabs page shows the list. Two commands without a
default key, *Stash only this tab* and *Show stashed tabs*, can be bound in Firefox's
*Manage Extension Shortcuts*.

Stashes are **Firefox bookmarks**, as TidyTab's were: *Other Bookmarks / Link Keeper stashes*, one
folder per stash named after its time (or what you rename it to), one bookmark per tab in tab order.
So they outlive the extension, travel with Firefox Sync, and can be edited in Firefox's own library;
the page shows what the bookmarks hold. What a bookmark cannot carry — a tab's container, its
Keep/Drop mark, when it was restored, and a stash's lock and star — sits beside it in the add-on's
storage; an uninstall loses those, never a tab. A reinstall finds the folder again by its name.
Stashes made before 5.9 move into bookmarks once, when 5.9 first runs; the old record is kept aside
(`sessions_before_bookmarks`) rather than deleted.

There is one Stashed tabs page, like OneTab's tab: pin it, and stashing, the popup's **Stashed**
button and the menu all switch to that tab, in whichever window it is, instead of opening another.
A new one opens only when none is open. Stashing a whole window while the page is pinned in a
different window closes the stashed window, as OneTab does.

- Pinned tabs, empty tabs and never-stash sites stay open; everything else is stashed. Stashing
  only this tab takes it whatever it is. Duplicate tabs all close and are recorded once; a URL
  already in another stash is recorded again and marked *Also in N other stashes*.
- Only the URL, the tab title and the tab's container are recorded. Nothing runs inside the tabs.
- A stash is the only record of the tabs it closes (Firefox remembers 25 closed tabs), so no tab
  closes until every bookmark has been read back and found present. If writing fails partway, the
  half-written folder is taken back out and nothing closes.
- **Restore all** reopens every web page unloaded — each one loads when you switch to it — in its
  original container. By default the stash stays, with each entry marked restored; **Settings** can
  make a restore take the tabs out instead, as OneTab can. A tab's back/forward history does not
  come back; that lives in Firefox's session, not in a URL.
- Firefox lets no extension open a `file:` URL, an `about:` page or another extension's page. Local
  files reopen through `native/open-local-files.py`, a native-messaging helper that accepts only
  `file:` URLs of files that exist and opens them in the Firefox that started it. Run
  `native/install.zsh` once to register it. Anything the helper cannot open — and every `about:`
  or other extension's page — comes back as a stand-in tab carrying the original title, with the
  URL one click from the clipboard, as OneTab and Sidebery do.
- **Move to list** hands a group's web pages, or one, to the reading list with its title and the
  stash date, and takes them out of the stash; local files and browser pages stay. **Delete…** asks first.
- **Star** keeps a stash at the top. **Lock** makes it unable to lose a tab: no delete, no remove,
  no move to the list or dragging out, and restoring always keeps it.
- Drag a row to reorder it or drop it into another stash (ahead of or after the row it lands on, or
  last on a stash's heading); the row's **⋯** menu does the same from the keyboard. A stash emptied
  this way goes.
- **Group by** Stash, Day or Month; the date views put stashes under date headings.
- **Export** downloads every stash as JSON. **Import…** reads it back, and also OneTab's *Export
  URLs* text, a TidyTab export, CSV with a `url` column (optionally `title`, `group`, `date`), a
  JSON list of URLs, or any text with links in it — pasted or from a file. It says which format it
  took the input for before anything is written.

**Explore** shows every stashed tab in a sidebar — one stash or all, in the order they were stashed,
with a filter and Undecided / Kept / Dropped chips — and the chosen tab in full beside it. Click any
row to jump to it, or walk with `↑` `↓`. The detail pane shows the tabs that sat beside it in the tab
strip, its capture if the page was ever read, whether it is on the reading list or in another stash,
and how many stashed tabs share its site. **Open**, **Keep**, **Drop**, **To list** and **Read** act
on it (`o` `k` `d` `l` `r`); pressing Keep or Drop again clears it. A drop is a flag, struck through
in the list; **Clear dropped…** on the Stashed tabs page removes dropped tabs, after a confirm.

The **live preview** (`p`) shows the page itself, half a second after you land on a tab. Most sites
forbid being framed, so for frames inside this page only, the extension strips `X-Frame-Options` and
CSP `frame-ancestors` from the response (`webRequestBlocking`, plus all-sites access asked on the
first preview). The frame is sandboxed without top navigation, and it loads logged out — Firefox keeps
a framed page's cookies apart. Local files and browser pages cannot be framed at all.

`node tools/test-stash.mjs` runs the stash code against a fake browser and bookmark tree with 349
tabs and checks that every tab is either still open or recorded, and that a restore brings each one
back, through scopes, locks, drags, imports and the move into bookmarks.
`tools/run-in-headless-firefox.zsh --extension extension tools/e2e-stash.js` runs the same paths in
a throwaway headless Firefox — real tabs, real bookmarks, a temporary profile — and
`node tools/test-stash-import.mjs` checks every import format.
`tools/test-open-local-files.py` checks the helper's refusals without opening anything.

### Seeing the whole list

*Open list* in the popup opens a full page — the readable view when there are
hundreds of entries, rather than a 22rem popup.

- Grouped **by domain** by default, or by status, or flat newest- or oldest-first.
- Filter box searches URLs, captured titles, tweet text, notes and embedded links.
- Status chips narrow to what is left, seen, skipped, or kept.
- Rows show the date the link was saved; a dimmed date means only the paste date is known.
- A status mark per row, told apart by shape as well as colour: a ring for pending, a dot for
  seen, a tick for kept, a cross for skipped. The current item carries a *Current* badge and a
  line down its left edge.
- Rows show the captured title, the post's text and any links found inside it, so a tweet you
  already read is legible without opening it again.
- Per row: **Re-read** reads it again in the background, and **⋯** holds **Open in this tab**
  (loads it here and makes it current), **Mark kept**, **Skip** and **Remove from list**.
- **Remove all…** per group, and **Tidy…** to clear every finished entry at once. Neither
  touches your captures.

Clicking a title opens it in a new tab and marks that entry current, so a `Ctrl+Shift+K`
there attaches the capture to the right list entry.

### Filling the list

- **`Ctrl+Shift+U`** or *This page* — queue something for later while browsing.
- **Paste URLs** into *Add links*, one per line. Each line may carry the date the link was
  originally saved, tab or space separated — which is exactly what the scripts in `importers/`
  produce:

  ```
  https://x.com/i/status/2086188444317819246	2026-08-09
  https://news.ycombinator.com/item?id=49139102	2026-08-10
  ```

  A whole JSON object per line works too, so an exported list round-trips.

Dates matter: without one, a link's only timestamp is the moment you pasted it, which flattens
years of saved links to a single minute. The queue and the list are both ordered **newest first**
by that date, so re-pasting a list with dates is not a no-op — it backfills them onto entries that
already exist.

### Screenshots

**Keep + shot** — one action. It reads the page, then scrolls it a screenful at a time, shoots each
viewport, and stitches the tiles into a single PNG named after the post. Leave the tab alone for a
second while it walks the page.

Files land in `~/Downloads/link-keeper/`, and the subfolder is configurable under *Export &
housekeeping*. It cannot be moved out of Downloads: the `downloads` API resolves filenames against
the browser's download directory and rejects `..`, so no extension can write elsewhere. If the
files need to live somewhere else, make that subfolder a symlink — Firefox writes through it.

Re-keeping the same page overwrites its PNG rather than leaving a `(1)` beside it, so the filename
in the record always names the current shot.

MV3 does not expose `captureTab`, which would have taken the whole page in one call — the schema
lists it but it never materialises, with or without host permission. `captureVisibleTab` is
exposed, hence the tiling. Two details keep the result clean: fixed and sticky elements are
temporarily made `static`, or x.com's top bar would repeat in every tile; and each tile records
the scroll position actually reached, since the final scroll clamps short of its target.

Scrolling the page also has a useful side effect — lazily-loaded images load, so they appear in
the shot.

**This needs access to all sites.** Reading a page's pixels does, where `activeTab` is enough for
reading its text. The permission is optional and requested the first time you press the button;
decline it and text capture is unaffected. Revoke any time in `about:addons`.

A screenshot you take yourself with Firefox's own tool is adopted too, if it lands within two
minutes of a keep — useful when you want Firefox's rendering rather than the stitched one. Only
the filename is recorded; the PNG stays where it was saved.

Image URLs are recorded on every capture regardless, in `images` — for x.com rewritten to
`name=orig` so they point at the unresized original.

### x.com without opening anything

`importers/enrich-x.py` resolves x.com status links through FxTwitter's public JSON API, which needs
no login and returns the author, full text, date, media and — because it expands `t.co` inline — the
destinations the post linked to. A bare `x.com/i/status/<id>` resolves fine, handle included.

    ./importers/telegram.py result.json | ./importers/enrich-x.py > link-captures.jsonl

Then, in the list page, **Import…** → choose the file or paste it. Those links arrive already read, so
the card deck can judge them immediately.

Import lives in the list page rather than the popup on purpose: choosing a file opens an OS dialog,
which closes a browser-action popup and destroys its JavaScript before the change event can fire — the
file is silently never read. A tab survives it.

Measured on 133 links: 131 resolved in 106 seconds, 2 were deleted tweets, no rate limiting. 38 came
with their destination link recovered.

**It cannot get replies.** FxTwitter returns a reply count, never reply content, and no `?thread`
variant changes that — so a post saying "repo in the comments" arrives without the repo. Those are
flagged `needs_replies`, and reading them is the extension's job — see below.

### Everything else, also without opening it

`importers/enrich-web.py` does the same for ordinary links — `og:` tags, plus the GitHub, Hacker News
and YouTube APIs where those beat scraping. Sites behind a bot check or a login wall go to
`--failed-to` instead of being guessed at; those are what the extension is for.

### Instagram, from its own export

Links sent to yourself (or saved) on Instagram come out of the account-wide "Download your
information" dump — JSON format, Messages ticked, Saved too if you use it. `importers/instagram.py`
reads the zip directly, undoes Meta's latin-1 mojibake, follows the `message_N.json` pagination, and
finds the self-thread on its own. No enrichment fetch is needed or possible: instagram.com stonewalls
resolvers, but the export already carries each reel's caption and author, so `--json` emits finished
capture records (`kind: "reel"` / `"ig-post"`) with zero network calls. Non-instagram links pasted
into the self-thread go through the normal enrichers via `--other`. `tools/refresh.zsh` runs all of
this whenever an export containing messages exists — Instagram exports are per-request subsets, so
`--check` keeps a zip requested for something else from shadowing the one with the links in it.

A reel is a video, so a captured URL is not yet captured content. `tools/watch-reel.zsh` closes that
gap: it downloads the MP4 anonymously (yt-dlp, no login involved), transcribes the audio locally
(mlx-whisper), and extracts one frame per second — a watch-pack an agent can read instead of a video
only a human could watch. Idempotent per reel; point it at a capture file with `--from`. A carousel post is not a video at
all, so it is saved slide by slide instead — each image at full size, each video slide with its own
frames and transcript — which is what a post whose slides *are* the content needs.

### Triaging a pile of saved links

`tools/telegram-saved-links.py` is for working through a Telegram export's raw links before they
ever reach the extension — a Tinder-style card stack, one link per card, swipe right to keep,
left to drop, up to defer for later. It enriches each card from a Link Keeper capture file when
one exists for that link, so a card carries the real title and text rather than a bare URL:

    ./tools/telegram-saved-links.py result.json -o triage.html -c link-captures-all.jsonl

Decisions live in the page's localStorage and are also exportable to a sidecar JSON
(`telegram-links-triage.json` by default); pass it back in with `-t` and a re-export of the same
chat does not re-litigate links already decided. Output and the sidecar both default into
`DATA_DIR` rather than the current directory. `tools/refresh.zsh` runs this on every export
alongside the message view, into fixed filenames in `DATA_DIR` so the queue is right there after
every refresh; `--urls` prints the same `URL<TAB>date` lines as `importers/telegram.py` if you
just want to paste into *Add links* instead.

The link extraction underneath — walking `result.json`'s messages and text entities, the
`.sh`/`.py`/`.so`/`.io`-as-TLD wrinkle, schemeless links held out rather than guessed at — lives
in `importers/telegram_export.py`, shared with `importers/telegram.py` and
`tools/chat-to-watchlist.py` so the parsing logic exists in exactly one place.

### A chat full of films

`tools/chat-to-watchlist.py` is for the group where films get thrown at each other. It reads a
Telegram export and renders every title as a poster card carrying its IMDb rating, Metacritic
score and tomatometer, sortable by any of the three in either direction:

    ./tools/chat-to-watchlist.py result.json -o watchlist.html --overrides chat.json

IMDb links resolve exactly, by id. A typed name resolves to IMDb's top hit and the card says so,
because that is a guess. Anything else — a Netflix link, a reel, a slide of a carousel — resolves
only because the overrides file names the title, so the guessing stays in a file you can correct
rather than in the script. That file holds everything specific to one chat, which is also what
keeps a private chat's contents out of this repo; the script's header documents its shape. The
page's opening line is counted from the data at render time, so rebuilding cannot leave it stale.

Scores need no login and no key of yours: IMDb's public GraphQL endpoint, Metacritic's search API
with the key its own pages embed, and Rotten Tomatoes' search page. A score is only attached when
the title, the type (film or series) and the year all agree with IMDb's, so *Chernobyl* the
mini-series does not inherit a same-named film's rating.

### Links from the replies

Keeping an x.com post also harvests links out of the replies rendered below it, into `reply_links`.
Half the reason a tweet gets saved is a tool it names but does not link — "repo in the comments" —
and no API exposes reply bodies. They exist only in a rendered, logged-in page, so this is the one
thing scraping does that fetching cannot.

A reply from the post's own author is marked `self` and sorted first, because that is where an author
parks the link. In the list and the deck those chips are outlined in green and prefixed `↩`.

x.com renders replies lazily, so a plain **Keep** sees only what has scrolled into view. **Keep +
shot** walks the entire page to stitch its screenshot and therefore sees far more of them — worth
using on anything flagged `needs_replies`.

### Getting the data out

*Export captures* writes `link-captures.jsonl` to Downloads. *Export list* writes the worklist
with each entry's status, if you want to see what you skipped.

Captures stay in the extension until you clear them, so exporting twice is fine.

## What gets extracted

`extractors.js` is a registry of site handlers with a generic fallback. A handler that returns
nothing degrades to the generic result rather than failing the capture.

| Site | Beyond title and description |
|---|---|
| x.com, twitter.com | author, handle, full tweet text, posted time, quoted tweet, media kinds, embedded links |
| x.com Articles | the headline and the whole long-form body with its line breaks intact, plus each code block separately. These live in different nodes from a normal tweet and have no `tweetText` at all |
| github.com | repo or issue, owner, description, stars, language |
| news.ycombinator.com | the story's own outbound URL, points, submitter |
| youtube.com | channel, description, duration |
| reddit.com | subreddit, author, the post's outbound URL |
| anything else | `og:` tags, JSON-LD, canonical URL, `<h1>`, your text selection |

Adding a site is one object in `REGISTRY`.

`t.co` links are resolved to their destination in the background — the destination is usually
the reason the tweet was worth keeping. This is the only outbound request the extension makes.

## Output

One JSON object per line. A tweet capture:

```json
{
  "kind": "tweet",
  "url": "https://x.com/somehandle/status/2009295329057702081",
  "source_url": "https://x.com/i/status/2009295329057702081",
  "status_id": "2009295329057702081",
  "from_worklist": "https://x.com/i/status/2009295329057702081",
  "author": { "name": "Some One", "handle": "@somehandle" },
  "text": "A thread about a tool I built. Repo below.",
  "posted": "2026-08-09T14:50:00.000Z",
  "links": [{ "href": "https://t.co/x", "display": "github.com/a/b", "resolved": "https://github.com/a/b" }],
  "media": ["card"],
  "note": "the launcher I wanted",
  "captured_at": "2026-08-10T17:00:00Z"
}
```

`source_url` and `from_worklist` are kept alongside `url` deliberately: they are what let a
capture be matched back to the link you originally saved, since `x.com/i/status/<id>` and
`x.com/<handle>/status/<id>` are the same post under different paths. Join on `status_id`.

JSONL rather than a JSON array so exports concatenate — `cat` two together and the result is
still valid.

## Permissions, and why each one

| Permission | Why |
|---|---|
| `activeTab` | read the tab you triggered on — granted per keypress, no standing access |
| `scripting` | inject `extractors.js` into that one tab |
| `tabs` | point the current tab at the next link |
| `storage`, `unlimitedStorage` | hold the list and the captures between restarts |
| `menus` | the right-click actions |
| `downloads.open` | opening a screenshot from the list page, since a `file://` image cannot be loaded there |
| `downloads` | write screenshot PNGs and the exported JSONL |
| `notifications` | report the result of keyboard and menu actions, which have nowhere else to speak |
| `*://*/*` *(optional)* | reading pixels for a screenshot; requested on first use, revocable, and not needed for text |
| `*://t.co/*` | resolve shortened links |

No content scripts, and no host permissions beyond `t.co`. There is no mechanism by which the
extension could read a page you did not ask about — which is why it is trigger-only rather
than a watcher.

## Notes

- The background script is an MV3 event page and is suspended when idle. The list, the
  captures and your position all live in `storage.local` for that reason, so nothing is lost
  when Firefox puts it to sleep.
- *Reset progress* returns everything you only looked at to unvisited. Kept items stay kept.
- Clearing is irreversible and asks first. Export before you clear.
- Article bodies are read with `innerText`, not `textContent`, so paragraph breaks and code
  blocks survive. Plain tweets collapse whitespace, which is fine at that length.
- Images are not captured — text only. A chart in an article is lost; its surrounding prose is not.
- x.com's markup is read through `data-testid` attributes, the most stable handle it exposes.
  If a capture comes back thin, x.com renamed something; `fallback_text` holds the visible
  article text so the capture is still worth keeping, and the fix is one selector.

## Licence

AGPL-3.0. See `LICENSE`.
