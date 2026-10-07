/* A worklist of links you walk at your own pace, and a capture store you export as a file.
 *
 * Two lists in storage.local:
 *   items    — the worklist. Each entry is pending, seen (opened, not kept) or kept.
 *   captures — what you actually decided to keep, with the page data read off the DOM.
 *
 * Manual trigger throughout. Opening the next link navigates the tab you are in; capturing
 * reads that tab under activeTab, which your keypress grants. There are no content scripts
 * and no background tabs, so the extension can neither observe pages you did not ask about
 * nor go off browsing on its own.
 *
 * MV3 background scripts are event pages that get suspended when idle, so nothing lives in a
 * module variable — every read goes to storage.
 */

/* --- store ---------------------------------------------------------------------- */

async function read(key, fallback) {
  const got = await browser.storage.local.get(key);
  return got[key] ?? fallback;
}

const getItems = () => read("items", []);
const getCaptures = () => read("captures", []);
const getCurrent = () => read("current", null);

async function setItems(items) {
  await browser.storage.local.set({ items });
  await paintBadge(items);
}

async function setCaptures(captures) {
  await browser.storage.local.set({ captures });
}

/* The badge is the pending count — what is left to go through. */
async function paintBadge(items) {
  const pending = (items || await getItems()).filter(i => i.status === "pending").length;
  await browser.action.setBadgeText({ text: pending ? String(pending) : "" });
  await browser.action.setBadgeBackgroundColor({ color: "#6647e6" });
  await browser.action.setBadgeTextColor({ color: "#ffffff" });
}

/* --- worklist ------------------------------------------------------------------- */

/* When the link was originally saved, wherever it came from — not when it was pasted here. That
 * distinction is the whole point: a Telegram export spans years, and "added_at" would flatten it
 * all to the minute of the paste. */
function dateOf(item) {
  return item?.saved_at || item?.added_at || "";
}

const byNewest = (a, b) => String(dateOf(b)).localeCompare(String(dateOf(a)));

async function addItems(entries, note = "") {
  const items = await getItems();
  const byId = new Map(items.map(i => [keyOf(i.url), i]));
  let added = 0, updated = 0, skipped = 0;

  for (const raw of entries) {
    const { url, saved_at, title } = typeof raw === "string" ? { url: raw } : raw;
    if (!url) continue;
    const existing = byId.get(keyOf(url));
    if (existing) {
      if (title && !existing.title) existing.title = title;
      // Re-pasting a list to backfill dates must not be a no-op.
      if (saved_at && existing.saved_at !== saved_at) {
        existing.saved_at = saved_at;
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    const item = {
      url,
      status: "pending",
      added_at: new Date().toISOString(),
      saved_at: saved_at || undefined,
      // A tab title, when the link came from a stash — legible before the page is ever read.
      title: title || undefined,
      note: note || undefined,
    };
    items.push(item);
    byId.set(keyOf(url), item);
    added++;
  }

  await setItems(items);
  return { ok: true, added, updated, skipped, total: items.length };
}

async function markCurrent(status) {
  const current = await getCurrent();
  if (!current) return;
  const items = await getItems();
  const item = items.find(i => keyOf(i.url) === current.key);
  if (item && item.status !== "kept") {
    item.status = status;
    item[status === "kept" ? "kept_at" : "seen_at"] = new Date().toISOString();
    await setItems(items);
  }
}

/* Open the next pending link in the tab you are in. Opening or capturing it counts as seen;
 * only a keep makes it kept. */
async function openNext() {
  const items = await getItems();
  const target = [...items].sort(byNewest).find(i => i.status === "pending");
  if (!target) return { ok: false, error: "nothing left in the list" };

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "no active tab" };

  await browser.storage.local.set({
    current: { key: keyOf(target.url), url: target.url, at: new Date().toISOString() },
  });
  if (target.status === "pending") await markCurrent("seen");
  await browser.tabs.update(tab.id, { url: target.url });

  const remaining = (await getItems()).filter(i => i.status === "pending").length;
  return { ok: true, url: target.url, remaining };
}

/* --- capture -------------------------------------------------------------------- */

/* Injected into the target tab. extractors.js returns null while a single-page app is still
 * hydrating, so poll briefly rather than capture an empty shell. */
async function runExtractor() {
  for (let i = 0; i < 12; i++) {
    const record = LK.extract();
    if (record) return record;
    await new Promise(r => setTimeout(r, 250));
  }
  return { kind: "page", title: document.title || null, url: location.href, incomplete: true };
}

/* t.co hides the destination, and the destination is half the reason to keep a tweet. */
async function resolveLinks(links) {
  if (!links?.length) return links || [];
  return Promise.all(
    links.map(async link => {
      if (!/^https?:\/\/t\.co\//.test(link.href || "")) {
        return { ...link, resolved: link.resolved || link.href };
      }
      try {
        const res = await fetch(link.href, { method: "HEAD", redirect: "follow" });
        return { ...link, resolved: res.url || null };
      } catch (e) {
        return { ...link, resolved: null };
      }
    })
  );
}

/* Images stay beside the text, never inside it — a base64 PNG in the JSONL would make the log
 * unreadable and ungreppable, which defeats the point of keeping text at all. Only the filename
 * is recorded.
 *
 * Besides the screenshot this extension takes itself, a picture taken with Firefox's own tool is
 * adopted too: correlation is by time, in both directions, since a shot saved shortly before or
 * after a capture belongs to it. Two minutes is generous enough for a slow save and tight enough
 * that unrelated downloads are not claimed.
 */
const SHOT_WINDOW_MS = 120000;
const SHOT_NAME = /(-fullpage\.png|^Screen ?[Ss]hot .*\.png|^Screenshot .*\.png)$/;

browser.downloads.onCreated.addListener(async item => {
  const name = (item.filename || "").split("/").pop();
  if (!name || !SHOT_NAME.test(name)) return;

  const captures = await getCaptures();
  const last = captures[captures.length - 1];
  const fresh = last && Date.parse(last.captured_at || 0) > Date.now() - SHOT_WINDOW_MS;

  if (fresh && !last.screenshot) {
    last.screenshot = { filename: name, via: "firefox" };
    await setCaptures(captures);
    await notify(`screenshot linked to ${last.title || last.url}`);
  } else {
    // Taken before the capture — hold it for the next one.
    await browser.storage.local.set({ pendingShot: { filename: name, at: Date.now() } });
  }
});

/* --- full-page screenshot, by scrolling and stitching ---------------------------
 * MV3 does not expose captureTab, which would have shot the whole page in one call. It does
 * expose captureVisibleTab, which shoots the viewport — so the page is walked a screenful at a
 * time and the tiles are drawn into one canvas.
 *
 * Two details make the difference between this and a mess: fixed and sticky elements are
 * temporarily made static, or x.com's top bar repeats in every tile; and each tile records the
 * scroll position actually reached rather than the one requested, since the last scroll clamps
 * short of the target.
 */
const SHOT_MAX_TILES = 40;
const SHOT_MAX_DEVICE_PX = 32000;
const TILE_SETTLE_MS = 180;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function inject(tabId, func, args = []) {
  const [res] = await browser.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

/* The PNG lives in Downloads, which an extension page cannot load — file:// is blocked from
 * moz-extension pages. So a small JPEG preview of the top of the page is kept in storage under
 * its own key, deliberately *not* on the capture record: the exported JSONL stays plain text,
 * and the list page still has something to show.
 */
/* The downloads API resolves filenames against the browser's download directory and rejects
 * "..", so writing outside Downloads is not possible for an extension. The subfolder is the one
 * part that is ours to choose. Point it at a symlink if the files need to live elsewhere. */
const FOLDER_DEFAULT = "link-keeper";

function cleanFolder(raw) {
  const folder = String(raw ?? FOLDER_DEFAULT)
    .replace(/\.\./g, "")
    .replace(/[^A-Za-z0-9 _\-/]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^[\s/]+|[\s/]+$/g, "");
  return folder;
}

const THUMB_W = 480;
const THUMB_H = 300;

async function makeThumb(canvas) {
  const c = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = c.getContext("2d");
  const scale = THUMB_W / canvas.width;
  const srcH = Math.min(canvas.height, THUMB_H / scale);
  ctx.drawImage(canvas, 0, 0, canvas.width, srcH, 0, 0, THUMB_W, Math.min(THUMB_H, canvas.height * scale));
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function saveThumb(filename, dataUrl) {
  const thumbs = await read("thumbs", {});
  thumbs[filename] = dataUrl;
  await browser.storage.local.set({ thumbs });
}

async function fullPageShot(tab, slug) {
  if (!browser.downloads) throw new Error("no downloads permission; reload the extension");
  if (!browser.tabs.captureVisibleTab) {
    throw new Error(await hasSiteAccess()
      ? "captureVisibleTab missing even with site access; reload the extension"
      : "needs access to all sites; grant it from the popup once");
  }

  const page = await inject(tab.id, () => {
    const de = document.documentElement;
    window.__lkStash = { scroll: window.scrollY, pinned: [] };
    for (const el of document.querySelectorAll("*")) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        window.__lkStash.pinned.push([el, el.style.position]);
        el.style.position = "static";
      }
    }
    return {
      w: de.clientWidth,
      h: Math.max(de.scrollHeight, document.body?.scrollHeight || 0),
      vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    };
  });

  const restore = () => inject(tab.id, () => {
    for (const [el, prev] of window.__lkStash?.pinned || []) el.style.position = prev;
    window.scrollTo(0, window.__lkStash?.scroll || 0);
    delete window.__lkStash;
  }).catch(() => {});

  try {
    const { w, h, vh, dpr } = page || {};
    if (!w || !h || !vh) throw new Error("could not measure the page");

    const scale = Math.min(dpr, SHOT_MAX_DEVICE_PX / h);
    const scaledDown = scale < dpr;   // the page was too tall to render at full resolution
    const tiles = [];
    for (let y = 0, n = 0; y < h && n < SHOT_MAX_TILES; y += vh, n++) {
      const at = await inject(tab.id, yy => { window.scrollTo(0, yy); return window.scrollY; }, [y]);
      await sleep(TILE_SETTLE_MS);
      tiles.push({ y: at, dataUrl: await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }) });
      if (at + vh >= h) break;
    }

    const captured = Math.min(h, tiles[tiles.length - 1].y + vh);
    const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(captured * scale));
    const ctx = canvas.getContext("2d");
    for (const tile of tiles) {
      const bitmap = await createImageBitmap(await (await fetch(tile.dataUrl)).blob());
      ctx.drawImage(bitmap, 0, Math.round(tile.y * scale), Math.round(w * scale), bitmap.height);
      bitmap.close();
    }

    const url = URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
    const folder = cleanFolder(await read("folder", FOLDER_DEFAULT));
    const filename = folder ? `${folder}/${slug}.png` : `${slug}.png`;
    // Same slug means the same page, so replace rather than let Firefox uniquify to "(1)" —
    // otherwise re-keeping leaves the record naming a file that is now the older shot.
    const downloadId = await browser.downloads.download({
      url, filename, saveAs: false, conflictAction: "overwrite",
    });
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    try {
      await saveThumb(filename, await makeThumb(canvas));
    } catch (e) { /* a missing preview is cosmetic; the PNG is already saved */ }

    return {
      filename,
      downloadId,
      width: canvas.width,
      height: canvas.height,
      tiles: tiles.length,
      // Only a real limit counts as truncation. A final scroll that clamps short of the
      // measured height simply means the bottom was reached — often because making sticky
      // elements static shortened the document after it was measured.
      truncated: tiles.length >= SHOT_MAX_TILES || scaledDown,
      via: "stitched",
    };
  } finally {
    await restore();
  }
}

