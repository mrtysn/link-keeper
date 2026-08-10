# Not done yet

## Permanent install

The extension currently runs as a **temporary add-on** loaded from
`about:debugging#/runtime/this-firefox`. That means it unloads on every Firefox restart, and data
held in `storage.local` — the worklist, the captures, the screenshot previews — is not guaranteed to
survive an add-on Firefox considers removed. **Export captures before quitting** until this is done.

To make it permanent, sign it as an unlisted add-on. Unlisted means it is not published to the
public directory, is not reviewed, and is only installable by whoever has the file — the normal
route for a personal extension.

1. Create an account at https://addons.mozilla.org/developers/
2. Get API credentials from https://addons.mozilla.org/developers/addon/api/key/
3. Build and sign:

   ```
   cd extension
   npx web-ext sign --channel=unlisted --api-key=<JWT issuer> --api-secret=<JWT secret>
   ```

   The signed `.xpi` lands in `web-ext-artifacts/`.
4. Install it by opening that `.xpi` in Firefox.

`web-ext sign` bumps nothing automatically — the version in `manifest.json` must be higher than any
version previously uploaded, or AMO rejects it.

The alternative, if signing is not wanted: Developer Edition or Nightly with
`xpinstall.signatures.required=false` in `about:config` allows a permanent unsigned install. Release
Firefox does not.

### After it's permanent

`browser_specific_settings.gecko.id` is already pinned to `link-keeper@mrtysn.github.io`, so storage
carries over from the temporary add-on to the signed one — the worklist and captures should survive
the switch. Export first anyway.

## Considered and not built

**SingleFile for real archiving.** A screenshot is pixels: no selectable text, no working links, no
grep, several MB each. For pages genuinely worth preserving, https://github.com/gildas-lormeau/SingleFile
inlines every image, stylesheet and font into one `.html` that opens offline forever. It is a mature
extension and there is no reason to reimplement it here — install it alongside, for the handful of
pages that deserve it.

**Screenshots outside the Downloads folder.** Not possible: the `downloads` API resolves filenames
against the browser's download directory and rejects `..`. The subfolder is configurable in the
popup; make it a symlink if the files need to live elsewhere.
