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
  await browser.action.setBadgeBackgroundColor({ color: "#7a5cff" });
}

/* --- worklist ------------------------------------------------------------------- */

/* Same normalisation on both sides of a comparison: x.com/i/status/<id> and
 * x.com/<handle>/status/<id> are the same post, and a trailing slash is never meaningful. */
function keyOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const status = u.pathname.match(/\/status\/(\d+)/);
    if (/^(x|twitter)\.com$/.test(host) && status) return `status:${status[1]}`;
    return host + u.pathname.replace(/\/$/, "") + u.search;
  } catch (e) {
    return String(url);
  }
}

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
    const { url, saved_at } = typeof raw === "string" ? { url: raw } : raw;
    if (!url) continue;
    const existing = byId.get(keyOf(url));
    if (existing) {
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

/* Open the next pending link in the tab you are in. Opening counts as seen; capturing is
 * what upgrades it to kept. */
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
  if (!browser.downloads) throw new Error("no downloads permission — reload the extension");
  if (!browser.tabs.captureVisibleTab) {
    throw new Error(await hasSiteAccess()
      ? "captureVisibleTab missing even with site access — reload the extension"
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
      return { ok: false, error: `no access to that site — grant it and retry (${e.message || e})` };
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

    // It has been read, so it leaves the queue.
    const items = await getItems();
    const item = items.find(i => keyOf(i.url) === keyOf(url) || keyOf(i.url) === key);
    if (item && item.status !== "kept") {
      item.status = "kept";
      item.kept_at = new Date().toISOString();
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

  // A capture arriving while a worklist item is open is that item's verdict. The URL is
  // matched loosely because x.com rewrites /i/status/<id> to /<handle>/status/<id> on load.
  const current = await getCurrent();
  if (current && (keyOf(record.url) === current.key || keyOf(tab.url || "") === current.key)) {
    record.from_worklist = current.url;
    await markCurrent("kept");
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
    ? `${r.author.handle} — ${r.title}`
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

browser.commands.onCommand.addListener(async name => {
  if (name === "capture-page") await notify(describe(await captureActive()));
  else if (name === "next-link") {
    const res = await openNext();
    await notify(res.ok ? `${res.remaining} left in the list` : `failed: ${res.error}`);
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
  { id: "menu-shot", title: "Keep this page + full-page screenshot", contexts: ["page", "selection", "image"] },
  { id: "menu-next", title: "Next link in the list", contexts: ["page", "selection", "image"] },
  { id: "menu-skip", title: "Skip this one and go to the next", contexts: ["page", "selection", "image"] },
  { id: "menu-queue", title: "Add this page to the list", contexts: ["page", "selection", "image"] },
  { id: "menu-sep", type: "separator", contexts: ["page", "selection", "image"] },
  { id: "menu-list", title: "See the whole list", contexts: ["page", "selection", "image"] },
  { id: "menu-cards", title: "Judge links as cards", contexts: ["page", "selection", "image"] },
  { id: "menu-queue-link", title: "Add this link to Link Keeper", contexts: ["link"] },
];

function buildMenus() {
  browser.menus.removeAll().then(() => {
    for (const item of MENU) browser.menus.create(item);
  });
}

browser.runtime.onInstalled.addListener(buildMenus);
browser.runtime.onStartup.addListener(buildMenus);
buildMenus();

browser.menus.onClicked.addListener(async (info, tab) => {
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
    case "menu-list": await browser.tabs.create({ url: browser.runtime.getURL("list.html") }); break;
    case "menu-cards": await browser.tabs.create({ url: browser.runtime.getURL("cards.html") }); break;
    case "menu-queue-link":
      if (info.linkUrl) {
        const res = await addItems([{ url: info.linkUrl.split("#")[0], saved_at: new Date().toISOString() }]);
        await notify(res.added ? "link added to the list" : "already on the list");
      }
      break;
  }
});

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

    /* Everything the list page needs, joined here where keyOf lives. */
    /* Captures that have been read but not yet judged — the card deck. A card needs the page's
     * content to be judgeable at all, so the deck runs over captures rather than bare URLs. */
    case "deck": {
      const captures = await getCaptures();
      const thumbs = await read("thumbs", {});
      const items = await getItems();
      const savedBy = new Map(items.map(i => [keyOf(i.url), i.saved_at || i.added_at]));
      return {
        cards: captures
          .filter(c => !c.verdict)
          .map(c => ({
            url: c.url,
            kind: c.kind,
            title: c.title || null,
            handle: c.author?.handle || null,
            name: c.author?.name || null,
            text: c.text || null,
            note: c.note || null,
            posted: c.posted || null,
            saved_at: savedBy.get(keyOf(c.url)) || c.captured_at || null,
            images: c.images || [],
            links: (c.links || []).map(l => l.resolved || l.href).filter(Boolean),
            reply_links: (c.reply_links || []).map(l => ({
              href: l.resolved || l.href, from: l.from || null, self: !!l.self,
            })).filter(l => l.href),
            shotThumb: thumbs[c.screenshot?.filename] || null,
            code_blocks: (c.code_blocks || []).length,
          })),
        judged: captures.filter(c => c.verdict).length,
        keep: captures.filter(c => c.verdict === "keep").length,
        drop: captures.filter(c => c.verdict === "drop").length,
      };
    }

    /* A verdict is reversible and never deletes the capture: passing null clears it. */
    case "judge": {
      const captures = await getCaptures();
      const target = captures.find(c => keyOf(c.url) === keyOf(msg.url));
      if (!target) return { ok: false, error: "no capture for that link" };
      if (msg.verdict) target.verdict = msg.verdict;
      else delete target.verdict;
      target.judged_at = msg.verdict ? new Date().toISOString() : undefined;
      await setCaptures(captures);
      return { ok: true };
    }

    case "dump": {
      const items = await getItems();
      const captures = await getCaptures();
      const byKey = new Map(captures.map(c => [keyOf(c.url), c]));
      const thumbs = await read("thumbs", {});
      const current = await getCurrent();
      return {
        items: items.map(i => {
          const cap = byKey.get(keyOf(i.url)) || null;
          return {
            url: i.url,
            status: i.status,
            added_at: i.added_at,
            saved_at: i.saved_at || null,
            note: i.note || cap?.note || null,
            current: current?.key === keyOf(i.url),
            cap: cap && {
              title: cap.title,
              handle: cap.author?.handle || null,
              text: cap.text || null,
              kind: cap.kind,
              links: (cap.links || []).map(l => l.resolved || l.href).filter(Boolean),
              reply_links: (cap.reply_links || []).map(l => ({
                href: l.resolved || l.href, from: l.from || null, self: !!l.self,
              })).filter(l => l.href),
              images: cap.images || [],
              screenshot: cap.screenshot?.filename || null,
              shotThumb: thumbs[cap.screenshot?.filename] || null,
              shotId: cap.screenshot?.downloadId ?? null,
              verdict: cap.verdict || null,
            },
          };
        }),
        // Captures with no matching list entry — kept from a page you just happened to be on.
        loose: captures
          .filter(c => !items.some(i => keyOf(i.url) === keyOf(c.url)))
          .map(c => ({
            url: c.url,
            status: "kept",
            added_at: c.captured_at,
            saved_at: c.posted || null,
            note: c.note || null,
            current: false,
            cap: {
              title: c.title,
              handle: c.author?.handle || null,
              text: c.text || null,
              kind: c.kind,
              links: (c.links || []).map(l => l.resolved || l.href).filter(Boolean),
              reply_links: (c.reply_links || []).map(l => ({
                href: l.resolved || l.href, from: l.from || null, self: !!l.self,
              })).filter(l => l.href),
              images: c.images || [],
              screenshot: c.screenshot?.filename || null,
              shotThumb: thumbs[c.screenshot?.filename] || null,
              shotId: c.screenshot?.downloadId ?? null,
              verdict: c.verdict || null,
            },
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
      await setItems(items.filter(i => !drop.has(keyOf(i.url))));
      if (msg.alsoCaptures) {
        const captures = await getCaptures();
        await setCaptures(captures.filter(c => !drop.has(keyOf(c.url))));
      }
      return { ok: true, removed: drop.size };
    }

    case "mark": {
      const items = await getItems();
      const item = items.find(i => keyOf(i.url) === keyOf(msg.url));
      if (!item) return { ok: false, error: "not on the list" };
      item.status = msg.status;
      await setItems(items);
      return { ok: true };
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
      await browser.tabs.create({
        url: browser.runtime.getURL("list.html") + (msg.importing ? "#import" : ""),
      });
      return { ok: true };

    case "open-cards":
      await browser.tabs.create({ url: browser.runtime.getURL("cards.html") });
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

    case "export":
      return { captures: await getCaptures() };

    /* Captures produced outside the browser — importers/enrich-x.py resolves x.com links via a
     * public API with no login, so half a pile can arrive already read. Merged on the same
     * normalised key the rest of the extension uses; an incoming record wins only where the
     * existing one has no text, so a real page read is never overwritten by an API summary. */
    /* refresh.zsh leaves the rebuilt file behind a loopback URL and exits once it has been read, so
     * the list page can collect it with no file dialog and nothing to paste. Silent when nothing is
     * waiting — that is the normal case. */
    case "fetch-pending": {
      const url = msg.url || "http://127.0.0.1:8790/link-captures-all.jsonl";
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

      // A capture means the link has been read, so the worklist should stop offering it. Without
      // this, Next walks you to links you already hold the full text for.
      const items = await getItems();
      const haveCapture = new Set(captures.map(c => keyOf(c.url)));
      let marked = 0;
      for (const item of items) {
        if (item.status === "pending" && haveCapture.has(keyOf(item.url))) {
          item.status = "kept";
          item.kept_at = new Date().toISOString();
          marked++;
        }
      }
      if (marked) await setItems(items);

      return { ok: true, added, enriched, skipped, marked, total: captures.length };
    }

    case "export-list":
      return { items: await getItems() };

    case "clear-captures":
      await setCaptures([]);
      await browser.storage.local.set({ thumbs: {} });
      return { ok: true };

    case "clear-list":
      await setItems([]);
      await browser.storage.local.set({ current: null });
      return { ok: true };

    case "reset-progress": {
      const items = await getItems();
      for (const i of items) {
        if (i.status !== "kept") { i.status = "pending"; delete i.seen_at; }
      }
      await setItems(items);
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
});

paintBadge().catch(() => {});