function slugFor(record, tab) {
  if (record.status_id) return `x-${record.status_id}`;
  let host = "page";
  try { host = new URL(record.url || tab.url).hostname.replace(/^www\./, ""); } catch (e) { /* keep default */ }
  return `${host}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

async function hasSiteAccess() {
  try {
    return await browser.permissions.contains({ origins: ["*://*/*"] });
  } catch (e) {
    return false;
  }
}

/* Read a page in a tab that is not the one you are looking at.
 *
 * This is the same extraction the hotkey does; only the tab differs. It needs host permission for
 * that origin, because activeTab covers the tab you acted on and nothing else — the list page asks
 * for it per site, at the moment you click capture.
 */
async function readTab(tabId) {
  await browser.scripting.executeScript({ target: { tabId }, files: ["extractors.js"] });
  const [result] = await browser.scripting.executeScript({ target: { tabId }, func: runExtractor });
  return result?.result || null;
}

function tabSettled(tabId, timeout = 25000) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id, changed) => {
      if (id === tabId && changed.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    browser.tabs.onUpdated.addListener(onUpdated);
    // It may already be loaded by the time we start listening.
    browser.tabs.get(tabId).then(t => { if (t.status === "complete") finish(true); }).catch(() => finish(false));
  });
}

/* One link, start to finish: open it out of sight, read it, close it, store it. */
async function captureUrl(url, note = "") {
  let tab;
  try {
    tab = await browser.tabs.create({ url, active: false });
  } catch (e) {
    return { ok: false, error: `could not open it: ${e.message || e}` };
  }
  try {
    const loaded = await tabSettled(tab.id);
    if (!loaded) return { ok: false, error: "the page never finished loading" };

    let record;
    try {
      record = await readTab(tab.id);
    } catch (e) {
      return { ok: false, error: `no access to that site; grant it and retry (${e.message || e})` };
    }
    if (!record) return { ok: false, error: "nothing extractable on that page" };

    record.url = (record.url || record.canonical || url).split("#")[0];
    const visited = url.split("#")[0];
    record.source_url = visited !== record.url ? visited : null;
    record.captured_at = new Date().toISOString();
    record.via = "list";
    if (note) record.note = note;
    record.links = await resolveLinks(record.links);
    if (record.reply_links?.length) record.reply_links = await resolveLinks(record.reply_links);

    const captures = await getCaptures();
    const key = keyOf(record.url);
    await setCaptures([...captures.filter(r => keyOf(r.url) !== key), record]);

    // It has been captured, so it leaves the queue as opened; keeping it is a separate press.
    const items = await getItems();
    const item = items.find(i => keyOf(i.url) === keyOf(url) || keyOf(i.url) === key);
    if (item && item.status === "pending") {
      item.status = "seen";
      item.seen_at = new Date().toISOString();
      await setItems(items);
    }
    return { ok: true, record };
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

async function captureActive(note = "", withShot = false) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "no active tab" };
  if (/^(about|moz-extension|view-source):/.test(tab.url || "")) {
    return { ok: false, error: "nothing to capture on a browser page" };
  }

  let record;
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["extractors.js"] });
    const [result] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: runExtractor });
    record = result?.result;
  } catch (e) {
    // Usually activeTab not granted for this tab — trigger again from the page itself.
    return { ok: false, error: String(e.message || e) };
  }
  if (!record) return { ok: false, error: "could not read that page" };

  record.url = (record.url || record.canonical || tab.url || "").split("#")[0];
  // What you actually visited, kept when it differs from the canonical permalink — x.com
  // rewrites /i/status/<id> to /<handle>/status/<id>, and the original is what a saved link
  // elsewhere will look like.
  const visited = (tab.url || "").split("#")[0];
  record.source_url = visited && visited !== record.url ? visited : null;
  record.captured_at = new Date().toISOString();
  if (note) record.note = note;
  record.links = await resolveLinks(record.links);
  if (record.reply_links?.length) record.reply_links = await resolveLinks(record.reply_links);

  if (withShot) {
    try {
      record.screenshot = await fullPageShot(tab, slugFor(record, tab));
    } catch (e) {
      record.screenshot_error = String(e.message || e);
    }
  }

  // Or one you took yourself with Firefox's own tool, waiting to be claimed.
  const { pendingShot } = await browser.storage.local.get("pendingShot");
  if (!record.screenshot && pendingShot && Date.now() - pendingShot.at < SHOT_WINDOW_MS) {
    record.screenshot = { filename: pendingShot.filename, via: "firefox" };
    await browser.storage.local.set({ pendingShot: null });
  }

  // A capture arriving while a worklist item is open takes it off the queue as opened, not kept.
  // The URL is matched loosely because x.com rewrites /i/status/<id> to /<handle>/status/<id> on load.
  const current = await getCurrent();
  if (current && (keyOf(record.url) === current.key || keyOf(tab.url || "") === current.key)) {
    record.from_worklist = current.url;
    await markCurrent("seen");
  }

  const captures = await getCaptures();
  const key = keyOf(record.url);
  await setCaptures([...captures.filter(r => keyOf(r.url) !== key), record]);

  return { ok: true, record, total: (await getCaptures()).length };
}

/* --- commands ------------------------------------------------------------------- */

/* The popup reports inline, but a keyboard or right-click action has nowhere to say anything —
 * and a silent failure is indistinguishable from success. Everything triggered outside the
 * popup gets a notification, including the reason when it fails.
 */
async function notify(message) {
  try {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icon.svg"),
      title: "Link Keeper",
      message: String(message).slice(0, 300),
    });
  } catch (e) { /* notifications denied at the OS level — nothing to fall back to */ }
}

/* A plain tweet's title is only its handle — "@someone on X" says nothing about what you kept.
 * Its text is the content, so lead with that and keep the title for pages that have a real one. */
function summarise(r) {
  const body = (r.text || "").replace(/\s+/g, " ").trim();
  const titleIsFiller = !r.title || /^@?\S+ on X$|^X post$/.test(r.title);
  if (titleIsFiller && body) {
    const who = r.author?.handle ? `${r.author.handle}: ` : "";
    return who + (body.length > 90 ? body.slice(0, 90) + "…" : body);
  }
  return (r.author?.handle && r.title && !r.title.includes(r.author.handle)
    ? `${r.author.handle}: ${r.title}`
    : r.title || r.url);
}

function describe(res) {
  if (!res?.ok) return `failed: ${res?.error || "unknown error"}`;
  const r = res.record;
  if (!r) return "done";
  const shot = r.screenshot
    ? ` · png ${r.screenshot.width}×${r.screenshot.height}${r.screenshot.truncated ? " (cut short)" : ""}`
    : r.screenshot_error ? ` · screenshot failed: ${r.screenshot_error}` : "";
  const links = r.links?.length ? ` · +${r.links.length} link${r.links.length > 1 ? "s" : ""}` : "";
  const fromReplies = r.reply_links?.length ? ` · ${r.reply_links.length} from replies` : "";
  return `kept ${summarise(r)}${links}${fromReplies}${shot}`;
}

async function queueActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) return addItems([tab.url.split("#")[0]]);
  return { ok: false, error: "no active tab" };
}

/* --- stashed tabs ----------------------------------------------------------------
 * OneTab's move: fold tabs into a saved group and close them. Apart from the worklist — a stash
 * means "come back to these", not "read these" — with a move into the list for a group that turns
 * out to be reading after all.
 *
 * Stashes are Firefox bookmarks, as TidyTab's were, so they outlive the extension and travel with
 * Firefox Sync:
 *
 *   Other Bookmarks / Link Keeper stashes / <one folder per stash> / <one bookmark per tab>
 *
 * A folder's title is the stash's name — its time until renamed — and its bookmarks keep tab order.
 * What a bookmark cannot hold sits beside it in storage.local, keyed by bookmark id; losing it (an
 * uninstall) loses containers, verdicts and marks, never a tab:
 *
 *   stashRoot     — the root folder's id
 *   stashMeta     — { stashes: { [folderId]: { created_at, locked?, starred? } },
 *                     tabs:    { [bookmarkId]: { container?, seen_at?, verdict?, judged_at? } } }
 *   stashSettings — { afterStash: "show" | "stay", afterRestore: "keep" | "remove", exclude: [host] }
 *
 * verdict is "keep" or "drop", set from the explorer. A drop is a flag, not a deletion, and
 * "Clear dropped" is what removes them. A locked stash cannot lose tabs: no delete, no remove, no
 * move out, and restoring always keeps it.
 *
 * Only the tab's URL, title and container are recorded. Nothing is injected into the tabs being
 * stashed. A stash is the only record of the tabs it closes — Firefox remembers 25 closed tabs — so
 * nothing closes until every bookmark has been read back and found present.
 */

const ROOT_TITLE = "Link Keeper stashes";
const TAB_META = ["container", "seen_at", "verdict", "judged_at"];
const STASH_SETTINGS = { afterStash: "show", afterRestore: "keep", exclude: [] };
/* The List page grouped by stash is where stashes are shown; sessions.html, the Stashed tabs page
 * before 5.14, only forwards there. The viewer pages themselves are never stashed: they are views,
 * reopened from the toolbar at any time. */
const listPage = () => browser.runtime.getURL("list.html");
const stashView = () => `${listPage()}?group=stash`;
// tag.html was the Untagged page until 5.34; a tab of it still open is a viewer, not a link.
const VIEWER_PAGES = ["list.html", "sessions.html", "cards.html", "stash-cards.html", "tags.html", "tag.html"];
const isViewerPage = url => VIEWER_PAGES.some(p => !!url?.startsWith(browser.runtime.getURL(p)));
const hostOfUrl = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
/* Firefox stores a bookmark's URL in its parsed form — host lowercased, spaces and non-ASCII
 * percent-encoded, a bare host given its "/" — which is exactly what URL.href gives. */
const asBookmarked = url => { try { return new URL(url).href; } catch { return url; } };
const stashTitle = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* One at a time, so two stashes at once cannot each create a root folder, and two edits of the
 * metadata cannot each overwrite the other. */
function serial() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}
const rootQueue = serial();
const metaQueue = serial();

/* The root folder: the remembered id, else a folder of that name in Other Bookmarks — a reinstall
 * finds the stashes it left — else a new one. */
const stashRoot = () => rootQueue(async () => {
  const id = await read("stashRoot", null);
  if (id) {
    const [node] = await browser.bookmarks.get(id).catch(() => []);
    if (node && !node.url) return node.id;
  }
  const found = (await browser.bookmarks.getChildren("unfiled_____")).find(n => !n.url && n.title === ROOT_TITLE);
  const node = found || await browser.bookmarks.create({ parentId: "unfiled_____", title: ROOT_TITLE });
  await browser.storage.local.set({ stashRoot: node.id });
  return node.id;
});

async function getMeta() {
  const m = await read("stashMeta", {});
  return { stashes: m.stashes || {}, tabs: m.tabs || {} };
}
const editMeta = fn => metaQueue(async () => {
  const m = await getMeta();
  await fn(m);
  await browser.storage.local.set({ stashMeta: m });
  return m;
});

const getStashSettings = async () => ({ ...STASH_SETTINGS, ...await read("stashSettings", {}) });

/* Newest first, starred ones on top: { id, name, created_at, locked, starred, source, format,
 * tabs: [{ id, url, title?, container?, seen_at?, verdict?, judged_at? }] }. Bookmarks moved or
 * edited in Firefox's own library show up here as they are. */
async function getSessions() {
  await migrateStashes();
  const [tree] = await browser.bookmarks.getSubTree(await stashRoot());
  const meta = await getMeta();
  const sessions = (tree.children || []).filter(n => !n.url).map(folder => {
    const m = meta.stashes[folder.id] || {};
    return {
      id: folder.id,
      name: folder.title,
      created_at: m.created_at || new Date(folder.dateAdded).toISOString(),
      locked: !!m.locked,
      starred: !!m.starred,
      // "import" when an import wrote it, "tabs" when it was stashed from open tabs.
      source: m.source === "import" ? "import" : "tabs",
      ...(m.format && { format: m.format }),
      tabs: (folder.children || []).filter(n => n.url).map(b => ({
        id: b.id,
        url: b.url,
        ...(b.title && b.title !== b.url && { title: b.title }),
        ...meta.tabs[b.id],
      })),
    };
  });
  return [...sessions.filter(s => s.starred), ...sessions.filter(s => !s.starred)];
}

async function findStash(id) {
  return (await getSessions()).find(s => s.id === id) || null;
}

/* Writes one stash at the top: the folder, one bookmark per tab in order, then its metadata, then
 * reads it all back. ok is false unless every bookmark made is in the folder with its URL, and
 * every container is recorded. onFolder hears the new
 * folder's id before anything else is written, so a caller can undo a write that fails halfway. */
async function writeStash(tabs, { name, created_at, onFolder, source, format } = {}) {
  const at = created_at || new Date().toISOString();
  const folder = await browser.bookmarks.create({ parentId: await stashRoot(), index: 0, title: name || stashTitle(at) });
  await onFolder?.(folder.id);
  const made = [];
  for (const t of tabs) made.push(await browser.bookmarks.create({ parentId: folder.id, title: t.title || t.url, url: t.url }));
  await editMeta(m => {
    m.stashes[folder.id] = { created_at: at, ...(source === "import" && { source, ...(format && { format }) }) };
    made.forEach((b, i) => {
      const extra = Object.fromEntries(TAB_META.filter(k => tabs[i][k] != null).map(k => [k, tabs[i][k]]));
      if (Object.keys(extra).length) m.tabs[b.id] = extra;
    });
  });

  const have = new Map((await browser.bookmarks.getChildren(folder.id)).map(b => [b.id, b.url]));
  const meta = await getMeta();
  const ok = made.length === tabs.length &&
    made.every((b, i) => have.get(b.id) === asBookmarked(tabs[i].url)) &&
    made.every((b, i) => !tabs[i].container || meta.tabs[b.id]?.container === tabs[i].container);
  return { id: folder.id, ok };
}

async function removeStashFolder(id) {
  await browser.bookmarks.removeTree(id).catch(() => {});
  await editMeta(m => { delete m.stashes[id]; });
}

/* Stashes kept in storage.local before 5.9 move into bookmarks once. The old record stays until
 * every stash has been read back from bookmarks, and is then kept as sessions_before_bookmarks. A
 * run cut short leaves its folders listed in stashMigrating; the next run removes those and starts
 * over, since the old record still holds everything. */
let migration = null;
function migrateStashes() {
  migration ??= (async () => {
    const old = await read("sessions", null);
    if (!Array.isArray(old)) return;
    for (const id of await read("stashMigrating", [])) await removeStashFolder(id);
    const made = [];
    // Oldest first, each written at the top, so the newest ends up first as before.
    for (const s of [...old].reverse()) {
      if (!s.tabs?.length) continue;
      const res = await writeStash(s.tabs, {
        name: s.name, created_at: s.created_at,
        onFolder: id => browser.storage.local.set({ stashMigrating: [...made, id] }),
      });
      made.push(res.id);
      if (!res.ok) throw new Error("moving stashes into bookmarks did not read back; the old record is untouched");
    }
    await browser.storage.local.set({ sessions_before_bookmarks: old });
    await browser.storage.local.remove(["sessions", "stashMigrating"]);
  })().catch(e => { migration = null; throw e; });
  return migration;
}

/* --- one-time data patches -------------------------------------------------------
 * Fixes to data already stored, applied on the first launch of the version that brings them and
 * recorded in dataPatches ({ [id]: { at, ...result } }), so each runs once and never again — even
 * if the data it touched changes afterwards. A patch acts only when its fingerprint matches what
 * is stored; otherwise it records why it skipped and changes nothing. One that throws is not
 * recorded, so the next launch tries it again. */
const DATA_PATCHES = [
  {
    // The OneTab import of 29 Sep 2026 ran on 5.10, before imports were marked (5.14), so its
    // stashes sat under Stashed tabs. Its 8 folders were written within ten seconds; that window
    // and their tab counts identify them exactly, and nothing else is touched.
    id: "2026-09-29-mark-onetab-import",
    async run() {
      const from = Date.parse("2026-09-29T11:01:50Z"), to = Date.parse("2026-09-29T11:02:01Z");
      const want = [2, 7, 12, 23, 40, 80, 87, 296];
      const [tree] = await browser.bookmarks.getSubTree(await stashRoot());
      const hits = (tree.children || []).filter(n => !n.url && n.dateAdded >= from && n.dateAdded <= to);
      const counts = hits.map(f => (f.children || []).filter(b => b.url).length).sort((a, b) => a - b);
      if (JSON.stringify(counts) !== JSON.stringify(want)) {
        return { skipped: `${hits.length} folders in the window, holding ${counts.join(", ") || "nothing"}; not the import` };
      }
      await editMeta(m => {
        for (const folder of hits) {
          const st = m.stashes[folder.id] || (m.stashes[folder.id] = {});
          st.source = "import";
          st.format ||= "onetab";
        }
      });
      return { marked: hits.length };
    },
  },
  {
    // Until 5.32 capturing a page marked its reading-list entry kept. A keep pressed on a captured
    // link also writes the verdict onto the capture, so an entry kept while its capture holds no
    // keep was kept only by capturing; it goes back to opened. Entries with no capture are untouched.
    id: "2026-10-07-capture-is-not-keep",
    async run() {
      const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
      const items = await getItems();
      let reset = 0;
      for (const i of items) {
        const c = caps.get(keyOf(i.url));
        if (i.status === "kept" && c && c.verdict !== "keep") {
          i.status = "seen";
          i.seen_at ||= i.kept_at || new Date().toISOString();
          delete i.kept_at;
          reset++;
        }
      }
      if (reset) await setItems(items);
      return { reset };
    },
  },
];

let patching = null;
function applyDataPatches() {
  patching ??= (async () => {
    await migrateStashes();
    const done = await read("dataPatches", {});
    for (const patch of DATA_PATCHES) {
      if (done[patch.id]) continue;
      done[patch.id] = { at: new Date().toISOString(), ...await patch.run() };
      await browser.storage.local.set({ dataPatches: done });
    }
    return done;
  })().catch(e => { patching = null; throw e; });
  return patching;
}

// Moved as soon as the new version runs, not only when a stash page first opens. A failure
// leaves the old record in place and is retried by the next page or stash.
browser.runtime.onInstalled.addListener(() => applyDataPatches().catch(() => {}));
// The tag library is written on the first install or update that has one: the presets and the tags in use.
browser.runtime.onInstalled.addListener(() => editTags(() => {}).catch(() => {}));
browser.runtime.onStartup.addListener(() => applyDataPatches().catch(() => {}));
for (const ev of [browser.runtime.onStartup, browser.runtime.onInstalled]) ev.addListener(() => iconsFromOpenTabs().catch(() => {}));

/* There is one List tab to show stashes in, like OneTab's tab: every way in switches to the open
 * one — in this window if it has one, else in any window, pinned or not — grouped by stash, and a
 * new tab opens only when none is open. Pinning it is left to the user. */
async function showSessions(windowId) {
  const open = (await browser.tabs.query({})).filter(t => t.url?.startsWith(listPage()) || t.url?.startsWith(browser.runtime.getURL("sessions.html")));
  const page = open.find(t => t.windowId === windowId) || open[0];
  if (!page) return browser.tabs.create({ url: stashView(), ...(windowId != null && { windowId }), active: true });
  await browser.tabs.update(page.id, { active: true, ...(page.url !== stashView() && { url: stashView() }) });
  if (page.windowId !== windowId) await browser.windows?.update(page.windowId, { focused: true });
  return page;
}

/* A viewer opened from the popup or the menus: the tab already showing it, in this window if it
 * has one, else in any window; a new tab only when none is open. `url` may carry a query or hash
 * (a stash to explore, the import panel), which the tab is sent to. */
async function showPage(page, windowId, suffix = "") {
  const base = browser.runtime.getURL(page);
  const open = (await browser.tabs.query({})).filter(t => t.url?.startsWith(base));
  const tab = open.find(t => t.windowId === windowId) || open[0];
  const url = base + suffix;
  if (!tab) return browser.tabs.create({ url, ...(windowId != null && { windowId }), active: true });
  await browser.tabs.update(tab.id, { active: true, ...(suffix && tab.url !== url && { url }) });
  if (tab.windowId !== windowId) await browser.windows?.update(tab.windowId, { focused: true });
  return tab;
}

/* What the popup knows about the page you are on: the link as the pages see it (its tags, its
 * capture, its reading-list entry), each stash holding a copy, whole, so the popup can remove one
 * copy and put it back, and how many links carry each tag. link is null when the URL is held nowhere. */
async function pageInfo(url) {
  if (!url) return { link: null, stashes: [] };
  const { links, stashes } = await getLinks();
  const link = links.find(l => l.key === keyOf(url)) || null;
  const held = link ? stashes.filter(s => link.copies.some(c => c.stash === s.id)) : [];
  // How many links carry each tag, so the popup can offer the most used first.
  const tagUse = {};
  for (const l of links) for (const t of l.tags) tagUse[t] = (tagUse[t] || 0) + 1;
  return { link, stashes: held, tagUse };
}

/* What the popup shows on its view buttons, counted in the background so the popup never holds
 * the whole dataset: links per source, and how many in the chosen sources have no tags yet. */
async function linkCounts() {
  const { links, stashes } = await getLinks();
  const chosen = new Set((await read("viewSources", null)) || LINK_SOURCES);
  const shown = links.filter(l => l.sources.some(s => chosen.has(s)));
  const sources = { tabs: 0, import: 0, list: 0 };
  for (const l of links) for (const s of l.sources) sources[s]++;
  return { total: shown.length, untagged: shown.filter(l => !l.tags.length).length, sources, stashes: stashes.length, chosen: [...chosen] };
}

/* Pinned tabs, empty tabs, sites on the never-stash list and Link Keeper's own pages stay open.
 * Stashing one tab by name takes it whatever it is. How a tab comes back depends on what it is —
 * see restoreTabs. */
const EMPTY_TAB = /^about:(blank|newtab|home|privatebrowsing)$/;
const recordable = tab => !!tab.url && !EMPTY_TAB.test(tab.url) && !isViewerPage(tab.url);

/* Firefox lets an extension open web pages and its own pages. A file: URL goes to the native helper
 * (native/open-local-files.py); about: pages and other extensions' pages get a stand-in tab that
 * shows the URL with click-to-copy, as OneTab and Sidebery do. */
const HELPER = "link_keeper_open_files";
function reopenRoute(url) {
  if (/^(https?|ftp):/.test(url) || url.startsWith(browser.runtime.getURL(""))) return "direct";
  if (/^file:/.test(url)) return "helper";
  return "standin";
}

function standinUrl(t, why) {
  const q = new URLSearchParams({ url: t.url });
  if (t.title) q.set("title", t.title);
  if (why) q.set("why", why);
  return `${browser.runtime.getURL("standin.html")}?${q}`;
}

/* Which tabs of one window a scope names, relative to tab `at`:
 *   auto   — the selected tabs if several are selected, otherwise the whole window
 *   tab · left · right · others · window */
function scopeTabs(all, scope, at) {
  switch (scope) {
    case "tab": return at ? [at] : [];
    case "left": return at ? all.filter(t => t.index < at.index) : [];
    case "right": return at ? all.filter(t => t.index > at.index) : [];
    case "others": return at ? all.filter(t => t.id !== at.id) : all;
    case "window": return all;
    default: {
      const selected = all.filter(t => t.highlighted);
      return selected.length > 1 ? selected : all;
    }
  }
}

const SCOPE_WORDS = {
  tab: "this tab", left: "the tabs to the left", right: "the tabs to the right", others: "the other tabs",
  window: "this window", "all-windows": "any window",
};

/* Stash tabs and close them. { windowId, scope, tabId } — tabId is the tab a scope is relative to,
 * the active one by default; scope "all-windows" makes one stash per window. */
async function stashTabs({ windowId, scope = "auto", tabId } = {}) {
  await migrateStashes();
  const settings = await getStashSettings();
  const excluded = t => settings.exclude.includes(hostOfUrl(t.url));

  let windows;
  if (scope === "all-windows") {
    windows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })).map(w => w.tabs);
  } else {
    windows = [await browser.tabs.query(windowId == null ? { currentWindow: true } : { windowId })];
  }
  if (!windows.some(w => w.length)) return { ok: false, error: "no window to stash" };

  const plans = [];
  const stayed = [];
  let selectionWord = null;
  for (const all of windows) {
    if (!all.length) continue;
    const at = all.find(t => t.id === tabId) || all.find(t => t.active);
    const pool = scopeTabs(all, scope, at);
    if (scope === "auto" && pool.length < all.length) selectionWord = `the ${pool.length} selected tabs`;
    const take = scope === "tab" ? recordable : t => recordable(t) && !t.pinned && !excluded(t);
    const closing = pool.filter(take);
    stayed.push(...pool.filter(t => !take(t) && !isViewerPage(t.url)));
    // Duplicate tabs all close, and are recorded once.
    const urls = new Set();
    const tabs = closing
      .filter(t => !urls.has(t.url) && urls.add(t.url))
      .map(t => ({
        url: t.url,
        title: t.title && t.title !== t.url ? t.title : undefined,
        // A container tab reopened outside its container is signed in as someone else.
        container: t.cookieStoreId && t.cookieStoreId !== "firefox-default" ? t.cookieStoreId : undefined,
      }));
    if (closing.length) plans.push({ windowId: all[0].windowId, closing, tabs, emptiesWindow: closing.length === all.length });
  }

  const why = leftOpen(stayed, excluded);
  if (!plans.length) {
    const scopeWord = selectionWord || SCOPE_WORDS[scope] || "this window";
    return { ok: false, error: `nothing stashed: ${scopeWord} holds only ${why || "this page"}` };
  }

  // Every stash is written and read back before any tab closes; if one fails, the others are
  // taken back out and nothing closes.
  const written = [];
  try {
    for (const plan of plans) {
      const res = await writeStash(plan.tabs, { onFolder: id => { written.push(id); } });
      if (!res.ok) throw new Error("the stash did not save");
    }
  } catch (e) {
    for (const id of written) await removeStashFolder(id);
    return { ok: false, error: `${e.message}; no tab was closed` };
  }
  // Each site's icon, read off its tab before the tab goes; the stash does not wait for it.
  saveFavicons(plans.flatMap(p => p.closing)).catch(() => {});

  // Closing a window's last tab closes the window, so whatever stays on screen opens first: the
  // List page grouped by stash (here, unless it is open elsewhere, in which case this window may close as
  // OneTab's does), or with "stay", a new tab in each window that would otherwise close.
  const focused = scope === "all-windows" ? (await browser.windows.getLastFocused()).id : plans[0].windowId;
  if (settings.afterStash === "stay") {
    for (const plan of plans.filter(p => p.emptiesWindow)) await browser.tabs.create({ windowId: plan.windowId, active: true });
  } else {
    await showSessions(focused);
  }
  for (const plan of plans) await browser.tabs.remove(plan.closing.map(t => t.id));

  const stashed = plans.reduce((n, p) => n + p.tabs.length, 0);
  const closed = plans.reduce((n, p) => n + p.closing.length, 0);
  return { ok: true, stashed, closed, stashes: plans.length, left: stayed.length, why };
}

/* --- site icons ------------------------------------------------------------------
 * favicons: { [host]: { icon, src, at } } — each site's own icon, taken from its tab when the tab
 * is stashed, and on startup from open tabs of sites already held. icon is a data: URL when
 * Firefox hands one over or the image can be read; otherwise it is the icon's address, which the
 * pages show like any image (the browser's cache usually has it). The pages fall back to the
 * drawn icons in icons.js for a site with none. */
const iconQueue = serial();
const ICON_MAX = 64 * 1024;
async function iconData(src) {
  if (src.startsWith("data:")) return src.length <= ICON_MAX ? src : null;
  try {
    const res = await fetch(src, { credentials: "omit" });
    const blob = res.ok ? await res.blob() : null;
    if (!blob || blob.size > ICON_MAX || !blob.type.startsWith("image/")) return src;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(bin)}`;
  } catch (e) {
    // No permission to read that site's files: keep the address.
    return src;
  }
}
function saveFavicons(tabs) {
  const want = new Map();
  for (const t of tabs) {
    if (!/^https?:/.test(t.url || "") || !/^(data:image\/|https:)/.test(t.favIconUrl || "")) continue;
    const host = hostOfUrl(t.url);
    if (host && !want.has(host)) want.set(host, t.favIconUrl);
  }
  if (!want.size) return Promise.resolve(0);
  return iconQueue(async () => {
    const all = await read("favicons", {});
    let saved = 0;
    for (const [host, src] of want) {
      if (all[host]?.src === src) continue;
      const icon = await iconData(src);
      if (!icon) continue;
      all[host] = { icon, src, at: new Date().toISOString() };
      saved++;
    }
    if (saved) await browser.storage.local.set({ favicons: all });
    return saved;
  });
}
/* Sites held before icons were saved get theirs from any tab of them open now. */
async function iconsFromOpenTabs() {
  const held = new Set([...(await getSessions()).flatMap(s => s.tabs.map(t => hostOfUrl(t.url))),
    ...(await getItems()).map(i => hostOfUrl(i.url))]);
  const known = await read("favicons", {});
  const tabs = (await browser.tabs.query({})).filter(t => held.has(hostOfUrl(t.url)) && !known[hostOfUrl(t.url)]);
  return saveFavicons(tabs);
}

