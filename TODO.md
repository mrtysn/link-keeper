# Not done yet

## Waiting on the owner

**Make the link previews (as of 5.68, 2026-10-18).** Previews (a picture and a line per link, shown
in the list and the hover card) are built, but the existing links have none until the owner clicks
**Make previews for N links** in Links → Settings → Previews, between "Filtered out" and "Backups".
The button reads just "Make previews" when none are missing. Afterwards, check that they came through
with pictures; the `link-keeper` CLI does not report previews, so read them from the live add-on's
storage (`previews` and the `pvimg:<key>` entries, in `extension/background.js`).

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
