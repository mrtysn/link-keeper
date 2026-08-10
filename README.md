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

## Install

Requires Firefox 128 or newer. No build step, no dependencies.

`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select
`extension/manifest.json`.

Temporary add-ons unload when Firefox restarts. For a permanent install, submit the
`extension/` directory to [AMO](https://addons.mozilla.org/developers/) as an unlisted add-on
and install the signed `.xpi` it returns. Unsigned permanent installs work only in Developer
Edition or Nightly with `xpinstall.signatures.required=false`.

## Use

Three keys, and you never leave the tab you are in.

| Key | What it does |
|---|---|
| `Ctrl+Shift+J` | load the next link from the list in the current tab |
| `Ctrl+Shift+K` | keep this page — read it and store the capture |
| `Ctrl+Shift+U` | add the page you are on to the list |
| `Ctrl+Shift+X` | skip this one — an explicit rejection — and advance |

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
for attaching a note to the next thing you keep.

### Cards

*Cards* — from the popup, the right-click menu, or the list page — deals the links still awaiting a
verdict as a shuffled deck, one at a time. Drag the card or use the arrow keys: right keeps, left
skips, up defers. `o` opens the link in a tab, `u` undoes.

Cards judge **URLs**, not pages. Reading a page's text needs that page open in your tab, which is
what *Keep* in the popup does — so a card marked kept records the verdict without a capture, and
*Open ↗* is there for the ones you cannot judge from the URL alone. Any capture a link already has
shows on its card: title, text, images, and the screenshot preview.

The deck is shuffled fresh each visit. Ordered by date it would be 133 x.com cards in a row, and
mixing the domains keeps each card an actual decision. Verdicts save as you go, so closing the tab
mid-deck loses only the shuffle.

### Seeing the whole list

*See the whole list* in the popup opens a full page — the readable view when there are
hundreds of entries, rather than a 22rem popup.

- Grouped **by domain** by default, or by status, or flat newest-first.
- Filter box searches URLs, captured titles, tweet text, notes and embedded links.
- Status chips narrow to what is left, seen, skipped, or kept.
- Rows show the date the link was saved; a dimmed date means only the paste date is known.
- A coloured dot per row: grey pending, amber seen, green kept. The current item is marked
  down its left edge.
- Rows show the captured title, the post's text and any links found inside it, so a tweet you
  already read is legible without opening it again.
- Per row on hover: **open** (loads it in this window and makes it current), **kept** to
  toggle the verdict by hand, **remove** to drop it from the list.
- **remove all** per group, and **Tidy** to clear every finished entry at once. Neither
  touches your captures.

Clicking a title opens it in a new tab and marks that entry current, so a `Ctrl+Shift+K`
there attaches the capture to the right list entry.

### Filling the list

- **`Ctrl+Shift+U`** or *This page* — queue something for later while browsing.
- **Paste URLs** into *Add links*, one per line. Each line may carry the date the link was
  originally saved, tab or space separated:

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