/* "2 pinned, 1 empty tab, 3 never-stash sites" — what stayed open, by the reason it stayed. */
function leftOpen(tabs, excluded = () => false) {
  const pinned = tabs.filter(t => t.pinned).length;
  const skipped = tabs.filter(t => !t.pinned && recordable(t) && excluded(t)).length;
  const empty = tabs.length - pinned - skipped;
  return [
    pinned && `${pinned} pinned`,
    empty && `${empty} empty tab${empty > 1 ? "s" : ""}`,
    skipped && `${skipped} never-stash site${skipped > 1 ? "s" : ""}`,
  ].filter(Boolean).join(", ");
}

/* Reopens tabs of one stash: all of them, or the bookmark ids given. Several at once open unloaded,
 * so forty tabs back is not forty page loads — each loads when you switch to it. Afterwards the
 * entries are marked restored, or with afterRestore "remove", taken out — never from a locked
 * stash. */
async function restoreTabs(id, ids, flip = false) {
  const session = await findStash(id);
  if (!session) return { ok: false, error: "that stash is gone" };
  const wanted = ids ? session.tabs.filter(t => ids.includes(t.id)) : session.tabs;
  if (!wanted.length) return { ok: false, error: "those tabs are no longer in the stash" };
  const lazy = wanted.length > 1;

  const direct = wanted.filter(t => reopenRoute(t.url) === "direct");
  const files = wanted.filter(t => reopenRoute(t.url) === "helper");
  const standins = wanted.filter(t => reopenRoute(t.url) === "standin").map(t => ({ t, why: "" }));

  // All local files in one request; whatever the helper does not open falls back to a stand-in.
  let helperError = null, viaHelper = 0;
  if (files.length) {
    let res;
    try {
      res = await browser.runtime.sendNativeMessage(HELPER, { open: files.map(t => t.url) });
    } catch (e) {
      res = { ok: false, error: "the helper is not installed" };
    }
    if (!res?.ok) helperError = res?.error || "the helper did not answer";
    const opened = new Set(res?.ok ? res.opened : []);
    const failed = new Map((res?.failed || []).map(f => [f.url, f.error]));
    viaHelper = opened.size;
    for (const t of files) if (!opened.has(t.url)) standins.push({ t, why: failed.get(t.url) || helperError });
  }

  const jobs = [
    ...direct.map(t => ({ t, url: t.url, container: t.container })),
    ...standins.map(({ t, why }) => ({ t, url: standinUrl(t, why) })),
  ];
  for (const { t, url, container } of jobs) {
    const props = { url, active: !lazy };
    if (container) props.cookieStoreId = container;
    if (lazy) Object.assign(props, { discarded: true }, t.title ? { title: t.title } : {});
    // An unloaded tab is refused for a few URLs, and a container may since have been deleted;
    // each fallback drops only the part that failed, the tab itself always opens.
    try {
      await browser.tabs.create(props);
    } catch (e) {
      try {
        await browser.tabs.create({ url, active: false, ...(container && { cookieStoreId: container }) });
      } catch (e2) {
        await browser.tabs.create({ url, active: false });
      }
    }
  }

  // flip: this once, the other of what the setting says (⇧4 on the viewer pages).
  const remove = ((await getStashSettings()).afterRestore === "remove") !== !!flip && !session.locked;
  if (remove) await dropFromStash(id, wanted.map(t => t.id));
  else {
    const at = new Date().toISOString();
    await editMeta(m => { for (const t of wanted) m.tabs[t.id] = { ...m.tabs[t.id], seen_at: at }; });
  }
  return { ok: true, restored: wanted.length, removed: remove, viaHelper, standins: standins.length, helperError };
}

