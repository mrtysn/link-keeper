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
| `tools/` | `refresh.zsh` — the one command that rebuilds everything from the newest exports<br>`extension-diff.py` — read the add-on's storage out of the Firefox profile and list the captures it does not hold yet<br>`fetch-signed-xpi.py` — download a version AMO signed after web-ext stopped waiting<br>`stash-status.py` — list the tab stashes the add-on holds, read out of the profile's bookmarks<br>`survey-stashed-sites.py` — count stashed links per site, and show which pages of a site are main pages or items (for the filtered-out rules)<br>`test-stash.mjs` — run the tab stash against a fake browser and prove no tab is lost<br>`test-stash-import.mjs` — check every format the stash import reads<br>`run-in-headless-firefox.zsh` — run a WebExtension script, alone or beside the real extension, in a throwaway headless Firefox<br>`e2e-stash.js` — the stash checks that script runs against real tabs and bookmarks<br>`test-open-local-files.py` — check the local-file helper refuses everything but existing files<br>`preview-pages/preview.zsh` — render the popup, Links, Cards and Tags in any browser with a fake extension API and real capture text<br>`preview-frames/test-preview-frames.zsh` — check in headless Firefox that the Links detail pane's live preview frames sites that forbid framing, and nothing else can<br>`preview-pages/test-keys.zsh` — drive Links (with and without its detail pane), Cards, Tags and the popup in that preview with the shared keys and check each action and its undo, the tag library, the tag palette and the hover previews<br>`captures-to-html.py` — render an exported capture JSONL as one browsable page<br>`telegram-messages-to-html.py` — render a Telegram export, flagging which messages migration made redundant<br>`telegram-saved-links.py` — a swipe-to-triage page for a Telegram export's raw links, keep/drop/defer<br>`watch-reel.zsh` — turn an Instagram reel or carousel into a transcript, keyframes and slides an agent can read<br>`chat-to-watchlist.py` — render a chat export of film links as one page with IMDb, Metacritic and RT scores<br>`reels-to-captures.py` — convert those packs into capture records the extension displays<br>`make-app.zsh` — wrap the refresh in a Spotlight-launchable macOS app |

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
| `Ctrl+Shift+K` | capture this page: save its text, images and links |
| `Ctrl+Shift+U` | add the page you are on to the reading list |
| `Ctrl+Shift+S` | stash tabs — see [Stashing tabs](#stashing-tabs) (`Alt+Shift+S` off macOS, where Firefox's screenshot owns the other) |

Every one of these is also a **popup button** and a **right-click menu** item, so the keyboard
is optional. Right-clicking a *link* offers "Add this link to Link Keeper" — queueing something
without visiting it, which the keyboard cannot do.

On macOS these are bound with `MacCtrl`, so they are the literal **Control** key — not Command.
`"Ctrl"` in a WebExtension `suggested_key` means Command on macOS, and `Cmd+Shift+J` is
Firefox's own Browser Console, so Control is both freer and less surprising. Rebind any of them
in `about:addons` → gear → *Manage Extension Shortcuts*.

Opening or capturing a reading-list link marks it **seen** (opened).

The **popup** is about the page you are on. Two lines say whether you hold it already — **Held**:
each stash as its day (or name) and tab count, and the reading list; **Captured**: the day, or not
yet — and, if you do, its tags with nine of the palette, your most used first, the field ready, so
`1`–`9` or typing tags it then and there. The likely next step is the filled button: **+ List** for a
page you do not hold, **Capture** for one held without its text. Then what to do with it: **Capture** (its ▾
captures with a full-page screenshot, or with a note), **Remove** — one copy; held in several places,
its menu names each and you pick one, with **Undo** after — and, for a page not saved yet, **+ List**
and **Stash tab**. The foot holds links to Links, Cards and Tags, each switching to the
viewer's tab if one is open, and a small **Stash window** (its ▾ holds the other scopes). The last
action's message comes back when the popup reopens only on the page it was about, within ten
minutes. Adding links in
bulk, exports and settings live on the Links page.

### Viewers and sources

Links come from three **sources** — **Stashed tabs** (stashes made from your open tabs), **Imports**
(stashes brought in from OneTab, TidyTab, a file or pasted text) and the **Reading list** (links you
queued, and pages you kept) — and three **viewers** show them: **Links**, **Cards** and **Tags**.
The bar across the top of every page links the viewers and holds a chip per source; turn any mix on,
and the choice holds as you switch viewers and between visits. Each chip counts its links.

A URL is one link wherever it is held. In a joint view it shows once, with badges saying where it
is (*Reading list*, *Stashed*, *Imported ×2*). Its tags and its capture belong to the URL, so every
copy shows them; removing acts on one copy, the one in front of you. Nothing is merged or deleted underneath: a stash keeps its bookmarks and the list its
entries.

### Tags

A tag belongs to a link — the URL wherever it is held — so tagging it on Links shows on its Cards
copies too. Until a link has tags of its own, what kind of site it is shows in their place,
dashed: `code` (GitHub, GitLab…), `video`, `post`, `discussion`, `game`, `paper`, `doc`, `article`,
`local file`. Guesses are never saved; the first change in the editor makes the shown tags yours,
and removing every tag brings the guess back.

- `T` on any page opens the editor: the link's chips, a field, and under it a palette of every tag
  there is — click one, or press `1`–`9` on the empty field, to put it on or take it off. Typing
  narrows the palette (spaces and punctuation ignored, so `gamejam` finds *game jam*); Enter or Tab
  takes the first match, and a name the palette lacks is offered as **+ new tag**. Backspace takes
  the last tag off; Escape stops. Every change is saved at once. the Links detail pane has the editor in its
  detail pane, and Cards opens it over the card.
- **Tagging many in a row** works on every page: Enter on the empty field moves to the next link
  with its editor already open, so `T`, type, Enter, Enter, type, … runs down the links; Escape
  stops. Narrow first to the links that need it: **Untagged** is a tag chip on Links, and
  an option in Cards' tag selector.
- A stash heading's **⋯ → Tag all tabs…** adds one tag to every tab in it.
- List has a row of tag chips — any of them, or **Untagged** for the links with none of their own —
  and **Group by Tag**, where a link shows under each of its tags. Cards deals one tag at a time.
- **Tags** in the top bar is the tag library, and a tag is a collection: every tag with its colour
  and how many links on show carry it, and beside it the links of the chosen one, each with the
  usual actions. Make a tag there with a name and a colour; rename, recolour, **Merge into…**
  another, or delete one (two clicks; the links stay). `W` `S` walk the tag's links, `A` `D` choose
  the previous or next tag. It starts with presets — *to-read, to-watch, to-try, reference, inspiration,
  work, personal, buy, dev, ai, design, news, video, shopping, music, games* — ahead of the tags
  already in use; a deleted preset stays deleted. The palette offers tags in the library's order.
- **Settings → Tags** lists every tag with its count: click one to rename it (a name already in use
  merges the two), × to delete it from every link.

Firefox gives extensions no access to bookmark tags, so tags live in the add-on's storage
(`linkTags`, and the library with its colours in `tagDefs`), and travel in both exports — each stashed tab and each capture carries its tags — and
come back with an import.

### Acting on a link — the same on every page

Links, Cards and Tags offer one set of actions on a link, drawn the same way and answering to
the same keys. There are four things to do with a link: **tag** it, **capture** it (save its text,
images and links), **remove** it, or **skip** it for now. Under the one link Cards and the Links detail pane show,
**Open**, **Tags**, **Capture** and **Remove** are buttons with their keys; on a row of List or Tags,
Tags, Capture and Remove show. Move, To list and removing the link's *other* copies sit under **⋯** —
nothing acts on more than the copy in front of you unless you pick it there. The keys are laid out
for a left hand on WASD: W S walk (walking on is skipping) and A D jump a group, as in a game. The
number row works as reddit's keyboard navigation (RES) has it.

| Key | Action |
|---|---|
| `W` `S` (`1` `2`, `↑` `↓`) | previous / next link; a sidebar and the view beside it move together; held, they repeat |
| `A` `D` | previous / next group: the section on Links (a stash, grouped by stash), the stash on Cards, the tag on Tags |
| `T` | tags |
| `E` (`3`) | capture: load it in a background tab and save its text, images and links |
| `Q` (`⌘⌫`) | remove this copy — from its stash, or from the reading list — then on to the next link |
| `4` | open — a stashed tab reopens through its stash, keeping its container and marking it restored |
| `⇧4` | open with the other stash effect: taken out of the stash if the setting keeps it, and the reverse |
| `L` `M` | to the reading list · move to another stash (a field filters the stashes) |
| `⌘Z` | undo — any of the above, a removal or a move included; a stash emptied by it is written again |
| `/` `?` `Esc` | filter · the key guide · back out |

The **key guide** draws these keys where they sit on the keyboard, docked in the bottom-right corner
of every page: each keycap names what it does, coloured by kind (moving, capture, remove, opening,
editing), keys the page has no use for are faint, and the key held down sinks and lights until it
is let go. `?` shows and hides
it until the page loads again: every page opens with it shown. It floats over the
page, which does not move when it shows or hides.

**Site icons** are each site's own favicon, saved from its tab when the tab is stashed, and on
the add-on's start from any open tab of a site already held (`favicons` in storage). Firefox's icon
is kept as data when it can be read, else as its address, which the page shows like any image. A
site with none saved yet shows a drawn icon: six common sites have one in `icons.js`, the rest a
letter.

**Filtered out.** Some pages are tools, not reading: an inbox, a home feed, Drive's home, your own
profile. They are still stashed with the rest, but a rule in **Settings → Filtered out** tags them
**filtered-out**, and Links and Cards keep them out of the pile and its counts; the **Filtered out**
chip on Links shows them again, and Tags lists them like any tag. A rule is one site's main page —
`reddit.com` is Reddit's front page and never a post; `*` stands for anything, as in
`mail.google.com/mail/u/*/#inbox`, which is the inbox but not an email under it. Saving applies the
rules to everything held, and new links are matched as they arrive; a rule taken away untags what
it tagged. Right-click a page → **Filter out this page** adds it.

**Hover previews.** Anything that names something held elsewhere previews it after a moment's
hover, in a card you can move into and click: a stash (its name, when it was stashed, its tabs, and
where this link sits among them), the other stashes holding a link, a tag (its newest links), a
link in a sidebar or on Tags (its text, picture, state, tags and where it is held), a site chip on
List (its links and how many are captured), and a source badge (where the link sits in the reading list or a
stash). Escape, a click elsewhere or leaving closes it. One module draws them all (`peek.js`): a page
marks an element with `Peek.mark(node, kind, id)`, and a new kind is one `Peek.kind()` renderer.

Whether a link was captured shows the same way everywhere: a **captured** badge (its date on hover)
or a dashed **not captured** on a row, card or the detail pane's header, and a page icon beside the title in Links'
rows and the Cards sidebar. A card also says when its tab was last restored.

Keep and Drop, the verdicts of versions before 5.38, are gone from the pages; marks already stored
stay in storage untouched, and nothing reads them.

Only walking repeats while held, so a held key cannot remove a run of links. Keys never act
while a field has the keyboard; `Esc` leaves it. What plain Open does to the stash is **Settings →
After restoring** on the Links page; `⇧4` does the other.

### Cards — one at a time

Open *Cards* and go through the links in the chosen sources as a shuffled deck, one card at a time —
every link, one tag, the untagged ones or those not captured, as the selector says. `T` tags the
card, `E` captures it, `Q` (or a drag left) removes its copy, `S` (or a drag right or up) skips it —
it comes back next session — and `W` steps back a card. The sidebar lists every stash on show and the reading list, the card's row marked as the
deck moves; `A` `D` deal the first link of the previous or next stash, and a click deals any row.

A card shows what is known. A captured page (`Ctrl+Shift+K`, or **Capture** on any page, key `3`)
carries its headline, text, embedded links, images and screenshot preview; a stashed tab never captured
shows only its tab title and address — `x.com/i/status/2086188444317819246` tells you nothing, so
capturing first makes a card worth looking at.

Removing takes out only the copy the card stands for, and `⌘Z` puts it back. Skipping records
nothing.

The deck is shuffled fresh each visit: ordered by date it would be 133 x.com cards in a row, and
mixing the domains keeps each card worth a look.

### Stashing tabs

OneTab's move, kept apart from the reading list. **Stash** (`Ctrl+Shift+S`, the popup, the page's
right-click menu, or right-click on the tab strip) folds tabs into a saved group and closes them:
the selected tabs if you have selected several, otherwise the whole window. The Links page, grouped
by stash, opens in their place.

