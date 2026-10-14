# Handoff: write the X DM importer when the archive lands

**The matter at hand.** Write the X (Twitter) DM importer in `/Users/mrtysn/dev/link-keeper`. It is not started. It waits on the owner's X data archive, requested on 2026-10-14 from X Settings, Your account, Download an archive of your data. X said it can take 24 hours or longer. The owner will give you the zip's path. Don't unpack it into the repo: it is personal data.

**First, read the real archive.** Nothing in the repo shows its layout, so everything below is from memory. I recall DMs in `data/direct-messages.js` as `window.YTD.direct_message.part0 = [...]`, group DMs in `direct-messages-group.js`, and t.co-wrapped links with the real address in `urls[].expanded` (missing in older archives). Check that against the files, then write the test fixture from them with personal content replaced.

**The pattern to follow.** `importers/instagram.py` is the model: `--list-threads`, repeatable `--thread`, `--account`, `--origins-out`, and records carrying `account`, `thread` (a list) and `senders` (each distinct sender once, the owner counted once). `importers/attach-dm-origin.py` merges those onto records. The spec is `docs/2026-10-14-dm-ingestion-format.html`.

**Decisions already made by the owner**

- Read named threads only, not every thread.
- The archive is the source. A browser agent is a fallback only (`docs/browser-agent-dm-run.md`), and each run needs fresh approval with a stated request count.
- Account, thread and senders are stored and shown only in the detail pane and hover card. That part is built.

**What to build**

- The X importer emits full capture records into its own `link-captures-*.jsonl`. Add a line for it in step 5, "merging", of `tools/refresh.zsh`.
- It can't go through the worklist, which carries only `URL<TAB>date` and drops the origin.
- Add a config knob for the archive folder and the thread names, like `INSTAGRAM_EXPORT_DIR` and `IG_THREADS`. Put it in `config.local.sh.example`, the README and the tests.
- Make `--offline` handle it. Copy the structure of `tools/test-instagram-export.py` and extend `tools/test-refresh-instagram-accounts.zsh`.

**Traps**

- Never run `tools/refresh.zsh` without `--offline` on your own initiative. It reaches the owner's phone inbox over ssh and fetches every Telegram link. Use `tools/refresh.zsh --offline`. It makes no internet requests and holds the file on `127.0.0.1:8790` for 15 minutes, and the extension's list page must open to collect it.
- Ask the owner where the archive should live. Instagram dumps are in `/Users/mrtysn/dev/instagram-extension/igDump`.
- Run the suites before committing: `tools/test-instagram-export.py`, `tools/test-refresh-instagram-accounts.zsh`, `tools/preview-pages/test-keys.zsh`. Sign no release for this alone; the repo's `CLAUDE.md` says one per finished batch.

**State at the end of the writing session.** The tree was clean and everything was pushed. Nothing was running. The Instagram side, the offline mode and the import of the owner's two chats (miyu and Murat Karademir) are done.