/* Undo of taking tabs out: each goes back into its stash at the place it had, with its marks. A
 * stash that went with its last tab is written again, with its name, date and flags, at the top.
 * stash: { id, name, created_at, source?, format?, locked?, starred? }; tabs: [{ url, title?, index,
 * container?, seen_at?, verdict?, judged_at? }]. Returns the stash's id and the new bookmark ids. */
async function putBack(stash, tabs) {
  if (!stash?.id || !tabs.length) return { ok: false, error: "nothing to put back" };
  let id = stash.id;
  const [node] = await browser.bookmarks.get(id).catch(() => []);
  if (!node || node.url) {
    id = (await writeStash([], { name: stash.name, created_at: stash.created_at, source: stash.source, format: stash.format })).id;
    if (stash.locked || stash.starred) {
      await editMeta(m => { Object.assign(m.stashes[id], stash.locked && { locked: true }, stash.starred && { starred: true }); });
    }
  }
  const ids = [];
  for (const t of [...tabs].sort((a, b) => a.index - b.index)) {
    const count = (await browser.bookmarks.getChildren(id)).length;
    const b = await browser.bookmarks.create({ parentId: id, index: Math.min(t.index ?? count, count), title: t.title || t.url, url: t.url });
    ids.push(b.id);
    const extra = Object.fromEntries(TAB_META.filter(k => t[k] != null).map(k => [k, t[k]]));
    if (Object.keys(extra).length) await editMeta(m => { m.tabs[b.id] = extra; });
  }
  return { ok: true, id, ids };
}

