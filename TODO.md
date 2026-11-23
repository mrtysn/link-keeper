# Not done yet

## In progress: sync between Macs (as of 2026-11-23)

The add-on's storage lives in one Firefox profile and does not sync; the backup folder is
whole-file and owned by one profile, and `.owner.json` records `"default"` on every Mac, so two
Macs sharing a folder would overwrite each other. Stashes are bookmarks and already travel with
Firefox Sync. The plan below makes the rest sync through a small server of our own over HTTPS,
with no VPN on either Mac. The Mac that made this plan holds the newest data and is the seed.

**Decisions.** Server code in `sync-server/`, beside `receiver/`. Python standard library and
SQLite, in a container behind Caddy on the always-on box. Changes are encrypted in the add-on
with WebCrypto AES-GCM; the key sits in each Mac's Keychain and the helper hands it over, so the
server only stores ciphertext and the helper needs no crypto library. Server address, tokens and
key never enter the repo: `config.local.sh` and the Keychain.

**Phase 1, on the seed Mac.**
1. Server: `POST /ops` (a batch of encrypted changes, acknowledged in order), `GET /ops?since=`,
   snapshot upload and download, compaction to the latest snapshot plus later changes; one token
   per device, stored hashed. Dockerfile, compose and Caddy block matching the box's existing
   services. Tests.
2. Helper: push and pull when Links opens, every few minutes while Firefox runs and after wake;
   an offline queue on disk; token and key read with `security`; `link-keeper sync status`.
   Device id from hostname and profile replaces the owner record; one backup folder per device.
3. Add-on: the `storage.onChanged` listener (bridge.js) diffs old and new per record into
   changes stamped with a hybrid logical clock; remote changes go in through the journaled path,
   so `link-keeper undo` covers them. Merge: last writer wins per record, tags per tag, a
   deletion moves the record to the Trash, a newer capture keeps account, thread and senders.
   Not synced: `favicons`, `thumbs`, `dataPatches`, the capture queue. Reconnect to the helper on
   startup and when Links or Settings opens, instead of waiting up to 10 minutes after "not
   installed".
4. Tests: merge rules alone; a local server and two headless Firefox profiles editing at once
   converge; offline and back; delete on one while editing on the other; a fresh profile filled
   from a snapshot; the bridge, storage and stash suites.
5. Seed and secrets: key and tokens generated here, an encrypted snapshot of this Mac's data.
6. One signed release, then a bundle for the second Mac: instructions, token hashes, the seed
   snapshot, its token and the key, the signed xpi.

**Phase 2, on the second Mac** (from the bundle): deploy the server on the box, add its DNS
record, check it over the public address, install the release, put token and key in the
Keychain; its first sync replaces its data with the seed after saving `pre-restore-*.json`.

**Phase 3, back here:** point this Mac at the server, check both directions with one test tag.

**Open risks.** Two Macs syncing bookmarks may create two "Link Keeper stashes" folders, since
the add-on finds the folder by name. Phone shares still reach the box over the VPN; the same
server could take them later.

## Waiting on the owner

**Watch the videos captured before watching was part of capture (as of 2026-10-21).** 5.81 counts a
video read but not watched (links.js `capUnwatched`) as not captured: 461 Instagram reels, YouTube
videos and X posts with a video. The owner said they will start it themselves: Links → Captured filter
on **Not captured** → Select → tick them → **Capture**, which hands each to the watcher on this Mac
(`watch-start`, tools/watch-links.zsh) without loading its page. Agents cannot start a capture queue.
To check progress: `node tools/link-keeper.mjs links --filter uncaptured --all --json` and count the
links whose `cap.unwatched` is true; the worker logs to ~/Library/Logs/link-watch.log, and a video that
could not be watched lands under Failed with yt-dlp's reason.

**Make the link previews (as of 2026-10-18).** Previews (a picture and a line per link, shown
in the list and the hover card) are built and shipped: 5.68 is signed and installed in the owner's
Firefox. Existing links have none until the owner clicks **Make previews for N links** in Links →
Settings → Previews, between "Filtered out" and "Backups"; N is the count still missing, and the
button reads just "Make previews" when none are. Nothing else waits on this. To check afterwards: the
same Previews box shows the count still missing, and the list shows the pictures. The `link-keeper`
CLI does not report previews, and the profile's files are not read (see CLAUDE.md), so the box is
the only check today. A link with no picture is normal (many pages have none); a run that leaves
many missing is a bug in `savePreview` (extension/background.js).

## Considered and not built

**SingleFile for real archiving.** A screenshot is pixels: no selectable text, no working links, no
grep, several MB each. For pages genuinely worth preserving,
https://github.com/gildas-lormeau/SingleFile inlines every image, stylesheet and font into one
`.html` that opens offline forever. A mature extension — install it alongside rather than
reimplementing it here.

**Screenshots outside the Downloads folder.** Not possible: the `downloads` API resolves filenames
against the browser's download directory and rejects `..`. The subfolder is configurable in the
popup; make it a symlink if the files need to live elsewhere.

**Judging bare URLs.** The card deck originally dealt unread links. It does not work —
`x.com/i/status/2086188444317819246` carries no information, which is the reason this extension
exists. Reading now precedes judging, and the deck runs over captures only.
