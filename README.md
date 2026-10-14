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
| `native/` | the helpers Firefox starts for the add-on, registered by `native/install.zsh`: `open-local-files.py` reopens stashed local-file tabs; `link-keeper-bridge.py` backs the add-on's storage up to disk and lets local agents reach it (see *Backups and agents*) |
| `mac/` | the Link Refresh app: its project-lifecycle manifest (`project-lifecycle.json`), icon and `write-launcher.zsh`, which writes the launcher the bundle runs; `project-lifecycle -C mac install` builds, signs and installs it |
| `tools/` | `refresh.zsh` — the one command that rebuilds everything from the newest exports<br>`extension-diff.py` — read the add-on's storage out of the Firefox profile and list the captures it does not hold yet<br>`link-keeper.mjs` — the agents' CLI: read and change links, tags, captures and stashes, live from Firefox or from the latest backup (`--help`)<br>`test-bridge.mjs` — check the bridge and the CLI against a stand-in extension<br>`test-bridge-firefox.zsh` — check backups, restore, agent undo and the CLI in a headless Firefox<br>`release.zsh` — ship a batch: bump the version, sign on AMO, open it in Firefox, commit the release (once per finished batch; AMO allows 24 signings a day)<br>`fetch-signed-xpi.py` — download a version AMO signed after web-ext stopped waiting<br>`stash-status.py` — list the tab stashes the add-on holds, read out of the profile's bookmarks<br>`survey-stashed-sites.py` — count stashed links per site, and show which pages of a site are main pages or items (for the filtered-out rules)<br>`test-stash.mjs` — run the tab stash against a fake browser and prove no tab is lost<br>`test-stash-import.mjs` — check every format the stash import reads<br>`run-in-headless-firefox.zsh` — run a WebExtension script, alone or beside the real extension, in a throwaway headless Firefox, its bridge helper pointed at temporary folders so the real backups are never read or written<br>`e2e-stash.js` — the stash checks that script runs against real tabs and bookmarks; each check starts from empty stashes, list and tags and waits on what a page draws, never on a delay<br>`test-extractors.zsh` — check in headless Firefox that an x.com capture holds every rendered reply, and that a page walk gathers the ones x.com drops while scrolling, against the saved pages in `extractor-fixtures/`<br>`test-instagram-export.py` — check the Instagram importer against a made-up export: threads, accounts, origins<br>`test-refresh-instagram-accounts.zsh` — run `refresh.zsh` on made-up exports for two accounts, in a temporary repo with its own config<br>`test-open-local-files.py` — check the local-file helper refuses everything but existing files<br>`preview-pages/preview.zsh` — render the popup, Links, Cards and Tags in any browser with a fake extension API and real capture text<br>`preview-frames/test-preview-frames.zsh` — check in headless Firefox that the Links detail pane's live preview frames sites that forbid framing, and nothing else can<br>`preview-pages/test-keys.zsh` — drive Links (with and without its detail pane), Cards, Tags and the popup in that preview with the shared keys and check each action and its undo, the tag library, the tag palette and the hover previews<br>`captures-to-html.py` — render an exported capture JSONL as one browsable page<br>`telegram-messages-to-html.py` — render a Telegram export, flagging which messages migration made redundant<br>`telegram-saved-links.py` — a swipe-to-triage page for a Telegram export's raw links, keep/drop/defer<br>`watch-reel.zsh` — turn an Instagram reel or carousel into a transcript, keyframes and slides an agent can read<br>`chat-to-watchlist.py` — render a chat export of film links as one page with IMDb, Metacritic and RT scores<br>`reels-to-captures.py` — convert those packs into capture records the extension displays<br>`tag-model/` — learn the owner's tags and suggest them for untagged links (see *Tag suggestions*) |

## Backups and agents

Firefox deletes an add-on's storage when the add-on is uninstalled: tags, captures, the reading
list, the tag library, filter rules and settings would go with it. Stashes are bookmarks and stay.
So the add-on keeps a copy on disk, through `native/link-keeper-bridge.py`:

1. Set `LINK_KEEPER_BACKUP_DIR` in `config.local.sh` (see the example), then run `native/install.zsh`.
2. From then on, about a minute after any change, the whole storage and the stashes are written to
   `latest.json` in that folder, and the first backup of each day to `backup-YYYY-MM-DD.json`
   (30 days kept). Settings → Backups shows the last one and restores any file, saving the current
   state to `pre-restore-*.json` first.
3. Storage that starts empty — a reinstall, a new profile — is filled from `latest.json` by itself;
   with no stashes left either, the backup's stashes are written again.

The same helper serves a Unix socket, readable by your user only, for `tools/link-keeper.mjs`
(`link-keeper` on the PATH): local agents read links, tags, captures and stashes, and change them
the way the pages do. With Firefox closed it reads the latest backup instead. Each change an agent
makes is journaled with what it replaced; `link-keeper undo` puts the last one back, and refuses
if you changed the same data since. Nothing an agent sends opens, closes, captures or navigates a
tab. The open connection keeps the add-on's background page awake while Firefox runs.

## After an export: one command

    link-refresh

or, on macOS, ⌘-space → **Link Refresh**. `project-lifecycle -C mac install` builds that into
`~/Applications`, signed with the local certificate (the bundle holds a shell-script launcher,
written by `mac/write-launcher.zsh`), and it reports what happened as a notification. An app launched from Spotlight inherits almost no PATH, so the runner restores asdf's
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