/* Take tabs out of a stash — all of them, or the bookmark ids given, which must be in it. A stash
 * left empty goes with them. Returns what was taken; a locked stash gives up nothing. */
async function dropFromStash(id, ids) {
  const session = await findStash(id);
  if (!session || session.locked) return [];
  const taken = ids ? session.tabs.filter(t => ids.includes(t.id)) : session.tabs;
  for (const t of taken) await browser.bookmarks.remove(t.id);
  // Only an empty folder goes: one the user put anything else in stays.
  const emptied = !(await browser.bookmarks.getChildren(id)).length;
  if (emptied) await browser.bookmarks.remove(id);
  await editMeta(m => {
    for (const t of taken) delete m.tabs[t.id];
    if (emptied) delete m.stashes[id];
  });
  return taken;
}

/* The stash date stands in as the saved date: it is when you set the tab aside. */
async function moveStashToList(id, ids) {
  const session = await findStash(id);
  if (!session) return { ok: false, error: "that stash is gone" };
  if (session.locked) return { ok: false, error: "that stash is locked" };
  const asked = ids ? session.tabs.filter(t => ids.includes(t.id)) : session.tabs;
  // The reading list walks links by navigating a tab, which works for web pages only; local files
  // and browser pages stay in the stash.
  const web = asked.filter(t => /^(https?|ftp):/.test(t.url));
  if (!web.length) return { ok: false, error: "only web pages can go to the reading list" };
  const taken = await dropFromStash(id, web.map(t => t.id));
  const res = await addItems(taken.map(t => ({ url: t.url, title: t.title, saved_at: session.created_at })));
  return { ...res, moved: taken.length, stayed: asked.length - taken.length };
}

