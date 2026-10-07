# link-keeper

A Firefox extension (`extension/`) and the tools around it (`tools/`). The README describes both.

## Releases: once per finished batch

- **Commit and push every change** as it lands, as usual.
- **Sign a release only when the batch is done**: when the owner says so, or when the session's
  requests are finished and tested. Never after each change or each answer — a fast run of
  requests is one batch. Say a change is "committed; it ships with the next release".
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

Run the suites the README lists: `tools/preview-pages/test-keys.zsh`, `node tools/test-stash.mjs`,
`node tools/test-bridge.mjs`, for stashing or the live preview `tools/run-in-headless-firefox.zsh
--extension extension tools/e2e-stash.js` and `tools/preview-frames/test-preview-frames.zsh`, and
for the bridge or storage `tools/test-bridge-firefox.zsh`.

## Reading the owner's links

Use `link-keeper` (tools/link-keeper.mjs; `--help`), never the Firefox profile's files: it reads
the live add-on, or the latest backup when Firefox is closed. A change through it is journaled;
`link-keeper undo` reverts the last one. Remove one copy at a time unless the owner asks for more.