The **Stash** submenu — on a page, and on a tab in the tab strip — and the ▾ beside the popup's
Stash button take other scopes too: **all tabs in this window** (even when several are selected),
**only this tab**, **tabs to the left**, **tabs to the right**,
**all except this one**, and **every window** (one stash per window). On the tab strip, "this tab" is
the one you right-clicked. **Never stash this site** in the same submenu puts a site on a list that
stashing leaves open; **Settings** on the Links page shows the list. Two commands without a
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

There is one List tab to show stashes in, like OneTab's tab: pin it, and stashing, the popup's
**Stashed** button and the menu all switch to that tab, grouped by stash, in whichever window it is,
instead of opening another. A new one opens only when none is open. Stashing a whole window while
the page is pinned in a different window closes the stashed window, as OneTab does. Until 5.14 this
was a separate Stashed tabs page; its address (`sessions.html`) now forwards to List grouped by
stash, so a tab pinned on it keeps working. Link Keeper's own pages are never stashed.

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
  last on a stash's heading); the row's **⋯** menu moves it up, down or to another stash. A stash emptied
  this way goes.
- **Export → Stashes** downloads every stash as JSON. **Import…** reads it back, and also OneTab's
  *Export URLs* text, a TidyTab export, CSV with a `url` column (optionally `title`, `group`,
  `date`), a JSON list of URLs, or any text with links in it — pasted or from a file — each group a
  stash under **Imports**, its heading marked *Imported · OneTab* and so on. Capture JSONL goes to the
  reading list instead. It says which format it took the input for before anything is written.