/* Drag and drop: move bookmarks, in order, into stash `to` ahead of bookmark `before` (the end if
 * none). Only bookmarks in stashes move, never out of a locked one; a stash left empty goes. */
async function moveStashed(ids, to, before) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === to);
  if (!target) return { ok: false, error: "that stash is gone" };
  const from = new Map(sessions.flatMap(s => s.tabs.map(t => [t.id, s])));
  const moving = ids.filter(id => from.has(id));
  if (moving.some(id => from.get(id).locked && from.get(id).id !== to)) return { ok: false, error: "that stash is locked" };
  for (const id of moving) {
    // Firefox reads index as the final position, so it is counted without the moving bookmark.
    const rest = (await browser.bookmarks.getChildren(to)).filter(b => b.id !== id);
    const at = before ? rest.findIndex(b => b.id === before) : -1;
    await browser.bookmarks.move(id, { parentId: to, index: at < 0 ? rest.length : at });
  }
  for (const s of new Set(moving.map(id => from.get(id)))) {
    if (s.id !== to && !(await browser.bookmarks.getChildren(s.id)).length) await removeStashFolder(s.id);
  }
  return { ok: true, moved: moving.length };
}

/* Stashes from a file: [{ name?, created_at?, tabs: [{ url, title?, container?, verdict?, seen_at? }] }],
 * already parsed by the page (stash-import.js). Written in the order given, above the others, with
 * URLs in the form Firefox bookmarks them. All or nothing: if one stash does not read back, the
 * ones this import already wrote are taken out again. */
async function importStashes(stashes, format) {
  await migrateStashes();
  const clean = (Array.isArray(stashes) ? stashes : []).map(s => {
    const urls = new Set();
    const tabs = (s.tabs || [])
      .filter(t => typeof t?.url === "string" && /^[a-z][a-z0-9+.-]*:/i.test(t.url.trim()))
      .map(t => ({ ...t, url: asBookmarked(t.url.trim()) }))
      .filter(t => !urls.has(t.url) && urls.add(t.url))
      .map(t => ({
        url: t.url,
        title: typeof t.title === "string" && t.title.trim() ? t.title.trim().slice(0, 500) : undefined,
        container: typeof t.container === "string" ? t.container : undefined,
        verdict: t.verdict === "keep" || t.verdict === "drop" ? t.verdict : undefined,
        seen_at: typeof t.seen_at === "string" ? t.seen_at : undefined,
        tags: Array.isArray(t.tags) ? t.tags : undefined,
      }));
    const when = new Date(s.created_at);
    return {
      name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 200) : undefined,
      created_at: Number.isNaN(when.getTime()) ? undefined : when.toISOString(),
      tabs,
    };
  }).filter(s => s.tabs.length);
  if (!clean.length) return { ok: false, error: "nothing to import" };
  let tabs = 0;
  const written = [];
  try {
    for (const s of [...clean].reverse()) {
      const res = await writeStash(s.tabs, { ...s, source: "import", format: typeof format === "string" ? format.slice(0, 40) : undefined, onFolder: id => { written.push(id); } });
      if (!res.ok) throw new Error("an imported stash did not read back");
      tabs += s.tabs.length;
    }
  } catch (e) {
    for (const id of written) await removeStashFolder(id);
    return { ok: false, error: `${e.message}; nothing was imported` };
  }
  await mergeTags(clean.flatMap(st => st.tabs));
  return { ok: true, stashes: clean.length, tabs };
}

/* --- live preview ---------------------------------------------------------------
 * The explore page shows a link's page in a frame. Most sites forbid framing with X-Frame-Options or
 * a CSP frame-ancestors directive, so for frames opened from this extension's own pages — and
 * nothing else — both headers are removed. A declarativeNetRequest rule does it: Firefox enforces
 * the headers after webRequest listeners run, so removing them there has no effect (checked with
 * tools/test-preview-frames.zsh). The CSP header goes whole, since a rule cannot edit one
 * directive; the frame is sandboxed, logged out and cannot navigate the extension page away. The
 * rule acts only on sites the user has granted access to.
 */

const PREVIEW_RULE = 1;
async function allowPreviewFrames() {
  if (!browser.declarativeNetRequest) return;
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [PREVIEW_RULE],
    addRules: [{
      id: PREVIEW_RULE, priority: 1,
      action: { type: "modifyHeaders", responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ] },
      condition: { resourceTypes: ["sub_frame"], initiatorDomains: [new URL(browser.runtime.getURL("")).host] },
    }],
  });
}
allowPreviewFrames().catch(e => console.error("preview frames:", e));

/* Every source joined into one dataset for the pages; joinLinks in links.js does the joining. */
async function getLinks() {
  const [items, captures, sessions, thumbs, current, tags] =
    [await getItems(), await getCaptures(), await getSessions(), await read("thumbs", {}), await getCurrent(), await read("linkTags", {})];
  return joinLinks({ items, captures, sessions, thumbs, currentKey: current?.key || null, tags });
}

/* --- tags ------------------------------------------------------------------------
 * linkTags: { [link key]: ["tag", ...] } — the tags set by hand, one list per URL wherever it is
 * held. Firefox gives extensions no access to bookmark tags, so they live here, and travel in the
 * stash and capture exports. One queue, so two edits cannot each overwrite the other.
 *
 * tagDefs: { seeded: true, list: [{ name, hue }] } — the tag library, in the order tags were made:
 * the presets, then each tag as it is first used or created. hue is null until a colour is picked,
 * and the name's own hue shows. Every tag in use is in it; the pages offer it to pick from. */
const PRESET_TAGS = ["to-read", "to-watch", "to-try", "reference", "inspiration", "work", "personal", "buy",
  "dev", "ai", "design", "news", "video", "shopping", "music", "games"];
const tagQueue = serial();
const editTags = fn => tagQueue(async () => {
  const all = await read("linkTags", {});
  const defs = await read("tagDefs", null);
  // The first time: the presets, then the tags already in use.
  const lib = defs?.seeded ? defs.list.filter(d => cleanTag(d?.name)) : PRESET_TAGS.map(name => ({ name, hue: null }));
  const res = await fn(all, lib);
  for (const k of Object.keys(all)) if (!all[k]?.length) delete all[k];
  const known = new Set(lib.map(d => d.name));
  for (const tags of Object.values(all)) for (const t of tags) if (!known.has(t)) { known.add(t); lib.push({ name: t, hue: null }); }
  await browser.storage.local.set({ linkTags: all, tagDefs: { seeded: true, list: lib } });
  return res;
});
const tagList = list => [...new Set((Array.isArray(list) ? list : []).map(cleanTag).filter(Boolean))];
const hueOf = h => (Number.isFinite(+h) && h !== null && h !== "" ? Math.round(+h) % 360 : null);

/* A new tag in the library, on no link yet. */
const createTag = (name, hue) => editTags((all, lib) => {
  const t = cleanTag(name);
  if (!t) return { ok: false, error: "a tag needs a name" };
  if (lib.some(d => d.name === t)) return { ok: false, error: `${t} already exists` };
  lib.push({ name: t, hue: hueOf(hue) });
  return { ok: true, tag: t };
});

const recolorTag = (name, hue) => editTags((all, lib) => {
  const d = lib.find(x => x.name === cleanTag(name));
  if (!d) return { ok: false, error: "no such tag" };
  d.hue = hueOf(hue);
  return { ok: true };
});

/* Replace a link's tags; an empty list clears them, and its guesses show again. */
const setTags = (url, tags) => editTags(all => { all[keyOf(url)] = tagList(tags); return { ok: true, tags: all[keyOf(url)] }; });

/* Add tags to every tab of a stash. A link showing only guesses keeps them, now as its own. */
async function tagStash(id, add) {
  const stash = await findStash(id);
  if (!stash) return { ok: false, error: "that stash is gone" };
  const extra = tagList(add);
  if (!extra.length) return { ok: false, error: "no tag given" };
  const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
  return editTags(all => {
    for (const t of stash.tabs) {
      const k = keyOf(t.url);
      const had = all[k]?.length ? all[k] : guessTags(t.url, caps.get(k));
      all[k] = tagList([...had, ...extra]);
    }
    return { ok: true, tagged: stash.tabs.length };
  });
}

/* Rename a tag everywhere; renaming onto an existing tag merges the two. */
const renameTag = (from, to) => editTags((all, lib) => {
  const a = cleanTag(from), b = cleanTag(to);
  if (!a || !b) return { ok: false, error: "a tag needs a name" };
  // In the library: renamed in place, or, merging, the old one gone and the one it joined kept.
  const i = lib.findIndex(d => d.name === a);
  if (lib.some(d => d.name === b)) { if (i !== -1) lib.splice(i, 1); }
  else if (i !== -1) lib[i] = { ...lib[i], name: b };
  let n = 0;
  for (const k of Object.keys(all)) {
    if (!all[k].includes(a)) continue;
    all[k] = tagList(all[k].map(t => (t === a ? b : t)));
    n++;
  }
  return { ok: true, links: n };
});

