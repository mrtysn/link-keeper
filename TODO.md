# Not done yet

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
