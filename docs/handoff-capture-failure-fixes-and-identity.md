# Handoff: capture-failure fixes and whose identity captures use

From session 2f2ddf26 (2026-10-20), closed by the owner. Also sent to session link-keeper-81.

## The matter at hand

The owner asked why the links under Links' "Capture failed" (274) failed, and to fix it at the source. The fixes
are written and **uncommitted** in the working tree, interleaved with link-keeper-81's own uncommitted edits to the
same files. Commit only these hunks (`git add -p`), never the other session's.

## The uncommitted hunks

- `extension/links.js`: `READER = 2`, `failWalled`, `failFinal` (after `capThin`); `reader` in capView; the
  `link.fail` line in `joinLinks`. A failure, or an almost empty capture, made by an older reader counts as not
  captured, so the next run tries it again; a wall stays a failure.
- `extension/background.js`: `firefoxPageWhy()` before `captureIn`; in `captureIn`, a page still loading after
  25 s is read anyway, a wall is checked first, a refused read of a tab titled with its own bare address (Firefox
  142's error page, e.g. `127.0.0.1:9/`) fails as "the site did not answer", and `record.reader = READER`;
  `recordCaptureFail(url, error, kind, walled)` stores `reader` and `wall`.
- `extension/capture-queue.js`: `stopSite(host, reason, walled)` passes `walled` to `recordFail`.
- `tools/link-keeper.mjs`: the backup path passes `fails: s.captureFails || {}` (it was missing).
- Tests: `tools/test-bridge.mjs` (reader staleness), `tools/test-capture-queue.mjs` (walled flag),
  `tools/e2e-extractors.js` ("never finishes loading", "does not answer"), `tools/extractor-fixtures/serve.py`
  (`/hang`, `/slow/page`), new `tools/extractor-fixtures/slow-page.html`.

## Current state

`node tools/test-bridge.mjs` and `node tools/test-capture-queue.mjs` pass. `tools/test-extractors.zsh` is not
confirmed: the machine's load average was 75 to 90 (other sessions' Godot jobs) and random checks timed out
("never finished loading", "stopped answering") even where nothing changed. The last clean run failed only the
"does not answer" check, before the bare-address title fix.

## Next steps

1. With `uptime` under about 15, run `tools/test-extractors.zsh`. Green: commit the hunks above on their own
   ("retry failures an older reader recorded, read pages that never finish loading, and say when a site did not
   answer") and push. They ship with the next batch release.
2. Ask the owner (unanswered): whose identity should captures use? `captureIn` opens tabs in the default cookie
   jar, so every page carries the owner's logins. Options: a no-login Firefox container plus a per-site login list
   (recommended; needs the `contextualIdentities` permission, not in the manifest); a dedicated headless browser
   for public links with Firefox kept for logins (the owner said "I want to use a dedicated agent browser I feel
   like"); a container for everything; leave it. Login sites: X 356 links, Instagram 619, Google 169,
   *.mertyas.in 56. Build nothing until the owner picks.