const deleteTag = tag => editTags((all, lib) => {
  const a = cleanTag(tag);
  const i = lib.findIndex(d => d.name === a);
  if (i !== -1) lib.splice(i, 1);
  let n = 0;
  for (const k of Object.keys(all)) {
    if (!all[k].includes(a)) continue;
    all[k] = all[k].filter(t => t !== a);
    n++;
  }
  return { ok: true, links: n };
});

/* Tags carried by imported records ({ url, tags }), merged into what is already set. */
const mergeTags = records => editTags(all => {
  let n = 0;
  for (const r of records) {
    const extra = tagList(r?.tags);
    if (!r?.url || !extra.length) continue;
    const k = keyOf(r.url);
    all[k] = tagList([...(all[k] || []), ...extra]);
    n++;
  }
  return n;
});

/* One verdict for a URL wherever it is held: its capture, its reading-list entry (kept or skipped)
 * and every stash copy. null clears it, and a list entry goes back to seen. Nothing is removed. */
const judgeQueue = serial();
async function judgeLink(url, verdict) {
  if (verdict !== null && verdict !== "keep" && verdict !== "drop") return { ok: false, error: "a verdict is keep, drop or null" };
  const key = keyOf(url);
  const at = new Date().toISOString();

  const captures = await getCaptures();
  const caps = captures.filter(c => keyOf(c.url) === key || (c.source_url && keyOf(c.source_url) === key));
  for (const c of caps) {
    if (verdict) Object.assign(c, { verdict, judged_at: at });
    else { delete c.verdict; delete c.judged_at; }
  }
  if (caps.length) await setCaptures(captures);

  const items = await getItems();
  const listed = items.filter(i => keyOf(i.url) === key);
  for (const i of listed) {
    if (verdict === "keep") Object.assign(i, { status: "kept", kept_at: at });
    else if (verdict === "drop") Object.assign(i, { status: "skipped", seen_at: at });
    else if (i.status === "kept" || i.status === "skipped") i.status = "seen";
  }
  if (listed.length) await setItems(items);

  const copies = (await getSessions()).flatMap(s => s.tabs).filter(t => keyOf(t.url) === key);
  if (copies.length) {
    await editMeta(m => {
      for (const { id } of copies) {
        const t = { ...m.tabs[id] };
        if (verdict) Object.assign(t, { verdict, judged_at: at });
        else { delete t.verdict; delete t.judged_at; }
        m.tabs[id] = t;
      }
    });
  }
  const held = caps.length + listed.length + copies.length;
  return held ? { ok: true, captures: caps.length, list: listed.length, stashed: copies.length } : { ok: false, error: "that link is not held anywhere" };
}

async function notifyStash(res) {
  if (!res.ok) return notify(`failed: ${res.error}`);
  if (res.why) await notify(`stashed ${res.stashed} · left open: ${res.why}`);
}

/* Adds a site to the never-stash list, or takes it off. */
async function toggleExcluded(host) {
  if (!host) return { ok: false, error: "only web pages have a site to exclude" };
  const settings = await getStashSettings();
  const on = !settings.exclude.includes(host);
  const exclude = on ? [...settings.exclude, host].sort() : settings.exclude.filter(h => h !== host);
  await browser.storage.local.set({ stashSettings: { ...settings, exclude } });
  return { ok: true, host, excluded: on };
}

browser.commands.onCommand.addListener(async name => {
  if (name === "capture-page") await notify(describe(await captureActive()));
  else if (name === "stash-tabs") {
    await notifyStash(await stashTabs());
  } else if (name === "stash-this-tab") {
    await notifyStash(await stashTabs({ scope: "tab" }));
  } else if (name === "show-stashed") {
    await showSessions((await browser.windows.getLastFocused()).id);
  } else if (name === "queue-page") {
    const res = await queueActiveTab();
    await notify(res.added ? "added to the list" : "already on the list");
  }
});

/* --- right-click menu -----------------------------------------------------------
 * Same actions as the popup, for when reaching for a shortcut is not what you want.
 * "page" context covers a plain right-click; "link" lets you queue a link without
 * visiting it, which is the one thing the keyboard cannot do.
 */

const MENU = [
  { id: "menu-keep", title: "Keep this page", contexts: ["page", "selection", "image"] },
  { id: "menu-shot", title: "Keep this page with a full-page screenshot", contexts: ["page", "selection", "image"] },
  { id: "menu-next", title: "Next link in the list", contexts: ["page", "selection", "image"] },
  { id: "menu-skip", title: "Skip this one and go to the next", contexts: ["page", "selection", "image"] },
  { id: "menu-queue", title: "Add this page to the list", contexts: ["page", "selection", "image"] },
  { id: "menu-sep", type: "separator", contexts: ["page", "selection", "image"] },
  { id: "menu-list", title: "See the whole list", contexts: ["page", "selection", "image"] },
  { id: "menu-cards", title: "Judge links as cards", contexts: ["page", "selection", "image"] },
  { id: "menu-sep-stash", type: "separator", contexts: ["page", "selection", "image"] },
  ...stashMenu("page", "Stash", ["page", "selection", "image"]),
  ...stashMenu("tab", "Stash to Link Keeper", ["tab"]),
  { id: "menu-queue-link", title: "Add this link to Link Keeper", contexts: ["link"] },
];

/* The same stash submenu on a page and on a tab in the tab strip, OneTab's range of scopes: on the
 * tab strip, "this tab" is the one right-clicked. The never-stash item is retitled for the site as
 * the menu opens. */
function stashMenu(where, title, contexts) {
  const parentId = `stash:${where}`;
  const item = (scope, text) => ({ id: `stash:${where}:${scope}`, parentId, title: text, contexts });
  return [
    { id: parentId, title, contexts },
    item("auto", "Selected tabs, or the whole window"),
    item("window", "All tabs in this window"),
    item("tab", "Only this tab"),
    item("left", "Tabs to the left"),
    item("right", "Tabs to the right"),
    item("others", "All tabs except this one"),
    item("all-windows", "Every window"),
    { id: `stash:${where}:sep`, parentId, type: "separator", contexts },
    item("exclude", "Never stash this site"),
    item("show", "Show stashed tabs"),
  ];
}

browser.menus.onShown?.addListener(async (info, tab) => {
  if (!info.menuIds.some(id => String(id).startsWith("stash:"))) return;
  const where = info.contexts.includes("tab") ? "tab" : "page";
  const host = hostOfUrl(tab?.url || "");
  const excluded = (await getStashSettings()).exclude.includes(host);
  await browser.menus.update(`stash:${where}:exclude`, {
    title: !host ? "Never stash this site" : excluded ? `Stash ${host} again` : `Never stash ${host}`,
    enabled: !!host,
  });
  await browser.menus.refresh();
});

function buildMenus() {
  browser.menus.removeAll().then(() => {
    for (const item of MENU) browser.menus.create(item);
  });
}

browser.runtime.onInstalled.addListener(buildMenus);
browser.runtime.onStartup.addListener(buildMenus);
buildMenus();

/* What a menu item does — the page and tab-strip menus alike. Named, so a test can press one. */
async function onMenuClicked(info, tab) {
  const stash = /^stash:(page|tab):(.+)$/.exec(info.menuItemId);
  if (stash) {
    const scope = stash[2];
    if (scope === "show") await showSessions(tab?.windowId);
    else if (scope === "exclude") {
      const res = await toggleExcluded(hostOfUrl(tab?.url || ""));
      await notify(res.ok ? (res.excluded ? `${res.host} will not be stashed` : `${res.host} will be stashed again`) : res.error);
    } else await notifyStash(await stashTabs({ windowId: tab?.windowId, scope, tabId: tab?.id }));
    return;
  }
  switch (info.menuItemId) {
    case "menu-keep": await notify(describe(await captureActive())); break;
    case "menu-shot": await notify(describe(await captureActive("", true))); break;
    case "menu-next": {
      const res = await openNext();
      await notify(res.ok ? `${res.remaining} left in the list` : `failed: ${res.error}`);
      break;
    }
    case "menu-skip": {
      await markCurrent("skipped");
      const res = await openNext();
      await notify(res.ok ? `skipped · ${res.remaining} left` : `failed: ${res.error}`);
      break;
    }
    case "menu-queue": {
      const res = await queueActiveTab();
      await notify(res.added ? "added to the list" : "already on the list");
      break;
    }
    case "menu-list": await showPage("list.html", tab?.windowId); break;
    case "menu-cards": await showPage("cards.html", tab?.windowId); break;
    case "menu-queue-link":
      if (info.linkUrl) {
        const res = await addItems([{ url: info.linkUrl.split("#")[0], saved_at: new Date().toISOString() }]);
        await notify(res.added ? "link added to the list" : "already on the list");
      }
      break;
  }
}
browser.menus.onClicked.addListener(onMenuClicked);