A URL is one link wherever it is held (a trailing slash, `www.` and a plain `#anchor` do not make a different one; a
`#fragment` holding a `/`, like Gmail's `#inbox/<message id>`, does). In a joint view it shows once, with badges saying where it
is (*Reading list*, *Stashed*, *Imported ×2*). Its tags and its capture belong to the URL, so every
copy shows them; removing acts on one copy, the one in front of you. Nothing is merged or deleted underneath: a stash keeps its bookmarks and the list its
entries.

### Tags

A tag belongs to a link — the URL wherever it is held — so tagging it on Links shows on its Cards
copies too. Until a link has tags of its own, what kind of site it is shows in their place,
dashed: `code` (GitHub, GitLab…), `video`, `post`, `discussion`, `game`, `paper`, `doc`, `article`,
`local file`. Guesses are never saved; the first change in the editor makes the shown tags yours,
and removing every tag brings the guess back.

**Suggestions** from a local model take the guesses' place, dimmed the same way, until the link has
tags of its own: a chip's hover says who suggested it and how sure — *Suggested by your tag model
(82%)*, *by Laya* (system-one) or *by Gutsy* — and the editor's status line lists them. A tag two
sources both suggested shows once, its hover naming each: *Suggested by Laya (90%) and Gutsy (60%)*;
chips run in order of their highest percentage. In Cards a link with stored suggestions also gets a
labelled **Suggested** row under the title, dashed so it reads as not yet your tags: each tag with
every source's mark (L Laya, G Gutsy, M your tag model) and percentage, and an *F to accept* hint. `F` accepts everything shown
as the link's tags in one step (site guesses too) and, in Cards, deals the next card; `⌘Z` takes it
back. To fix one instead, open the editor and change it: the first change saves what was shown plus
the change, so removing one wrong suggestion keeps the rest. They are stored apart from tags
(`tagSuggestions`, `{ [link key]: { at, tags: [{ tag, p, by }] } }`, `p` 0–1, `by` `system-one`, `gutsy` or
`model`; any other `by` is stored as `system-one`, and one tag may be held from several sources) and written only by agents: `link-keeper suggest-set FILE [--replace]` (FILE is JSON
`{url: [{tag, p, by}]}`; an empty list removes a link's entry), `link-keeper suggestions` for what is
stored, and `link-keeper links --json` carries `suggested` per link (empty once it has tags). The
entry stays in storage after the link is tagged, unshown.

**Agent tags** are a third layer, written by Claude agents and never counted as your tags. Each link
shows them in a row of their own after yours, labelled **agent**, as outlined chips: your tags are
filled, a suggestion's dashed, an agent's solid-outlined, so the three differ in form as well as place.
The row is on Links (the detail pane's editor), List, Cards (under the title, after any Suggested row),
the tag library's link lists and the tag editor, and a chip's hover names the model. They are stored
apart (`agentTags`, `{ [link key]: { at, by, tags: [name] } }`, `by` the model such as `haiku`), change
neither your tags nor the suggestions, and `F` still accepts only the suggestions. Agents write them with
`link-keeper agent-tags-set FILE [--replace] [--by NAME]` (FILE is JSON `{url: [tags]}`; an empty list
removes a link's entry; the message is `set-agent-tags`, journaled so `undo` reverts it) and read them with
`link-keeper agent-tags`; `links --json` carries `agentTags` and `agentBy` per link.

- `F` accepts the shown suggestions (or site guesses) as the link's tags; Cards moves on to the next card.
- `T` on any page opens the editor: the link's chips, a field, and under it a palette of every tag
  there is — click one, or press `1`–`9` on the empty field, to put it on or take it off. Typing
  narrows the palette (spaces and punctuation ignored, so `gamejam` finds *game jam*); Enter or Tab
  takes the first match, and a name the palette lacks is offered as **+ new tag**. Backspace takes
  the last tag off; Escape stops. Every change is saved at once. the Links detail pane has the editor in its
  detail pane, and Cards opens it over the card.
- **Tagging many in a row** works on every page: Enter on the empty field moves to the next link
  with its editor already open, so `T`, type, Enter, Enter, type, … runs down the links; Escape
  stops. Narrow first to the links that need it: **Untagged** is a tag chip on Links, and
  an option in Cards' tag selector. Cards' **Suggested** deals only the untagged links holding
  stored suggestions, most confident first, so `F` and a fix clear them quickly.
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

### Tag suggestions

`tools/tag-model/` learns the tags you set and suggests them for links with none. Until a tag has
at least 50 links, two local decision servers guess it, each asked the same one yes/no question per
tag about the link's title, site and the first 1,500 characters of its captured text: **system-one**
(Laya backend; `by: "system-one"`, kept at P(yes) 0.85) and **gutsy-inference** (`by: "gutsy"`, kept
at 0.50). A link can carry the same tag from both; each source keeps up to four tags per link. Once a tag has the examples,
a **Jeffy** classifier (a frozen English sentence encoder, `BAAI/bge-large-en-v1.5`, about 1.3 GB
downloaded once, with a logistic-regression head per tag) trained on your own tagging takes over for
that tag. A head is kept only if its held-out precision is at least 0.7; otherwise system-one keeps
that tag, for both servers. Links carrying `filtered-out` are ignored. Personal tags — what you mean to do with a link
(`to-read`, `to-try`, `reference`, …) or an idea of yours (`leverage`, `numbness`, …), listed in
`PERSONAL_TAGS` in `tagdata.py` — are never asked of system-one, since a page's text cannot show
them; they are suggested only once a head trained on your tagging holds them.

    tools/tag-model/run.zsh --setup      # once: the Python environment (uv)
    tools/tag-model/run.zsh              # train, then suggest and send (link-keeper suggest-set --replace)
    tools/tag-model/run.zsh --no-write   # the same, but only write suggestions.json

or step by step, from `tools/tag-model/` with `uv run python`: `train.py` (`--min-positives`,
`--min-precision`, `--threshold`), `suggest.py` (`--limit N` for a trial, `--system-one-only`,
`--no-gutsy`, `--system-one-threshold`, `--gutsy-threshold`, `--write`), `suggest_system_one.py --limit 10` (times system-one on ten links and prints the
estimate for all). `tools/refresh.zsh` runs `run.zsh` in the background after each refresh when the
environment is set up, and says so when it is not. system-one is globally disabled; the scripts
start it for the run only if it is not running and stop it afterwards only if they started it.
gutsy-inference is found through `GUTSY_DIR` in `config.local.sh` (its install folder, with `.venv/`
and `models.json`); the run starts `gutsy-inference serve` on 127.0.0.1:8765 when nothing listens
there, waits for `/health`, and stops it only if it started it. With `GUTSY_DIR` unset the gutsy pass
is skipped with one line. About 3 s per link on CPU, so the first full run takes over an hour.

Everything they write sits in `<data dir>/tag-model/` (`DATA_DIR`, else this repo's `data/`):
`embeddings.npz` (encoder output per link text), `heads/<tag>/` (the Jeffy model packs),
`metrics.json` (per tag: positives, held-out precision and recall, enabled or why not),
`system-one-answers.json` and `gutsy-answers.json` (so a rerun asks only about new links), and `suggestions.json`, the
file sent to the add-on. A one-line meaning for an abstract tag (the question system-one is asked)
comes from `tag-meanings.json` in that folder when you add one, else from a built-in list in
`tagdata.py`. Tests: `cd tools/tag-model && uv run pytest test_tag_model.py`.

`compare_backends.py --b-port PORT` asks system-one and a second server with the same wire shape
(gutsy-inference serves on 8765) the same tag questions about English links with captured text, and
writes `compare/answers.json` and `compare/compare.md` in that folder: speed, agreement and every
link where they differ. With `--labelled` it scores both against the links you have tagged.

#### Agent tags

`tools/tag-model/agent_tag.py` has Claude Haiku (`claude -p`, no CLAUDE.md, rules or hooks loaded)
tag your links with tags from your own library: 0 to 5 per link, only ones that clearly fit, never
a tag outside the list. It sees each tag with its one-line meaning, and each link's title, site and
the first 1,500 characters of its captured text. It runs only when you ask, and every call spends
Claude tokens (25 links per call, three calls at a time).

    cd tools/tag-model && uv run python agent_tag.py             # links with no agent tags yet
    uv run python agent_tag.py --limit 50 --no-write             # a trial; --all retags everything

Each batch is cached in `<data dir>/tag-model/agent-tags.json` (keyed by the link's text), so a
stopped run resumes where it stopped; the result, `{url: [tags]}`, is written to
`agent-tags-set.json` beside it and sent with `link-keeper agent-tags-set FILE --by haiku` (merges;
`--all` replaces). `--no-write` only writes the file and prints that command.

### Acting on a link — the same on every page

Links, Cards and Tags offer one set of actions on a link, drawn the same way and answering to
the same keys. There are four things to do with a link: **tag** it (`T`, or `F` to accept what is suggested), **capture** it (save its text,
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
| `F` | accept the suggested tags as the link's tags (Cards then deals the next card) |
| `E` (`3`) | capture: load it in a background tab and save its text, images and links |
| `Q` (`⌘⌫`) | remove this copy — from its stash, or from the reading list — then on to the next link |
| `4` | open — a stashed tab reopens through its stash, keeping its container and marking it opened |
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
**filtered-out**, and Links and Cards keep them out of the pile and its counts; Links' filters
are **All** (the pile), split with nothing left over into **Captured**, **Not captured** and
**Local & browser** (files and browser pages, which cannot be captured), and **Filtered out**, which
shows only these, apart from the pile; Tags lists them
like any tag. A rule is one site's main page —
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
rows and the Cards sidebar. A card also says when its tab was last opened.

Keep and Drop, the verdicts of versions before 5.38, are gone from the pages; marks already stored
stay in storage untouched, and nothing reads them.

Only walking repeats while held, so a held key cannot remove a run of links. Keys never act
while a field has the keyboard; `Esc` leaves it. What plain Open does to the stash is **Settings →
After opening** on the Links page; `⇧4` does the other.

### Cards — one at a time

Open *Cards* and go through the links in the chosen sources as a shuffled deck, one card at a time —
every link, one tag, the untagged ones or those not captured, as the selector says. `T` tags the
card, `F` accepts its suggested tags and deals the next card, `E` captures it, `Q` (or a drag left) removes its copy, `S` (or a drag right or up) skips it —
it comes back next session — and `W` steps back a card. The sidebar lists every stash on show and the reading list, the card's row marked as the
deck moves; `A` `D` deal the first link of the previous or next stash, and a click deals any row.

A card shows what is known. A captured page (`Ctrl+Shift+K`, or **Capture** on any page, key `3`)
carries its headline, text, embedded links, images and screenshot preview; a stashed tab never captured
shows only its tab title and address — `x.com/i/status/2086188444317819246` tells you nothing, so
capturing first makes a card worth looking at.

Removing takes out only the copy the card stands for, into the Trash, and `⌘Z` puts it back. Skipping records
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
Keep/Drop mark, when it was opened, and a stash's lock and star — sits beside it in the add-on's
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
- Stashes run one at a time: a key, menu item or button that fires twice runs the second after the
  first has closed its tabs, so it finds them gone instead of recording them again.
- Only the URL, the tab title and the tab's container are recorded. Nothing runs inside the tabs.
- A stash is the only record of the tabs it closes (Firefox remembers 25 closed tabs), so no tab
  closes until every bookmark has been read back and found present. If writing fails partway, the
  half-written folder is taken back out and nothing closes.
- **Open all** reopens every web page unloaded — each one loads when you switch to it — in its
  original container. By default the stash stays, with each entry marked opened; **Settings** can
  make opening take the tabs out instead, as OneTab can. A tab's back/forward history does not
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
  no move to the list or dragging out, and opening always keeps it.
- Drag a row to reorder it or drop it into another stash (ahead of or after the row it lands on, or
  last on a stash's heading); the row's **⋯** menu moves it up, down or to another stash. A stash emptied
  this way goes.
- **Export → Stashes** downloads every stash as JSON. **Import** reads it back, and also OneTab's
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
- State chips narrow to what is left (never opened or read), seen, kept or dropped.
- A state mark per row, told apart by shape as well as colour: a ring for left, a dot for seen, a
  tick for kept, a cross for dropped. The reading list's current item carries a *Current* badge and
  a line down its left edge.
- Rows show the captured title, the post's text and any links found inside it, so a tweet you
  already read is legible without opening it again.
- Per row: **Tags**, **Capture** (or **Capture again**) and **Remove** (this copy), and **⋯** holds
  Open or **Open in this tab**, Move, **To list**, the stash moves when grouped by stash, and a
  **Remove from …** for each *other* place it is held.

**Duplicates (N)**, shown when any address is held in more than one place among the sources on show
(two stashes, or a stash and the reading list; addresses are compared as written, `#fragment` included,
so Gmail's messages, which differ only by it, are not duplicates of one another), lists each such link
with a checkbox per copy:
when, which stash, and its reading-list status, newest first; a card with more than five copies shows
three and "+N more". Nothing starts ticked, and a locked stash's copy cannot be. A card's **Keep newest**
and **Keep oldest** tick every other copy, **Tick all** every one; the same two for every card sit above
the list. **Move N copies to Trash** needs no confirm, since the Trash undoes it, except when some link would
be left with no copy outside the Trash; the footer counts what is ticked and says so.

**Trash (N)**, always beside Duplicates (N = 0 when empty), lists what was removed, one card per removal, each row saying how many days remain.
Everything removed from a stash or the reading list — Q, a stash's Delete, Duplicates, the CLI's
`remove`, **Clear dropped** — waits there for 30 days (the add-on's storage, key `trash`, so backups
carry it). **Restore** puts a tab back in its stash at its old place with its marks, writing a deleted
stash again once, and a reading-list link back on the list; **Delete forever** and **Empty Trash** ask
first. Moving a link (to the list, between stashes), opening tabs with "take out of the stash", and
undoing a move leave nothing in it; `⌘Z` after a removal takes its entry out again. Entries older than
30 days are dropped whenever the Trash is read, and at start. A capture removed through the CLI's
`remove --capture` is not kept.

Clicking a reading-list title opens it in a new tab and marks that entry current, so a
`Ctrl+Shift+K` there attaches the capture to the right list entry; clicking a stashed tab's title
reopens it through its stash, in its container.

### Filling the list

- **`Ctrl+Shift+U`** or the popup's **+ List** — queue something for later while browsing.
- **Paste URLs** into List's **Import** and choose *Links on the reading list*, one per line. Each
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

Then, in the list page, **Import** → choose the file or paste it. Those links arrive already captured, so
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

**Other people's threads, and several accounts.** `instagram.py --list-threads export.zip` prints every
thread with its link count, most links first; the name in the second column is the thread's slug.
`--thread SLUG` (repeatable) reads that thread besides the self-thread, and `--account NAME` stamps each
record with the account, because an export does not say whose it is. Each record then carries
`account`, `thread` (a list: a link met in several threads is one record) and `senders` (each distinct
person who sent it; you count once however often), stored with it
but shown in no main view. For several accounts, put each account's exports in its own folder and name
the threads to read in `config.local.sh` (`config.local.sh.example` shows the layout):

    INSTAGRAM_ACCOUNTS_DIR=$HOME/Downloads/instagram-accounts    # holds main/, side/, ...
    IG_ACCOUNTS[main]="alice_123 bob_456"
    IG_ACCOUNTS[side]=""                                          # self-thread only

With a single account and no folders, `IG_THREADS="alice_123 bob_456"` in `config.local.sh` names the threads to
read. `refresh.zsh` then reads the newest export of each account. Links to other sites go through the enrichers
as plain `URL<TAB>date`, which cannot carry the origin, so `importers/attach-dm-origin.py` puts `account`,
`thread` and `senders` back on their records after the merge. A link two accounts both hold becomes
one record naming both (`account` is then a list) with every sender and thread. Without `IG_ACCOUNTS` the old single-export setup is unchanged.

`tools/refresh.zsh --offline` brings a new Instagram dump in with no internet: it parses the dump, keeps the
x.com and web lookups the last full run left, and hands the result to the extension, skipping the phone inbox, the
Saved Messages puller, the lookups, the reel downloads and the tag suggestions. Links to other sites inside the
dump and any new Telegram links wait for the next full run. The extension skips a link it already holds, so
repeating an import is safe.

When an export will not do, `docs/browser-agent-dm-run.md` is the brief for a Chrome-agent run over named DM threads:
the approval, request count and stop rules it needs first, and the records it returns, which the refresh
merges from `link-captures-extra.jsonl`.

A reel is a video, so a captured URL is not yet captured content. `tools/watch-reel.zsh` closes that
gap: it downloads the MP4 anonymously (yt-dlp, no login involved), transcribes the audio locally
(mlx-whisper), and extracts one frame per second — a watch-pack an agent can read instead of a video
only a human could watch. Idempotent per reel; point it at a capture file with `--from`. A carousel post is not a video at
all, so it is saved slide by slide instead — each image at full size, each video slide with its own
frames and transcript — which is what a post whose slides *are* the content needs. Each pack also gets
`sheet.jpg` (a contact sheet of the *distinct* frames, at most 24 tiles of 240 px, and `sheet-2.jpg` when
there are more; a carousel's video slides get `s02-sheet.jpg` and so on) and a one-page `summary.md`
(caption, duration, the first 1,200 characters of the transcript, the tile times). An agent reads those
first, a few thousand tokens instead of about 880 per per-second frame, and opens `frames/` only on demand.
`watch-reel.zsh --summarize <packdir|shortcode>...` or `--summarize-all` adds them to packs that already
exist, offline; it skips a pack that has a `summary.md` unless given `--force`.

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

### The replies

Keeping an x.com post also stores every reply rendered below it, in `replies`. Half the reason a tweet
gets saved is a tool it names but does not link — "repo in the comments" — and no API exposes reply
bodies. They exist only in a rendered, logged-in page, so this is the one thing scraping does that
fetching cannot.

One entry per reply, the post itself left out:

```json
{
  "handle": "@somehandle", "name": "Some One",
  "text": "Repo: github.com/a/b and docs a.dev/docs",
  "posted": "2026-08-09T14:52:00.000Z",
  "url": "https://x.com/somehandle/status/2009295999999999901",
  "likes": 30, "replies": 1, "reposts": 4, "views": 2400,
  "self": true,
  "images": ["https://pbs.twimg.com/media/AAAA?format=jpg&name=orig"],
  "video": false, "video_posters": [],
  "links": [{ "href": "https://t.co/repo1", "display": "github.com/a/b", "resolved": "https://github.com/a/b" }]
}
```

`text` is whole, with its line breaks and emoji. The four counts are integers read from the action
buttons, the views link and the action group's label (`1.2K` is 1200), and null where the page shows
none of them. `self` marks a reply by the post's own author; `images` are rewritten to `name=orig` as
in the post's own `images`; a reply with a video has `video: true` and the still frame it shows in
`video_posters`.

`reply_links` stays beside it: the links among the replies, repeats dropped, the author's own reply
first because that is where an author parks the link, each with `from`, `self` and the first 160
characters of its reply as `context`. `replies_scanned` is the number of replies. In the list and the
deck those chips are outlined in green and prefixed `↩`, under a count of the replies kept.

x.com renders replies lazily and drops the ones scrolled out of view, so a plain **Capture** holds only
what is on screen. **Capture with a screenshot** walks the entire page to stitch its screenshot and reads
the replies at every stop of the walk, so the ones x.com unloads while scrolling are kept too, each once
by its own address — worth using on anything flagged `needs_replies`. `link-keeper capture URL` prints
them one to a line, and `--json` returns the whole list.

Replies end where x.com's recommendation section begins ("Discover more", "More posts", "Sourced from
across X"), which uses the same post elements in the same timeline: the first conversation cell that
holds a heading and no post marks it, by its English wording or, in any language, by being a heading
cell below a post. Posts after it are never stored as replies or reply links, and the walk stops
reading once it has been in view.

`tools/test-extractors.zsh` checks all of this in headless Firefox against saved pages in
`tools/extractor-fixtures/`: one unloads its replies as it scrolls, and two end in a recommendation
section, one of them showing its heading only after scrolling.

### Getting the data out

List's **Export** menu writes `link-captures.jsonl` (captures), `link-worklist.jsonl` (the reading
list, with each entry's status, if you want to see what you skipped) or every stash as JSON, to
Downloads. Nothing clears the store in bulk, so exporting twice is fine.

## What gets extracted

`extractors.js` is a registry of site handlers with a generic fallback. A handler that returns
nothing degrades to the generic result rather than failing the capture.

| Site | Beyond title and description |
|---|---|
| x.com, twitter.com | author, handle, full tweet text, posted time, quoted tweet, media kinds, embedded links, every rendered reply |
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
  ticked in Duplicates), each moved to the Trash for 30 days; Delete forever and Empty Trash ask first.
- Article bodies are read with `innerText`, not `textContent`, so paragraph breaks and code
  blocks survive. Plain tweets collapse whitespace, which is fine at that length.
- Images are not captured — text only. A chart in an article is lost; its surrounding prose is not.
- x.com's markup is read through `data-testid` attributes, the most stable handle it exposes.
  If a capture comes back thin, x.com renamed something; `fallback_text` holds the visible
  article text so the capture is still worth keeping, and the fix is one selector.

## Licence

AGPL-3.0. See `LICENSE`.