- A stash's **⋯** menu holds Rename, Delete…, and **Mark as imported** / **Mark as stashed from open
  tabs**, which moves it between the two sources. Stashes imported before 5.14 were not marked;
  the one known import of that time is marked by a data patch (below), any other by hand.

**The detail pane** (the bar's **Detail** toggle, or `V`) narrows the rows to a sidebar and shows
the selected one in full beside it — Explore, before 5.43, was this as a page of its own, and its old
address now opens Links with the pane. Click any row or walk with `W` `S`, the pane following; `A` `D`
jump a section, and Space / ⇧Space scroll a long pane. It shows the link's capture, whether it is on
the reading list or in other stashes, and how many links share its site, with the usual actions.
Two more toggles in the bar, each remembered: **Compact** shows a row as its icon and title only (on
by default with the pane, and then hovering a title previews the link), and **Stash tools** shows or
hides the buttons on stash headings. `?stash=<id>` opens one stash alone, with an **Only … ×**
banner to show everything again; a stash's hover preview links there.

The **live preview**, inside the detail pane, shows the page itself, half a second after you land on a
link: **Off** as each link opens, **This link** (`P`) for the link you are on only, or **Keep on** for
every link until turned off — the one setting remembered. Most sites
forbid being framed, so for frames opened from Link Keeper's own pages only, a `declarativeNetRequest`
rule removes `X-Frame-Options` and the `Content-Security-Policy` header from the response (all-sites
access is asked on the first preview). Removing them through `webRequest` does nothing: Firefox
enforces them anyway, as `tools/preview-frames/test-preview-frames.zsh` shows. The frame is sandboxed without top navigation, and it loads logged out — Firefox keeps
a framed page's cookies apart. Local files and browser pages cannot be framed at all.

`node tools/test-stash.mjs` runs the stash code against a fake browser and bookmark tree with 349
tabs and checks that every tab is either still open or recorded, and that a restore brings each one
back, through scopes, locks, drags, imports and the move into bookmarks.
`tools/run-in-headless-firefox.zsh --extension extension tools/e2e-stash.js` runs the same paths in
a throwaway headless Firefox — real tabs, real bookmarks, a temporary profile — and
`node tools/test-stash-import.mjs` checks every import format.
`tools/test-open-local-files.py` checks the helper's refusals without opening anything.

### The Links page

*Open list* in the popup opens it — the readable view when there are hundreds of links, rather than
a 22rem popup.

- **Group by** Stash (each stash under its heading with its actions, then the reading list's links),
  Domain (local files and browser pages under their own names), State, Day, Month, or flat newest-
  or oldest-first. Grouped by stash, a URL in two stashes is a row in each; everywhere else it is
  one row.
- Filter box searches URLs, titles, captured text, notes and embedded links; domain chips narrow to
  sites.
- State chips narrow to what is left (never opened, restored or read), seen, kept or dropped.
- A state mark per row, told apart by shape as well as colour: a ring for left, a dot for seen, a
  tick for kept, a cross for dropped. The reading list's current item carries a *Current* badge and
  a line down its left edge.
- Rows show the captured title, the post's text and any links found inside it, so a tweet you
  already read is legible without opening it again.
- Per row: **Tags**, **Capture** (or **Capture again**) and **Remove** (this copy), and **⋯** holds
  Open or **Open in this tab**, Move, **To list**, the stash moves when grouped by stash, and a
  **Remove from …** for each *other* place it is held.

**Duplicates (N)…**, shown when any link is held in more than one place among the sources on show
(two stashes, or a stash and the reading list), lists each such link with a checkbox per copy:
which stash, when, and its place in it, or its reading-list status. Nothing starts ticked, a locked
stash's copy cannot be, and **Remove N copies** asks once, then removes only what was ticked — saying
so when a link would lose every copy.

Clicking a reading-list title opens it in a new tab and marks that entry current, so a
`Ctrl+Shift+K` there attaches the capture to the right list entry; clicking a stashed tab's title
reopens it through its stash, in its container.

### Filling the list

- **`Ctrl+Shift+U`** or the popup's **+ List** — queue something for later while browsing.
- **Paste URLs** into List's **Import…** and choose *Links on the reading list*, one per line. Each
  line may carry the date the link was originally saved, tab or space separated — which is exactly
  what the scripts in `importers/` produce:

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

**Capture with a full-page screenshot** (the ▾ beside the popup's Capture) — one action. It reads the page, then scrolls it a screenful at a time, shoots each
viewport, and stitches the tiles into a single PNG named after the post. Leave the tab alone for a
second while it walks the page.

Files land in `~/Downloads/link-keeper/`, and the subfolder is configurable in List's **Settings**. It cannot be moved out of Downloads: the `downloads` API resolves filenames against
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

Then, in the list page, **Import…** → choose the file or paste it. Those links arrive already captured, so
their cards show their text straight away.

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
just want to paste into List's Import instead.

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

x.com renders replies lazily, so a plain **Capture** sees only what has scrolled into view. **Capture
with a screenshot** walks the entire page to stitch its screenshot and therefore sees far more of them — worth
using on anything flagged `needs_replies`.

### Getting the data out

List's **Export** menu writes `link-captures.jsonl` (captures), `link-worklist.jsonl` (the reading
list, with each entry's status, if you want to see what you skipped) or every stash as JSON, to
Downloads. Nothing clears the store in bulk, so exporting twice is fine.

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
- **Data patches.** A fix to data already stored ships as an entry in `DATA_PATCHES`
  (`extension/background.js`). Each runs on the first launch of the version that brings it and is
  recorded in `dataPatches` in the add-on's storage, so it never runs twice — even if the data it
  touched changes later. A patch acts only when its fingerprint matches exactly, and otherwise
  records why it skipped; one that fails is retried next launch. The first marks the 29 Sep 2026
  OneTab import (8 stashes written within ten seconds, identified by that window and their tab
  counts) as an import.
- There is no bulk clear or reset: links, captures and stashes go one at a time (or the copies
  ticked in Duplicates), each after a confirm where it cannot be undone.
- Article bodies are read with `innerText`, not `textContent`, so paragraph breaks and code
  blocks survive. Plain tweets collapse whitespace, which is fine at that length.
- Images are not captured — text only. A chart in an article is lost; its surrounding prose is not.
- x.com's markup is read through `data-testid` attributes, the most stable handle it exposes.
  If a capture comes back thin, x.com renamed something; `fallback_text` holds the visible
  article text so the capture is still worth keeping, and the fix is one selector.

## Licence

AGPL-3.0. See `LICENSE`.