/* --- messaging ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener(async msg => {
  switch (msg.type) {
    case "status": {
      const items = await getItems();
      const captures = await getCaptures();
      const current = await getCurrent();
      const counts = { pending: 0, seen: 0, kept: 0 };
      for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return {
        counts,
        total: items.length,
        captures: captures.length,
        current: current && { url: current.url, isOpen: keyOf(tab?.url || "") === current.key },
        next: items.find(i => i.status === "pending")?.url || null,
        upcoming: items.filter(i => i.status === "pending").slice(0, 5).map(i => i.url),
        // summarise() so a plain tweet reads as its text, not "@someone on X"
        recent: captures.slice(-4).reverse().map(r => ({
          label: summarise(r), url: r.url, links: r.links?.length || 0,
        })),
      };
    }

    case "set-current": {
      await browser.storage.local.set({
        current: { key: keyOf(msg.url), url: msg.url, at: new Date().toISOString() },
      });
      await markCurrent("seen");
      return { ok: true };
    }

    case "remove": {
      const drop = new Set(msg.urls.map(keyOf));
      const items = await getItems();
      const removed = items.filter(i => drop.has(keyOf(i.url)));
      await setItems(items.filter(i => !drop.has(keyOf(i.url))));
      if (msg.alsoCaptures) {
        const captures = await getCaptures();
        await setCaptures(captures.filter(c => !drop.has(keyOf(c.url))));
      }
      return { ok: true, removed: drop.size, items: removed };
    }

    case "open-shot": {
      let id = msg.id;
      if (id == null && msg.filename) {
        const hits = await browser.downloads.search({ filenameRegex: msg.filename.split("/").pop() + "$" });
        id = hits.sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0]?.id;
      }
      if (id == null) return { ok: false, error: "that download is no longer in Firefox's history" };
      try {
        await browser.downloads.open(id);
      } catch (e) {
        try {
          await browser.downloads.show(id);
        } catch (e2) {
          return { ok: false, error: String(e2.message || e2) };
        }
      }
      return { ok: true };
    }

    case "get-folder":
      return { folder: cleanFolder(await read("folder", FOLDER_DEFAULT)), fallback: FOLDER_DEFAULT };

    case "set-folder": {
      const folder = cleanFolder(msg.folder);
      await browser.storage.local.set({ folder });
      return { ok: true, folder };
    }

    case "open-list":
      await showPage("list.html", (await browser.windows.getLastFocused()).id, msg.importing ? "#import" : "");
      return { ok: true };

    case "open-cards":
      await showPage("cards.html", (await browser.windows.getLastFocused()).id);
      return { ok: true };

    // Explore became the Links page's detail pane.
    case "open-explore":
      await showPage("list.html", (await browser.windows.getLastFocused()).id, "?pane=1");
      return { ok: true };

    case "open-tags":
      await showPage("tags.html", (await browser.windows.getLastFocused()).id);
      return { ok: true };

    case "page-info":
      return pageInfo(String(msg.url || ""));

    case "link-counts":
      return linkCounts();

    case "open-sessions":
      await showSessions((await browser.windows.getLastFocused()).id);
      return { ok: true };

    case "stash":
      return stashTabs({ scope: msg.scope || "auto" });

    case "sessions": {
      // Each tab carries its link's tags, so an export holds them and an import brings them back.
      const tags = await read("linkTags", {});
      const sessions = await getSessions();
      for (const s of sessions) for (const t of s.tabs) if (tags[keyOf(t.url)]?.length) t.tags = tags[keyOf(t.url)];
      return { sessions };
    }

    case "restore-stash":
      return restoreTabs(msg.id, msg.ids, msg.flip);

    case "put-back":
      return putBack(msg.stash, msg.tabs || []);

    case "restore-items": {
      // Undo of "remove": the entries as they were, back in the list. One already there stays as it is.
      const items = await getItems();
      const have = new Set(items.map(i => keyOf(i.url)));
      const back = (msg.items || []).filter(i => i?.url && !have.has(keyOf(i.url)));
      await setItems([...items, ...back]);
      return { ok: true, restored: back.length };
    }

    case "rename-stash": {
      const session = await findStash(msg.id);
      if (!session) return { ok: false, error: "that stash is gone" };
      const name = String(msg.name || "").trim().slice(0, 200);
      await browser.bookmarks.update(msg.id, { title: name || stashTitle(session.created_at) });
      return { ok: true };
    }

    case "delete-stash": {
      const session = await findStash(msg.id);
      if (session?.locked) return { ok: false, error: "that stash is locked; unlock it first" };
      return { ok: true, removed: (await dropFromStash(msg.id, msg.ids)).length };
    }

    case "move-stash":
      return moveStashToList(msg.id, msg.ids);

    case "move-stashed":
      return moveStashed(msg.ids || [], msg.to, msg.before || null);

    case "flag-stash": {
      if (!await findStash(msg.id)) return { ok: false, error: "that stash is gone" };
      await editMeta(m => {
        const s = m.stashes[msg.id] || (m.stashes[msg.id] = {});
        for (const k of ["locked", "starred"]) {
          if (k in msg) msg[k] ? (s[k] = true) : delete s[k];
        }
      });
      return { ok: true };
    }

    case "clear-dropped": {
      let removed = 0;
      for (const s of await getSessions()) {
        if (msg.id && s.id !== msg.id) continue;
        const dropped = s.tabs.filter(t => t.verdict === "drop").map(t => t.id);
        if (dropped.length) removed += (await dropFromStash(s.id, dropped)).length;
      }
      return { ok: true, removed };
    }

    case "stash-settings":
      return { settings: await getStashSettings() };

    case "set-stash-settings": {
      const settings = await getStashSettings();
      const patch = {};
      if (["show", "stay"].includes(msg.afterStash)) patch.afterStash = msg.afterStash;
      if (["keep", "remove"].includes(msg.afterRestore)) patch.afterRestore = msg.afterRestore;
      await browser.storage.local.set({ stashSettings: { ...settings, ...patch } });
      return { ok: true };
    }

    case "toggle-excluded":
      return toggleExcluded(String(msg.host || "").trim().toLowerCase().replace(/^www\./, ""));

    case "import-stashes":
      return importStashes(msg.stashes, msg.format);

    case "set-stash-source": {
      if (!await findStash(msg.id)) return { ok: false, error: "that stash is gone" };
      await editMeta(m => {
        const st = m.stashes[msg.id] || (m.stashes[msg.id] = {});
        if (msg.source === "import") st.source = "import";
        else { delete st.source; delete st.format; }
      });
      return { ok: true };
    }

    case "links":
      return getLinks();

    case "judge-link":
      // In order: keys fire faster than a verdict is written, and each write reads what the last left.
      return judgeQueue(() => judgeLink(String(msg.url || ""), msg.verdict ?? null));

    case "set-tags":
      return setTags(String(msg.url || ""), msg.tags);

    case "tag-stash":
      return tagStash(msg.id, msg.tags);

    case "rename-tag":
      return renameTag(msg.from, msg.to);

    case "delete-tag":
      return deleteTag(msg.tag);

    case "create-tag":
      return createTag(msg.name, msg.hue);

    case "recolor-tag":
      return recolorTag(msg.tag, msg.hue);

    case "open-stash-cards":
      await browser.tabs.create({ url: browser.runtime.getURL("list.html") + `?pane=1${msg.id ? `&stash=${encodeURIComponent(msg.id)}` : ""}` });
      return { ok: true };

    case "add":
      return addItems(msg.urls, msg.note);

    case "queue-active": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return { ok: false, error: "no active tab" };
      // Queued from the browser, so "now" genuinely is when it was saved.
      return addItems([{ url: tab.url.split("#")[0], saved_at: new Date().toISOString() }], msg.note);
    }

    case "next":
      return openNext();

    case "skip":
      await markCurrent("skipped");
      return openNext();

    case "capture-active":
      return captureActive(msg.note, !!msg.withShot);

    case "capture-url":
      return captureUrl(msg.url, msg.note);

    case "export": {
      const tags = await read("linkTags", {});
      return { captures: (await getCaptures()).map(c => (tags[keyOf(c.url)]?.length ? { ...c, tags: tags[keyOf(c.url)] } : c)) };
    }

    /* Captures produced outside the browser — importers/enrich-x.py resolves x.com links via a
     * public API with no login, so half a pile can arrive already read. Merged on the same
     * normalised key the rest of the extension uses; an incoming record wins only where the
     * existing one has no text, so a real page read is never overwritten by an API summary. */
    /* refresh.zsh leaves the rebuilt file behind a loopback URL and exits once it has been read, so
     * the list page can collect it with no file dialog and nothing to paste. Silent when nothing is
     * waiting — that is the normal case. */
    case "fetch-pending": {
      const url = msg.url || "http://127.0.0.1:8790/link-handoff.json";
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return { ok: false, quiet: true, error: `HTTP ${res.status}` };
        return { ok: true, body: await res.text(), url };
      } catch (e) {
        return { ok: false, quiet: true, error: String(e.message || e) };
      }
    }

    case "import-captures": {
      const captures = await getCaptures();
      const byId = new Map(captures.map(c => [keyOf(c.url), c]));
      let added = 0, enriched = 0, skipped = 0;
      for (const rec of msg.records || []) {
        if (!rec?.url) continue;
        const key = keyOf(rec.url);
        const existing = byId.get(key);
        if (!existing) {
          captures.push(rec);
          byId.set(key, rec);
          added++;
        } else if (!existing.text && rec.text) {
          Object.assign(existing, rec, { verdict: existing.verdict });
          enriched++;
        } else {
          skipped++;
        }
      }
      await setCaptures(captures);

      // A captured link leaves the worklist as opened, so Next stops walking you to links you
      // already hold the full text for. Keeping it is still yours to do.
      const items = await getItems();
      const haveCapture = new Set(captures.map(c => keyOf(c.url)));
      let marked = 0;
      for (const item of items) {
        if (item.status === "pending" && haveCapture.has(keyOf(item.url))) {
          item.status = "seen";
          item.seen_at = new Date().toISOString();
          marked++;
        }
      }
      if (marked) await setItems(items);

      await mergeTags(msg.records || []);
      return { ok: true, added, enriched, skipped, marked, total: captures.length };
    }

    case "export-list":
      return { items: await getItems() };

    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
});

paintBadge().catch(() => {});
