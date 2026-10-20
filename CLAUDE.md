# link-keeper

A Firefox extension (`extension/`) and the tools around it (`tools/`). The README describes both.

## Layout: where each capability lives

Search the whole repo before saying a capability is missing. `extension/` is only the display and
capture side; fetching, transcribing and importing happen outside it. README.md's Layout table lists
every script with its purpose; every script's second line is `# DESC:`.

| Folder | Holds | Kind |
|---|---|---|
| `extension/` | the Firefox add-on: Links, popup, capture queue, stash, extractors | code |
| `tools/` | `import-links.zsh` (the import: Links' Import from exports), `watch-reel.zsh`, `read-frame-text.swift`, `extract-reel-resources.py`, `reels-to-captures.py`, `link-keeper.mjs` (agents' CLI), `release.zsh`, all tests and checkers | code |
| `importers/` | export parsers and link enrichers: Telegram, Instagram, X archive, x.com and web lookups | code |
| `native/` | helpers Firefox starts: the bridge (backups, shell socket, import, watch) and the local-file opener | code |
| `receiver/` | HTTP endpoint on an always-on box; the phone's shares land in its inbox | code |
| `android/` | the share-sheet app that posts to the receiver | code |
| `docs/` | handoffs, format notes, chat-page surveys | docs |
| `assets/` | icon variants | data, committed |
| `data/` | built-in default DATA_DIR: rebuilt JSONL, HTML views, reel packs | data, gitignored |
| `TODO.md`, `config.local.sh(.example)` | open work; machine paths and settings (the `.example` is committed, the real file is not) | |

Pipeline, in order:

1. **In:** phone share sheet (`android/` to `receiver/` inbox), Telegram (export or `importers/telegram-pull.py`
   for Saved Messages), Instagram "Download your information" export, X archive DMs, and the browser itself
   (stash import, popup, chat grab in `extension/chat-grab.js`).
2. **`tools/import-links.zsh`:** finds the newest exports; mirrors the phone inbox; runs the importers and the
   x.com/web enrichers; merges `link-captures-extra.jsonl` (hand-recovered records, never overwritten);
   downloads new Instagram reels into watch-packs; suggests tags; rebuilds the HTML views; then serves the
   result on loopback. `--offline` skips everything that touches the network.
3. **Watch-packs:** `tools/watch-reel.zsh` downloads a reel or carousel and builds a pack (video, whisper
   transcript, keyframes, contact sheet, slides) under `REELS_DIR` (default `data/reels`). It is Instagram only.
   Each pack gets `onscreen.txt` (OCR of the distinct frames); `tools/extract-reel-resources.py` (Claude Haiku,
   full import only) writes `resources.json`, what the reel is about and the tools and links it points to.
   `tools/reels-to-captures.py` folds the packs into capture records (`link-captures-reels.jsonl`).
4. **Into the extension:** Links pulls the served JSONL and skips links it already holds. Links still
   without a capture go through the extension's capture queue (`extension/capture-queue.js`), which reads
   pages in a minimised Firefox window, paced per site, and stops a site at a wall.
5. **Out:** `native/link-keeper-bridge.py` backs the add-on's storage up to disk; `tools/link-keeper.mjs`
   reads and edits it for agents.

Video, transcript, on-screen text and resource extraction live in `tools/watch-reel.zsh`,
`tools/extract-reel-resources.py` and `tools/reels-to-captures.py` (Instagram only today). Grep `tools/` and `importers/` as well as `extension/` before telling the owner something
does not exist.

## Releases: once per finished batch

- **Commit and push every change** as it lands, as usual.
- **Sign a release only when the batch is done**: when the owner says so, or when the session's
  requests are finished and tested. Never after each change or each answer — a fast run of
  requests is one batch. Say a change is "committed; it ships with the next release".
- **The owner trying each change as it lands does not end the batch.** Wanting to put a fix in front
  of them is the reason 5.69 to 5.77 went out nine times in under three hours. `release.zsh` refuses
  within 2 hours of the last release unless the owner asked for this one (`--owner-asked`).
- **Release with `tools/release.zsh`**: it bumps the version, signs on addons.mozilla.org, opens the
  signed xpi in Firefox, and commits and pushes "ship N as a signed release". `--dry-run` shows the
  next version without changing anything.

AMO throttles signing per account — 3 a minute, 10 an hour, 24 in 24 hours — and a throttled
account cannot update the add-on for up to a day. On 2026-10-07 per-change signing hit the daily
limit. The `limit-signed-releases` hook (agents-shared) refuses a signing past AMO's limits; this
file is what keeps releases to one per batch, well under them.

This narrows the global rebuild-and-restart rule for this repo: "install" means the next batch
release, not a release per change.

## Before a release

Run the suites the README lists: `tools/preview-pages/test-keys.zsh`, `node tools/test-stash.mjs`, `tools/test-extractors.zsh` (for the extractors or a capture), `node tools/test-capture-queue.mjs` (for the capture queue), `tools/test-instagram-export.py` and
`tools/test-import-instagram-accounts.zsh` (for the Instagram importer, `attach-dm-origin.py` or the import), `tools/test-x-archive.py` (for the X archive importer), `node tools/test-chat-grab.mjs` (for grabbing links from a chat page), `tools/test-bridge-import.py` (for the helper's import), `tools/test-reel-resources.py` (for watch-reel's OCR, `extract-reel-resources.py` or `reels-to-captures.py`), `tools/test-bridge-socket.py` (for the helper's shell socket), `tools/test-bridge-owner.py` (for which profile owns the backups),
`node tools/test-bridge.mjs`, for stashing or the live preview `tools/run-in-headless-firefox.zsh
--extension extension tools/e2e-stash.js` and `tools/preview-frames/test-preview-frames.zsh`, and
for the bridge or storage `tools/test-bridge-firefox.zsh`.

## The import

Links' Import panel runs `tools/import-links.zsh` through the helper (`native/link-keeper-bridge.py`,
`import-start` / `import-status`), which replaced the Link Refresh Mac app in 5.65. Never run a full
import on your own initiative: it reaches the phone inbox over ssh and fetches every new link; use
`tools/import-links.zsh --offline`. `tools/test-bridge-import.py` checks the helper's side against a
stand-in script.

## Reading the owner's links

Use `link-keeper` (tools/link-keeper.mjs; `--help`), never the Firefox profile's files: it reads
the live add-on, or the latest backup when Firefox is closed. A change through it is journaled;
`link-keeper undo` reverts the last one. Remove one copy at a time unless the owner asks for more.
