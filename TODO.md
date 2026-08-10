# Not done yet

## Making the install permanent

The extension runs as a **temporary add-on** loaded from `about:debugging#/runtime/this-firefox`. It
unloads on every Firefox restart, and data held in `storage.local` — the worklist, the captures, the
screenshot previews — is not guaranteed to survive an add-on Firefox considers removed.

**Until this is resolved: export captures and export the list before quitting Firefox.**

### The route that involves no publishing

Developer Edition or Nightly allows a permanent unsigned install:

1. `about:config` → set `xpinstall.signatures.required` to `false`
2. Package the directory: `cd extension && npx web-ext build`
3. Install the resulting `.xpi` from `web-ext-artifacts/`

Release Firefox enforces signatures and has no override, so this needs one of those builds.

### Signing, declined

AMO's unlisted channel signs an add-on without listing it publicly — nothing is published, reviewed,
or discoverable, and the signed `.xpi` is installable only by whoever holds the file. It is the usual
route for a personal extension on release Firefox. Recorded here because it was considered and
declined, not as a recommendation to revisit.

`browser_specific_settings.gecko.id` is pinned to `link-keeper@mrtysn.github.io`, so storage carries
over from the temporary add-on to a permanent one either way.

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
