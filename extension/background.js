/* A worklist of links you walk at your own pace, and a capture store you export as a file.
 *
 * Two lists in storage.local:
 *   items    — the reading list: { url, title?, added_at, saved_at?, note? }.
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
}

async function setCaptures(captures) {
  await browser.storage.local.set({ captures });
}

/* A new capture of a link replaces its record, keeping where an importer found it sent (the DM's
 * account, thread and senders), which a page read cannot know. */
const ORIGIN_FIELDS = ["account", "thread", "senders"];
function replaceCapture(captures, record) {
  const key = keyOf(record.url);
  const old = captures.find(r => keyOf(r.url) === key);
  for (const f of ORIGIN_FIELDS) if (old?.[f] && !record[f]) record[f] = old[f];
  return [...captures.filter(r => keyOf(r.url) !== key), record];
}

/* --- trash ---------------------------------------------------------------------- */

/* What is removed from a stash or the reading list waits here for TRASH_DAYS, with what it takes to
 * put it back: a tab entry holds the stash it left (id, name, date, flags) and its place and marks,
 * an item entry the whole reading-list entry. Old entries are dropped whenever the trash is read —
 * there is no timer to rely on in an event page — and when the add-on starts. */
const TRASH_DAYS = 30;

async function getTrash() {
  const all = await read("trash", []);
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  const keep = all.filter(e => Date.parse(e.at) >= cutoff);
  if (keep.length !== all.length) await browser.storage.local.set({ trash: keep });
  return keep;
}

async function addToTrash(entries) {
  if (!entries.length) return [];
  const at = new Date().toISOString();
  const made = entries.map((e, i) => ({ id: `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`, at, ...e }));
  await browser.storage.local.set({ trash: [...made, ...await getTrash()] });
  return made.map(e => e.id);
}

async function deleteFromTrash(ids) {
  const gone = new Set(ids);
  const all = await getTrash();
  const keep = all.filter(e => !gone.has(e.id));
  await browser.storage.local.set({ trash: keep });
  return all.length - keep.length;
}

/* Put trashed entries back. Tabs of one stash go back together; a stash that is gone is written
 * again once, and the entries still waiting for it follow it to its new id. An entry that cannot
 * be put back stays in the trash. */
async function restoreFromTrash(ids) {
  const want = new Set(ids);
  const picked = (await getTrash()).filter(e => want.has(e.id));
  const done = [];
  const where = new Set();
  const items = picked.filter(e => e.kind === "item");
  if (items.length) {
    await restoreItems(items.map(e => e.item));
    done.push(...items.map(e => e.id));
    where.add("no stash");
  }
  const caps = picked.filter(e => e.kind === "capture");
  if (caps.length) {
    const have = await getCaptures();
    const keys = new Set(have.map(c => keyOf(c.url)));
    await setCaptures([...have, ...caps.map(e => e.capture).filter(c => !keys.has(keyOf(c.url)))]);
    done.push(...caps.map(e => e.id));
    where.add("the captures");
  }
  const byStash = new Map();
  for (const e of picked.filter(e => e.kind === "tab")) {
    if (!byStash.has(e.stash.id)) byStash.set(e.stash.id, []);
    byStash.get(e.stash.id).push(e);
  }
  for (const [sid, es] of byStash) {
    const res = await putBack(es[0].stash, es.map(e => ({ url: e.url, title: e.title, ...e.tab })));
    if (!res.ok) continue;
    done.push(...es.map(e => e.id));
    where.add((await findStash(res.id))?.name || es[0].stash.name);
    if (res.id !== sid) {
      const rest = await getTrash();
      for (const e of rest) if (e.stash?.id === sid) e.stash.id = res.id;
      await browser.storage.local.set({ trash: rest });
    }
  }
  await deleteFromTrash(done);
  return { ok: true, restored: done.length, where: [...where] };
}

/* --- worklist ------------------------------------------------------------------- */

/* When the link was originally saved, wherever it came from — not when it was pasted here. That
 * distinction is the whole point: a Telegram export spans years, and "added_at" would flatten it
 * all to the minute of the paste. */
function dateOf(item) {
  return item?.saved_at || item?.added_at || "";
}


/* group: where the new links go — the day's group by default, a named batch's own. Since 5.64 every
 * link sits in a group, so a link added this way gets no reading-list entry: its date and note ride
 * on its tab. A link already held (in a group, or on the old list) is skipped; re-adding one on the
 * old list with a date fills the date in, as before. null keeps the old list-only behaviour. */
async function addItems(entries, note = "", group = dayGroup()) {
  if (group) {
    const items = await getItems();
    const onList = new Map(items.map(i => [keyOf(i.url), i]));
    const held = new Set((await getSessions()).flatMap(s => s.tabs.map(t => keyOf(t.url))));
    const fresh = [];
    let updated = 0, skipped = 0, listChanged = false;
    for (const raw of entries) {
      const { url, saved_at, title } = typeof raw === "string" ? { url: raw } : raw;
      if (!url) continue;
      const k = keyOf(url);
      const old = onList.get(k);
      if (old && saved_at && old.saved_at !== saved_at) { old.saved_at = saved_at; updated++; listChanged = true; continue; }
      if (old || held.has(k) || fresh.some(f => keyOf(f.url) === k)) { skipped++; continue; }
      fresh.push({ url, title, saved_at: saved_at || undefined, note: note || undefined });
    }
    if (listChanged) await setItems(items);
    const res = fresh.length ? await addToGroup(fresh, group) : { added: 0 };
    return { ok: true, added: res.added || 0, updated, skipped, total: items.length };
  }
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

/* --- capture -------------------------------------------------------------------- */

/* Injected into the tab in front of you (a capture from the shortcut or the popup). extractors.js returns
 * null while a single-page app is still hydrating, so poll briefly rather than capture an empty shell.
 * The tab is shown, so its timers run; a tab out of sight is read by readTab instead. checkWall false
 * reads a login page or captcha as it is, since you chose it. */
async function runExtractor(checkWall = false) {
  for (let i = 0; i < 12; i++) {
    const wall = checkWall && LK.wall();
    if (wall) return { kind: "page", title: document.title || null, url: location.href, wall };
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
        const res = await fetch(link.href, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
        return { ...link, resolved: res.url || null };
      } catch (e) {
        return { ...link, resolved: null };
      }
    })
  );
}

/* The links among a capture's replies, resolved once and written back onto the replies that hold
 * them, so a t.co address is looked up a single time. */
async function resolveReplyLinks(record) {
  if (!record.reply_links?.length) return;
  record.reply_links = await resolveLinks(record.reply_links);
  const resolved = new Map(record.reply_links.map(l => [l.href, l.resolved]));
  for (const reply of record.replies || []) {
    reply.links = (reply.links || []).map(l => ({ ...l, resolved: resolved.get(l.href) ?? l.resolved }));
  }
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

/* `walk`, when given, gathers the replies the page shows at each stop of the scroll: x.com drops
 * the ones scrolled out of view, so they are read as they pass. Its `result` holds them afterwards,
 * even when the screenshot itself fails. */
async function fullPageShot(tab, slug, walk = null) {
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
    // The reply walk ends where x.com's "Discover more" section begins (replyBoundary in
    // extractors.js); the scroll goes on for the screenshot, but nothing more is read.
    let repliesEnded = false;
    if (walk) repliesEnded = !!(await inject(tab.id, () => LK.startReplyWalk()))?.ended;

    const scale = Math.min(dpr, SHOT_MAX_DEVICE_PX / h);
    const scaledDown = scale < dpr;   // the page was too tall to render at full resolution
    const tiles = [];
    for (let y = 0, n = 0; y < h && n < SHOT_MAX_TILES; y += vh, n++) {
      const at = await inject(tab.id, yy => { window.scrollTo(0, yy); return window.scrollY; }, [y]);
      await sleep(TILE_SETTLE_MS);
      if (walk && !repliesEnded) repliesEnded = !!(await inject(tab.id, () => LK.noteReplies()))?.ended;
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
    if (walk) walk.result = await inject(tab.id, () => LK.endReplyWalk()).catch(() => null);
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
/* Injected: one read of the page, with no waiting in it. A page out of sight may have its timers
 * throttled or frozen, so a wait inside it can last minutes; readTab waits out here instead. */
function readOnce() {
  const wall = LK.wall();
  if (wall) return { kind: "page", title: document.title || null, url: location.href, wall };
  return LK.extract();
}

/* Resolves to what p resolves to, or rejects with `why` after ms. */
const withTimeout = (p, ms, why) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);

/* Reads a page in a tab out of sight, as runExtractor does for the one in front of you, but polling from
 * here: a site reader that is not ready yet, or a plain page with under 200 characters of text (an app
 * still drawing itself), is read again every 250 ms for up to 8 s, and the fullest read is kept. */
async function readTab(tabId) {
  const once = async () => (await withTimeout(browser.scripting.executeScript({ target: { tabId }, func: readOnce }), 5000, "the page stopped answering"))[0]?.result || null;
  await withTimeout(browser.scripting.executeScript({ target: { tabId }, files: ["extractors.js"] }), 5000, "the page stopped answering");
  const size = r => (r?.text || "").trim().length;
  const end = Date.now() + 8000;
  let best = null;
  for (;;) {
    const record = await once();
    if (record?.wall || (record && (record.kind !== "page" || size(record) >= 200))) return record;
    if (record && (!best || size(record) >= size(best))) best = record;
    if (Date.now() >= end) {
      if (best) return best;
      const tab = await browser.tabs.get(tabId).catch(() => null);
      return { kind: "page", title: tab?.title || null, url: tab?.url || null, incomplete: true };
    }
    await new Promise(r => setTimeout(r, 250));
  }
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
    // A new tab reports "complete" for its first about:blank before the page asked for starts; that
    // is not the page, and reading it fails for want of a host permission.
    const ready = t => t.status === "complete" && t.url !== "about:blank";
    const onUpdated = (id, changed, t) => {
      if (id === tabId && ready(t)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    browser.tabs.onUpdated.addListener(onUpdated);
    // It may already be loaded by the time we start listening.
    browser.tabs.get(tabId).then(t => { if (ready(t)) finish(true); }).catch(() => finish(false));
  });
}

/* One link, start to finish: open it out of sight, read it, close it, store it. A wall in front of the
 * page (a login, a captcha, a block) is not stored; `wall` names its kind for the capture queue. The
 * queue passes its own window, so its tabs stay out of the tab strip. A page that holds it past a
 * minute fails, and its tab is closed, so one page can never hold up a queue. */
const CAPTURE_LIMIT = 60000;
async function captureUrl(url, note = "", windowId = undefined) {
  const opened = {};
  try {
    return await withTimeout(captureIn(url, note, windowId, opened), CAPTURE_LIMIT, "the page took over a minute to read");
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (opened.tab) await browser.tabs.remove(opened.tab.id).catch(() => {});
  }
}

async function captureIn(url, note, windowId, opened) {
  let tab;
  try {
    tab = opened.tab = await browser.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
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
      // With every site granted, a refusal is Firefox's own: its PDF viewer, an error page, or a site it
      // protects from every add-on (addons.mozilla.org).
      const why = String(e.message || e);
      if (/host permission/i.test(why) && await hasSiteAccess()) return { ok: false, error: "Firefox lets no add-on read this page (a PDF, an error page, or a protected site)" };
      return { ok: false, error: /host permission/i.test(why) ? `no access to that site; grant it and retry (${why})` : why };
    }
    if (!record) return { ok: false, error: "nothing extractable on that page" };
    if (record.wall) return { ok: false, wall: record.wall.kind, error: record.wall.reason };

    record.url = (record.url || record.canonical || url).split("#")[0];
    const visited = url.split("#")[0];
    record.source_url = visited !== record.url ? visited : null;
    record.captured_at = new Date().toISOString();
    record.via = "list";
    if (note) record.note = note;
    record.links = await resolveLinks(record.links);
    await resolveReplyLinks(record);

    const captures = await getCaptures();
    await setCaptures(replaceCapture(captures, record));
    if (!capThin(record)) await clearCaptureFail(url);

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
    const [result] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: runExtractor, args: [false] });
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

  if (withShot) {
    // The walk the screenshot makes is also how a post's replies are all seen.
    const walk = Array.isArray(record.replies) ? { result: null } : null;
    try {
      record.screenshot = await fullPageShot(tab, slugFor(record, tab), walk);
    } catch (e) {
      record.screenshot_error = String(e.message || e);
    }
    if (walk?.result) Object.assign(record, walk.result);
  }
  await resolveReplyLinks(record);

  // Or one you took yourself with Firefox's own tool, waiting to be claimed.
  const { pendingShot } = await browser.storage.local.get("pendingShot");
  if (!record.screenshot && pendingShot && Date.now() - pendingShot.at < SHOT_WINDOW_MS) {
    record.screenshot = { filename: pendingShot.filename, via: "firefox" };
    await browser.storage.local.set({ pendingShot: null });
  }

  // A capture arriving while a worklist item is open takes it off the queue as opened.
  // The URL is matched loosely because x.com rewrites /i/status/<id> to /<handle>/status/<id> on load.
  const current = await getCurrent();
  if (current && (keyOf(record.url) === current.key || keyOf(tab.url || "") === current.key)) {
    record.from_worklist = current.url;
  }

  const captures = await getCaptures();
  await setCaptures(replaceCapture(captures, record));

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
  const replies = r.replies?.length ? ` · ${r.replies.length} repl${r.replies.length > 1 ? "ies" : "y"}` : "";
  const fromReplies = r.reply_links?.length ? ` · ${r.reply_links.length} from replies` : "";
  return `kept ${summarise(r)}${links}${replies}${fromReplies}${shot}`;
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
 * uninstall) loses containers, never a tab:
 *
 *   stashRoot     — the root folder's id
 *   stashMeta     — { stashes: { [folderId]: { created_at, source?, format? } },
 *                     tabs:    { [bookmarkId]: { container? } } }
 *   stashSettings — { afterStash: "show" | "stay", exclude: [host] }  (an afterRestore stored before is ignored)
 *
 * Opening never takes anything out. Lock and Star went in 5.58; flags stored before then are unread.
 * (Keep and Drop verdicts and opened marks are gone; ones stored before then stay in their records, unread.)
 *
 * Only the tab's URL, title and container are recorded. Nothing is injected into the tabs being
 * stashed. A stash is the only record of the tabs it closes — Firefox remembers 25 closed tabs — so
 * nothing closes until every bookmark has been read back and found present.
 */

const ROOT_TITLE = "Link Keeper stashes";
// saved_at: the link's own date (when a chat message was sent, a post was saved), kept per tab now
// that every link sits in a group.
// note: what was written when the link was added (a single add's note), now that adds go into groups.
const TAB_META = ["container", "saved_at", "note"];
const STASH_SETTINGS = { afterStash: "show", exclude: [] };
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

/* In the order they came into Link Keeper, newest first: { id, name, created_at, ingested_at, source,
 * format, group_key, tabs: [{ id, url, title?, container?, saved_at? }] }. ingested_at is when the
 * group came in — written for groups made since 5.64, else the folder's own date — so an import of
 * old stashes sits where it was imported, not at its stashes' dates. Bookmarks moved or edited in
 * Firefox's own library show up here as they are. */
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
      ingested_at: m.ingested_at || (folder.dateAdded ? new Date(folder.dateAdded).toISOString() : m.created_at || null),
      // "import" when an import wrote it, "tabs" when it was stashed from open tabs.
      source: m.source === "import" ? "import" : "tabs",
      ...(m.format && { format: m.format }),
      ...(m.group_key && { group_key: m.group_key }),
      tabs: (folder.children || []).filter(n => n.url).map(b => ({
        id: b.id,
        url: b.url,
        ...(b.title && b.title !== b.url && { title: b.title }),
        ...meta.tabs[b.id],
      })),
    };
  });
  // Stable: groups with no date keep their bookmark order.
  const at = s => Date.parse(s.ingested_at) || 0;
  return sessions.map((s, i) => [s, i]).sort((a, b) => (at(b[0]) - at(a[0])) || a[1] - b[1]).map(([s]) => s);
}

async function findStash(id) {
  return (await getSessions()).find(s => s.id === id) || null;
}

/* Writes one stash at the top: the folder, one bookmark per tab in order, then its metadata, then
 * reads it all back. ok is false unless every bookmark made is in the folder with its URL, and
 * every container is recorded. onFolder hears the new
 * folder's id before anything else is written, so a caller can undo a write that fails halfway. */
async function writeStash(tabs, { name, created_at, onFolder, source, format, ingested_at, group_key } = {}) {
  const at = created_at || new Date().toISOString();
  const folder = await browser.bookmarks.create({ parentId: await stashRoot(), index: 0, title: name || stashTitle(at) });
  await onFolder?.(folder.id);
  const made = [];
  for (const t of tabs) made.push(await browser.bookmarks.create({ parentId: folder.id, title: t.title || t.url, url: t.url }));
  await editMeta(m => {
    m.stashes[folder.id] = { created_at: at, ...(source === "import" && { source, ...(format && { format }) }),
      ...(ingested_at && { ingested_at }), ...(group_key && { group_key }) };
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

/* --- groups: every way links come in makes one -------------------------------------------------
 * A stash, an import, a chat grab, a refresh hand-over and a single "+ Add" are the same thing: a
 * group of links with the time it came in. A batch makes its own group; single adds collect into the
 * day's ("Added Oct 15, 2026", group_key "day:2026-10-15"). Links already in the target group are not
 * added twice. Each tab keeps its own date (saved_at). */
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = (d = new Date()) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dayGroup = () => ({ name: `Added ${dayLabel()}`, group_key: `day:${dayOf()}` });

const groupQueue = serial();
function addToGroup(tabs, opts = {}) {
  const done = addToGroupNow(tabs, opts);
  // Each new link gets its preview as it comes in, after the group is written and without holding it up.
  done.then(res => { if (res?.added && !opts.noPreview) previewNew(tabs.map(t => t?.url).filter(Boolean)).catch(() => {}); });
  return done;
}
function addToGroupNow(tabs, { name, group_key, ingested_at } = {}) {
  return groupQueue(async () => {
    const seen = new Set();
    const clean = tabs.filter(t => t?.url && !seen.has(keyOf(t.url)) && seen.add(keyOf(t.url)))
      .map(t => ({ url: asBookmarked(t.url), ...(t.title && { title: String(t.title).slice(0, 500) }), ...(t.saved_at && { saved_at: t.saved_at }), ...(t.note && { note: String(t.note).slice(0, 2000) }) }));
    if (!clean.length) return { ok: true, added: 0 };
    const target = group_key ? (await getSessions()).find(s => s.group_key === group_key) : null;
    if (!target) {
      const at = ingested_at || new Date().toISOString();
      const res = await writeStash(clean, { name, created_at: at, ingested_at: at, group_key });
      return { ok: res.ok, id: res.id, added: clean.length, made: true };
    }
    // Into the day's group, newest at the top: links it already holds are skipped.
    const have = new Set(target.tabs.map(x => keyOf(x.url)));
    const fresh = clean.filter(x => !have.has(keyOf(x.url)));
    const made = [];
    for (const [i, x] of fresh.entries()) made.push([await browser.bookmarks.create({ parentId: target.id, index: i, title: x.title || x.url, url: x.url }), x]);
    await editMeta(m => {
      for (const [b, x] of made) {
        const extra = Object.fromEntries(["saved_at", "note"].filter(k => x[k]).map(k => [k, x[k]]));
        if (Object.keys(extra).length) m.tabs[b.id] = { ...(m.tabs[b.id] || {}), ...extra };
      }
      // The group moves up as it fills: it came in again just now.
      if (made.length && m.stashes[target.id]) m.stashes[target.id].ingested_at = new Date().toISOString();
    });
    return { ok: true, id: target.id, added: made.length };
  });
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
const GROUP_PATCH = "2026-10-15-group-loose-links";
/* Each preview's picture is a storage entry of its own, PREVIEW_IMG + link key, and the preview says
 * image: true. The previews stay small, so a reload of every link moves no pictures (5.65 kept them
 * inline: 40 MB at 2000 links, read and sent to the page on every remove), and a page fetches each
 * picture once (link-view.js, fillPreviewPics). */
const PREVIEW_IMG = "pvimg:";
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
  {
    // The owner's own LinkedIn profile is a page they keep open, not one to read: filter it out,
    // as the right-click item would. Other people's profiles stay in the pile.
    id: "2026-10-07-filter-own-linkedin",
    async run() {
      const rule = "linkedin.com/in/mert-yasin";
      const rules = await getFilterRules();
      if (rules.includes(rule)) return { skipped: "already a rule" };
      const res = await setFilterRules([...rules, rule]);
      return { added: rule, matched: res.matched };
    },
  },
  {
    // Opened marks, Keep and Drop verdicts and reading-list statuses went in 5.56; nothing reads
    // them any more. Strips them from stored tabs, captures and reading-list entries. Irreversible,
    // so it waits for the helper and a backup first; with no helper it throws and the next launch
    // tries again.
    id: "2026-10-15-purge-opened-marks-and-verdicts",
    async run() {
      if (typeof bridge !== "undefined") {
        for (let i = 0; i < 20 && bridge.state !== "on"; i++) await new Promise(r => setTimeout(r, 500));
        const saved = await backupNow("before-purge");
        if (!saved?.ok) throw new Error(`no backup, so nothing purged: ${saved?.error || "the helper did not answer"}`);
      }
      const gone = { tabs: 0, captures: 0, items: 0 };
      await editMeta(m => {
        for (const t of Object.values(m.tabs || {})) {
          if ("seen_at" in t || "verdict" in t || "judged_at" in t) {
            delete t.seen_at; delete t.verdict; delete t.judged_at; gone.tabs++;
          }
        }
      });
      const captures = await getCaptures();
      for (const c of captures) if ("verdict" in c || "judged_at" in c) { delete c.verdict; delete c.judged_at; gone.captures++; }
      if (gone.captures) await setCaptures(captures);
      const items = await getItems();
      for (const i of items) {
        if ("status" in i || "seen_at" in i || "kept_at" in i) { delete i.status; delete i.seen_at; delete i.kept_at; gone.items++; }
      }
      if (gone.items) await setItems(items);
      return gone;
    },
  },
  {
    // x.com's icon was saved from a tab showing a notification count, red dot and all. It goes; a
    // clean tab saves it again (saveFavicons now skips counted tabs), and until then the drawn one shows.
    id: "2026-10-15-drop-badged-x-icon",
    async run() {
      const all = await read("favicons", {});
      const gone = ["x.com", "twitter.com", "www.x.com"].filter(h => all[h]);
      for (const h of gone) delete all[h];
      if (gone.length) await browser.storage.local.set({ favicons: all });
      return { dropped: gone };
    },
  },
  {
    // Every link sits in a group since 5.64: the links in no stash become groups, one per day and
    // source they came in ("Instagram export · Oct 14, 2026"), placed among the stashes by that day.
    // Nothing else changes — their list entries and captures stay — so undoGrouping() takes the groups
    // back out. A backup is written first.
    id: GROUP_PATCH,
    async run() {
      if (typeof bridge !== "undefined") {
        for (let i = 0; i < 20 && bridge.state !== "on"; i++) await new Promise(r => setTimeout(r, 500));
        const saved = await backupNow("before-grouping");
        if (!saved?.ok) throw new Error(`no backup, so nothing grouped: ${saved?.error || "the helper did not answer"}`);
      }
      return groupLooseLinks();
    },
  },
  {
    // 5.65 kept each preview's picture inside the previews entry; each moves to its own (PREVIEW_IMG).
    id: "2026-10-17-preview-pictures-apart",
    async run() {
      const all = await read("previews", {});
      const pics = {};
      for (const [k, p] of Object.entries(all)) {
        if (typeof p?.image === "string") { pics[PREVIEW_IMG + k] = p.image; all[k] = { ...p, image: true }; }
      }
      if (Object.keys(pics).length) await browser.storage.local.set({ ...pics, previews: all });
      return { moved: Object.keys(pics).length };
    },
  },
  {
    // An Instagram post keys as ig:<id> since 5.66, whichever of its addresses was saved.
    id: "2026-10-17-instagram-one-key",
    run: () => rekeyStored(["instagram.com/"]),
  },
  {
    // A YouTube video keys as yt:<id> since 5.67: youtu.be/<id>?si= and youtube.com/watch?v=<id> are one link.
    id: "2026-10-17-youtube-one-key",
    run: () => rekeyStored(["youtube.com/", "m.youtube.com/", "music.youtube.com/", "youtu.be/"]),
  },
];

/* After keyOf learns that several addresses are one link: what was stored under the old keys that start
 * with one of prefixes moves to the new key. Tags join; for the rest the entry already there wins. */
async function rekeyStored(prefixes) {
  const moved = {};
  const rekey = k => (prefixes.some(p => k.startsWith(p)) ? keyOf(`https://${k}`) : k);
  for (const name of ["linkTags", "tagSuggestions", "agentTags", "previews"]) {
    const all = await read(name, {});
    let n = 0;
    for (const k of Object.keys(all)) {
      const to = rekey(k);
      if (to === k) continue;
      if (name === "linkTags") all[to] = [...new Set([...(all[to] || []), ...(all[k] || [])])];
      else if (!(to in all)) all[to] = all[k];
      delete all[k];
      n++;
    }
    if (n) await browser.storage.local.set({ [name]: all });
    moved[name] = n;
  }
  const pics = await browser.storage.local.get(null);
  const out = {}, gone = [];
  for (const [k, v] of Object.entries(pics)) {
    if (!k.startsWith(PREVIEW_IMG)) continue;
    const to = PREVIEW_IMG + rekey(k.slice(PREVIEW_IMG.length));
    if (to === k) continue;
    if (!(to in pics) && !(to in out)) out[to] = v;
    gone.push(k);
  }
  if (gone.length) { await browser.storage.local.set(out); await browser.storage.local.remove(gone); }
  moved.pictures = gone.length;
  // Two captures now under one key (an importer's of youtu.be/<id>, a page read of watch?v=<id>) become
  // one: the newest, keeping the other's origin, in the place of the first.
  const caps = await getCaptures();
  const best = new Map();
  for (const c of caps) {
    const k = keyOf(c.url), old = best.get(k);
    if (!old) { best.set(k, c); continue; }
    const [win, lose] = String(c.captured_at || "") >= String(old.captured_at || "") ? [c, old] : [old, c];
    for (const f of ORIGIN_FIELDS) if (lose[f] && !win[f]) win[f] = lose[f];
    best.set(k, win);
  }
  if (best.size < caps.length) {
    const seen = new Set();
    await setCaptures(caps.map(c => keyOf(c.url)).filter(k => !seen.has(k) && seen.add(k)).map(k => best.get(k)));
  }
  moved.captures = caps.length - best.size;
  return moved;
}

// Where a loose link came from, by the importer that wrote its capture.
const SOURCE_LABELS = { "instagram-export": "Instagram export", "watch-reel": "Instagram reels", "x-archive": "X archive",
  fxtwitter: "Refresh", web: "Refresh", api: "Refresh", exa: "Refresh", redirect: "Refresh" };

async function groupLooseLinks() {
  const { links } = await getLinks();
  const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
  const groups = new Map();
  for (const l of links) {
    if (!l.list || l.copies.length) continue;
    const c = caps.get(l.key);
    const when = l.list.added_at || c?.captured_at || new Date().toISOString();
    const at = new Date(when);
    const label = c?.via === "chat-grab" ? `${(Array.isArray(c.thread) ? c.thread[0] : c.thread) || "Chat"} chat`
      : !l.list.loose && !SOURCE_LABELS[c?.via] ? "Added" : SOURCE_LABELS[c?.via] || "Added";
    const day = dayOf(at);
    const g = groups.get(`${day}|${label}`) || groups.set(`${day}|${label}`, { label, day, at: when, tabs: [] }).get(`${day}|${label}`);
    if (when < g.at) g.at = when;
    g.tabs.push({ url: l.url, title: l.title || l.cap?.title || undefined, saved_at: l.list.saved_at || c?.saved_at || undefined });
  }
  const made = [];
  const grouped = new Set([...groups.values()].flatMap(g => g.tabs.map(t => keyOf(t.url))));
  try {
    for (const g of [...groups.values()].sort((a, b) => a.at.localeCompare(b.at))) {
      g.tabs.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));
      const res = await writeStash(g.tabs, { name: `${g.label} · ${dayLabel(new Date(g.at))}`, created_at: g.at, ingested_at: g.at,
        ...(g.label === "Added" && { group_key: `day:${g.day}` }), onFolder: id => { made.push(id); } });
      if (!res.ok) throw new Error("a group did not read back");
    }
  } catch (e) {
    for (const id of made) await removeStashFolder(id);
    throw e;
  }
  // The links now live in their groups: their reading-list entries go, kept here for undo. A note
  // on one moves onto its tab.
  const items = await getItems();
  const moved = items.filter(i => grouped.has(keyOf(i.url)));
  const notes = new Map(moved.filter(i => i.note).map(i => [keyOf(i.url), i.note]));
  if (notes.size) {
    const sessions = await getSessions();
    await editMeta(m => {
      for (const s of sessions.filter(s => made.includes(s.id))) {
        for (const t of s.tabs) if (notes.has(keyOf(t.url))) m.tabs[t.id] = { ...(m.tabs[t.id] || {}), note: notes.get(keyOf(t.url)) };
      }
    });
  }
  if (moved.length) await setItems(items.filter(i => !grouped.has(keyOf(i.url))));
  return { groups: made.length, links: grouped.size, stashes: made, items: moved };
}

/* Takes the groups the conversion made back out: the links go back to being in no stash. Groups that
 * have since been deleted are skipped; links added to one since are kept in no stash with the rest. */
async function undoGrouping() {
  const done = await read("dataPatches", {});
  const rec = done[GROUP_PATCH];
  if (!rec?.stashes?.length || rec.undone) return { ok: false, error: "there is no grouping to undo" };
  const have = new Set((await getSessions()).map(s => s.id));
  let removed = 0;
  for (const id of rec.stashes) if (have.has(id)) { await removeStashFolder(id); removed++; }
  // Their reading-list entries come back, except for links added to the list again since.
  const items = await getItems();
  const has = new Set(items.map(i => keyOf(i.url)));
  const back = (rec.items || []).filter(i => !has.has(keyOf(i.url)));
  if (back.length) await setItems([...items, ...back]);
  rec.undone = new Date().toISOString();
  await browser.storage.local.set({ dataPatches: done });
  return { ok: true, removed };
}

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
browser.runtime.onStartup.addListener(() => getTrash().catch(() => {}));
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

/* --- filtered out ---------------------------------------------------------------
 * filterRules: ["mail.google.com/mail/u/0/#inbox", …] — the main pages of sites, which are
 * stashed with the rest but kept out of the pages' main pile: links matching a rule carry the
 * "filtered-out" tag, which the pages hide unless asked. A rule is a URL without its scheme, www.,
 * query or trailing slash, matched whole; * stands for any run of characters. So "reddit.com" is
 * Reddit's front page and nothing under it, and an email under #inbox/<id> is not the inbox.
 * filteredAuto: the keys the rules tagged, so a rule taken away untags only what it tagged. */
const FILTER_TAG = "filtered-out";
const DEFAULT_FILTER_RULES = [
  "mail.google.com/mail/u/*/#inbox",
  "calendar.google.com/calendar/u/*/r", "calendar.google.com/calendar/u/*/r/month*",
  "calendar.google.com/calendar/u/*/r/week*", "calendar.google.com/calendar/u/*/r/day*",
  "drive.google.com", "drive.google.com/drive/home", "drive.google.com/drive/my-drive",
  "reddit.com", "old.reddit.com", "x.com/home", "youtube.com", "instagram.com", "pinterest.com",
  "netflix.com", "netflix.com/browse", "about:newtab", "about:home",
];
/* A URL as a rule sees it. */
function filterForm(url) {
  if (/^about:/i.test(url)) return url.split(/[?#]/)[0].toLowerCase();
  try {
    const u = new URL(url);
    // A trailing slash goes, unless a #part follows it: Gmail's inbox is /mail/u/0/#inbox.
    const path = u.hash ? u.pathname : u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}${u.hash}`.toLowerCase();
  } catch (e) { return ""; }
}
const cleanRule = r => filterForm(/^[a-z]+:/i.test(String(r).trim()) ? String(r).trim() : `https://${String(r).trim()}`)
  || String(r).trim().toLowerCase();
const ruleTest = rule => new RegExp(`^${rule.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
async function getFilterRules() {
  const got = await read("filterRules", null);
  return Array.isArray(got) ? got : DEFAULT_FILTER_RULES;
}
const matchesRules = (url, tests) => { const f = filterForm(url); return !!f && tests.some(t => t.test(f)); };

/* Tag every link a rule matches, and untag what the rules tagged and no longer match. */
const filterQueue = serial();
const applyFilterRules = () => filterQueue(async () => {
  const tests = (await getFilterRules()).map(r => ruleTest(cleanRule(r)));
  const { links } = await getLinks();
  const auto = new Set(await read("filteredAuto", []));
  let added = 0, removed = 0, matched = 0;
  await editTags(all => {
    for (const l of links) {
      const hit = matchesRules(l.url, tests);
      const tags = all[l.key] || [];
      if (hit) {
        matched++;
        if (!tags.includes(FILTER_TAG)) { all[l.key] = [...tags, FILTER_TAG]; auto.add(l.key); added++; }
      } else if (auto.has(l.key)) {
        all[l.key] = tags.filter(t => t !== FILTER_TAG);
        auto.delete(l.key);
        removed++;
      }
    }
  });
  await browser.storage.local.set({ filteredAuto: [...auto] });
  return { ok: true, matched, added, removed };
});
async function setFilterRules(rules) {
  const clean = [...new Set((Array.isArray(rules) ? rules : []).map(cleanRule).filter(Boolean))];
  await browser.storage.local.set({ filterRules: clean });
  return { ...(await applyFilterRules()), rules: clean };
}
async function filterOutPage(url) {
  const rule = filterForm(url);
  if (!rule) return { ok: false, error: "this page has no address to filter out" };
  const rules = await getFilterRules();
  if (!rules.includes(rule)) await setFilterRules([...rules, rule]);
  return { ok: true, rule };
}
// New links — a stash, an import, a capture, a queued page — are matched as they arrive.
let filterTimer = null;
const filterSoon = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => applyFilterRules().catch(() => {}), 1500); };
browser.bookmarks?.onCreated?.addListener(filterSoon);
browser.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.items || changes.captures)) filterSoon(); });
browser.runtime.onInstalled.addListener(() => applyFilterRules().catch(() => {}));

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

/* Counts for agents, taken in the background so no page holds the whole dataset: every link (the
 * pile is one since 5.58, whatever a stored viewSources says), how many have no tags yet, and links
 * per source. */
async function linkCounts() {
  const { links, stashes } = await getLinks();
  const sources = { tabs: 0, import: 0, list: 0 };
  for (const l of links) for (const s of l.sources) sources[s]++;
  return { total: links.length, untagged: links.filter(l => !l.tags.length).length, sources, stashes: stashes.length };
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

/* How many tabs each scope would stash right now, counted as stashTabsNow chooses them: pinned
 * tabs, never-stash sites and pages that cannot be recorded stay, and one URL open twice counts once. */
async function stashCounts({ windowId, tabId } = {}) {
  const settings = await getStashSettings();
  const take = t => recordable(t) && !t.pinned && !settings.exclude.includes(hostOfUrl(t.url));
  const count = (all, scope) => {
    const at = all.find(t => t.id === tabId) || all.find(t => t.active);
    return new Set(scopeTabs(all, scope, at).filter(take).map(t => t.url)).size;
  };
  const all = await browser.tabs.query(windowId == null ? { currentWindow: true } : { windowId });
  const windows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })).map(w => w.tabs);
  const counts = Object.fromEntries(["auto", "window", "left", "right", "others"].map(s => [s, count(all, s)]));
  counts["all-windows"] = windows.reduce((n, w) => n + count(w, "window"), 0);
  return { ok: true, counts };
}

const SCOPE_WORDS = {
  tab: "this tab", left: "the tabs to the left", right: "the tabs to the right", others: "the other tabs",
  window: "this window", "all-windows": "any window",
};

/* Stash tabs and close them. { windowId, scope, tabId } — tabId is the tab a scope is relative to,
 * the active one by default; scope "all-windows" makes one stash per window. One at a time: a
 * command, menu item or button that fires twice would otherwise read the same tabs twice and write
 * the stash twice; the second run starts after the first has closed its tabs and finds them gone. */
const stashQueue = serial();
function stashTabs(opts = {}) {
  return stashQueue(() => stashTabsNow(opts));
}

async function stashTabsNow({ windowId, scope = "auto", tabId } = {}) {
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
    // A tab titled "(3) Home / X" shows a notification count, and sites like X draw it into the
    // favicon too: that one would stand for the site with a red dot. Wait for a clean tab.
    if (/^\(\d+\+?\)\s/.test(t.title || "")) continue;
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
 * so forty tabs back is not forty page loads — each loads when you switch to it. The stash is
 * left as it was. */
async function restoreTabs(id, ids) {
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

  return { ok: true, restored: wanted.length, viaHelper, standins: standins.length, helperError };
}

async function restoreItems(wanted) {
  const items = await getItems();
  const have = new Set(items.map(i => keyOf(i.url)));
  const back = wanted.filter(i => i?.url && !have.has(keyOf(i.url)));
  await setItems([...items, ...back]);
  return { ok: true, restored: back.length };
}

/* Undo of taking tabs out: each goes back into its stash at the place it had, with its marks. A
 * stash that went with its last tab is written again, with its name and date, at the top.
 * stash: { id, name, created_at, source?, format? }; tabs: [{ url, title?, index,
 * container? }]. Returns the stash's id and the new bookmark ids. */
async function putBack(stash, tabs) {
  if (!stash?.id || !tabs.length) return { ok: false, error: "nothing to put back" };
  let id = stash.id;
  const [node] = await browser.bookmarks.get(id).catch(() => []);
  if (!node || node.url) {
    id = (await writeStash([], { name: stash.name, created_at: stash.created_at, source: stash.source, format: stash.format })).id;
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
 * left empty goes with them. Returns what was taken. */
async function dropFromStash(id, ids, { trash = true } = {}) {
  const session = await findStash(id);
  if (!session) return [];
  const taken = ids ? session.tabs.filter(t => ids.includes(t.id)) : session.tabs;
  // Moves pass trash: false: the tab is not gone, it is somewhere else. The entry ids ride on
  // the returned array, for a caller whose undo must take them out of the trash again.
  const trashed = trash ? await addToTrash(taken.map(t => ({
    kind: "tab", url: t.url, title: t.title,
    stash: { id, name: session.name, created_at: session.created_at, source: session.source, format: session.format },
    tab: { index: session.tabs.indexOf(t), ...Object.fromEntries(TAB_META.filter(k => t[k] != null).map(k => [k, t[k]])) },
  }))) : [];
  for (const t of taken) await browser.bookmarks.remove(t.id);
  // Only an empty folder goes: one the user put anything else in stays.
  const emptied = !(await browser.bookmarks.getChildren(id)).length;
  if (emptied) await browser.bookmarks.remove(id);
  await editMeta(m => {
    for (const t of taken) delete m.tabs[t.id];
    if (emptied) delete m.stashes[id];
  });
  taken.trashed = trashed;
  return taken;
}

/* Drag and drop: move bookmarks, in order, into stash `to` ahead of bookmark `before` (the end if
 * none). Only bookmarks in stashes move; a stash left empty goes. */
async function moveStashed(ids, to, before) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === to);
  if (!target) return { ok: false, error: "that stash is gone" };
  const from = new Map(sessions.flatMap(s => s.tabs.map(t => [t.id, s])));
  const moving = ids.filter(id => from.has(id));
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

/* Stashes from a file: [{ name?, created_at?, tabs: [{ url, title?, container? }] }],
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
  const [items, captures, sessions, thumbs, current, tags, suggestions, agentTags, previews, fails] =
    [await getItems(), await getCaptures(), await getSessions(), await read("thumbs", {}), await getCurrent(), await read("linkTags", {}),
      await read("tagSuggestions", {}), await read("agentTags", {}), await read("previews", {}), await read("captureFails", {})];
  return joinLinks({ items, captures, sessions, thumbs, currentKey: current?.key || null, tags, suggestions, agentTags, previews, fails });
}

/* --- failed captures --------------------------------------------------------------
 * Why the capture queue could not capture a link: captureFails, { [link key]: { error, kind, at } } with
 * kind "wall" (a login, captcha or block), "thin" (kept, but almost no text), "skipped" (its site was
 * stopped first) or "error". Links shows them under Failed, apart from Not captured, so a run never
 * tries them again by itself; capturing one from Failed, or by hand, clears its entry. Writes go one at
 * a time: the queue's two workers would otherwise overwrite each other's. */
let failWrites = Promise.resolve();
function editCaptureFails(change) {
  failWrites = failWrites.then(async () => {
    const fails = await read("captureFails", {});
    if (change(fails) !== false) await browser.storage.local.set({ captureFails: fails });
  }).catch(() => {});
  return failWrites;
}
const recordCaptureFail = (url, error, kind) => editCaptureFails(f => { f[keyOf(url)] = { error: String(error || "failed").slice(0, 300), kind, at: new Date().toISOString() }; });
const clearCaptureFail = url => editCaptureFails(f => (keyOf(url) in f ? void delete f[keyOf(url)] : false));

/* --- previews -------------------------------------------------------------------
 * A picture and a line for every link, as a chat app shows under a link: previews: { [link key]:
 * { title, text, image (a small JPEG data URL), src, at } } or { none: true, at } when the page has
 * none. Made once and kept, so a picture whose address expires (x.com, Instagram) still shows.
 *
 * From what is held first — a capture's title, text and first picture — and otherwise from the page's
 * preview tags (og:/twitter: title, description, image), fetched once under Link Keeper's own name.
 * New links get theirs as they come in; the ones held before ask for theirs from Settings, which says
 * how many and can be stopped. Pages are fetched one at a time, a few seconds apart. */
const PREVIEW_W = 320, PREVIEW_H = 200, PREVIEW_PAUSE = [1500, 3000];
const previewQueue = serial();
let previewRun = null;   // { total, done, made, none, failed, stop }

function metaOf(doc, ...names) {
  for (const n of names) {
    const v = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content");
    if (v && v.trim()) return v.trim();
  }
  return null;
}

async function thumbOf(src) {
  try {
    const res = await fetch(src, { credentials: "omit" });
    const blob = res.ok ? await res.blob() : null;
    if (!blob || !blob.type.startsWith("image/") || blob.size > 8e6) return null;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, PREVIEW_W / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.min(PREVIEW_H, Math.round(bmp.height * scale)));
    const c = new OffscreenCanvas(w, h);
    // Wider than tall pictures are kept whole; a tall one keeps its top, as chat previews do.
    c.getContext("2d").drawImage(bmp, 0, 0, bmp.width, Math.min(bmp.height, h / scale), 0, 0, w, h);
    const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    return await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => bad(r.error); r.readAsDataURL(out); });
  } catch (e) {
    return null;
  }
}

/* One link's preview: from its capture when it has one, else from its page. null when the page could
 * not be read at all (try again later); { none: true } when it was read and offers nothing. */
async function makePreview(url, cap) {
  const at = new Date().toISOString();
  const imgOf = c => (c?.images || []).map(i => (typeof i === "string" ? i : i?.src || i?.url)).find(s => /^https?:/.test(s || "") && !/\.(mp4|webm|m3u8)(\?|$)/.test(s));
  if (cap && (cap.title || cap.text)) {
    const src = imgOf(cap);
    return { title: cap.title || null, text: (cap.text || "").replace(/\s+/g, " ").slice(0, 240) || null, image: src ? await thumbOf(src) : null, src: src || null, at, from: "capture" };
  }
  if (!/^https?:/.test(url)) return { none: true, at };
  let html;
  try {
    const res = await fetch(url, { credentials: "omit", headers: { Accept: "text/html" } });
    if (!res.ok || !/html/.test(res.headers.get("content-type") || "")) return { none: true, at, status: res.status };
    html = (await res.text()).slice(0, 600_000);
  } catch (e) {
    return null;
  }
  const tags = previewTags(html, url);
  if (!tags.title && !tags.text && !tags.src) return { none: true, at };
  return { ...tags, image: tags.src ? await thumbOf(tags.src) : null, at, from: "page" };
}

/* A page's preview tags: og: and twitter: title, description and picture (made absolute), else its
 * <title>. Named so a test can read a page without fetching it. */
function previewTags(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = metaOf(doc, "og:title", "twitter:title") || doc.querySelector("title")?.textContent?.trim() || null;
  const text = metaOf(doc, "og:description", "twitter:description", "description");
  let src = metaOf(doc, "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (src) try { src = new URL(src, url).href; } catch (e) { src = null; }
  return { title, text: text ? text.slice(0, 240) : null, src: src || null };
}

async function savePreview(key, p) {
  if (!p) return;
  await previewQueue(async () => {
    const { image, ...rest } = p;
    const all = await read("previews", {});
    all[key] = image ? { ...rest, image: true } : rest;
    await browser.storage.local.set({ ...(image ? { [PREVIEW_IMG + key]: image } : {}), previews: all });
  });
}

async function hasAllSites() {
  try { return await browser.permissions.contains({ origins: ["*://*/*"] }); } catch (e) { return false; }
}

/* New links get a preview as they come in: the links given, those not made yet. */
async function previewNew(urls) {
  const have = await read("previews", {});
  const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
  const canFetch = await hasAllSites();
  for (const url of urls) {
    const k = keyOf(url);
    if (have[k]) continue;
    const cap = caps.get(k);
    if (!cap?.title && !cap?.text && !canFetch) continue;   // nothing held and no leave to fetch
    await savePreview(k, await makePreview(url, cap));
    if (!cap) await new Promise(r => setTimeout(r, PREVIEW_PAUSE[0]));
  }
}

/* The links held before previews existed, from Settings: one at a time, paced, stoppable. */
async function previewBacklog() {
  if (previewRun && !previewRun.finished) return { ok: false, error: "already making previews" };
  const { links } = await getLinks();
  const have = await read("previews", {});
  const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
  const todo = links.filter(l => !have[l.key] && (/^https?:/.test(l.url)));
  previewRun = { total: todo.length, done: 0, made: 0, none: 0, failed: 0, fetched: 0, stop: false, finished: false, started: new Date().toISOString() };
  const run = previewRun;
  (async () => {
    const canFetch = await hasAllSites();
    for (const l of todo) {
      if (run.stop) break;
      const cap = caps.get(l.key);
      const fromPage = !(cap?.title || cap?.text);
      if (fromPage && !canFetch) { run.done++; continue; }
      if (fromPage && run.fetched) await new Promise(r => setTimeout(r, PREVIEW_PAUSE[0] + Math.random() * (PREVIEW_PAUSE[1] - PREVIEW_PAUSE[0])));
      if (run.stop) break;
      const p = await makePreview(l.url, cap);
      if (fromPage) run.fetched++;
      await savePreview(l.key, p);
      run.done++;
      if (!p) run.failed++; else if (p.none) run.none++; else run.made++;
    }
    run.finished = true;
  })();
  return { ok: true, total: run.total };
}
async function previewCounts() {
  const { links } = await getLinks();
  const have = await read("previews", {});
  const web = links.filter(l => /^https?:/.test(l.url));
  return { links: web.length, made: web.filter(l => have[l.key] && !have[l.key].none).length, none: web.filter(l => have[l.key]?.none).length,
    missing: web.filter(l => !have[l.key]).length, canFetch: await hasAllSites(), run: previewRun && { ...previewRun } };
}

/* --- tags ------------------------------------------------------------------------
 * linkTags: { [link key]: ["tag", ...] } — the tags set by hand, one list per URL wherever it is
 * held. Firefox gives extensions no access to bookmark tags, so they live here, and travel in the
 * stash and capture exports. One queue, so two edits cannot each overwrite the other.
 *
 * tagDefs: { seeded: true, list: [{ name, hue }] } — the tag library, in the order tags were made:
 * the presets, then each tag as it is first used or created. hue is null until a colour is picked,
 * and the name's own hue shows. Every tag in use is in it; the pages offer it to pick from.
 *
 * tagSuggestions: { [link key]: { at, tags: [{ tag, p, by }] } } — what a local model suggests for a
 * link, best first (p is 0..1; by is "system-one", "gutsy" or "model"). Written only by agents
 * (set-tag-suggestions). The pages show them dimmed in a link's place until it has tags of its own;
 * accepting them is an ordinary set-tags, and the entry stays in storage, unshown.
 *
 * agentTags: { [link key]: { at, by, tags: ["tag", ...] } } — tags a Claude agent wrote (by is the
 * model's name). A layer of its own: never the owner's tags, never a suggestion, shown in a labelled
 * row of outlined chips after the owner's. Written only by agents (set-agent-tags). */
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

/* Replace the suggestions of the links named (url → [{ tag, p, by }]), or of every link when replace
 * is true. An empty list takes a link's entry away. Tag names are cleaned like any tag. */
const setTagSuggestions = (suggestions, replace) => tagQueue(async () => {
  if (!suggestions || typeof suggestions !== "object" || Array.isArray(suggestions)) return { ok: false, error: "suggestions must be an object of url → [{ tag, p, by }]" };
  const all = replace ? {} : await read("tagSuggestions", {});
  const at = new Date().toISOString();
  let written = 0;
  for (const [url, list] of Object.entries(suggestions)) {
    if (!Array.isArray(list)) return { ok: false, error: `${url}: expected a list of { tag, p, by }` };
    const tags = suggestionsFor({ k: { tags: list } }, "k");
    const key = keyOf(url);
    if (tags.length) { all[key] = { at, tags }; written++; } else delete all[key];
  }
  await browser.storage.local.set({ tagSuggestions: all });
  return { ok: true, count: Object.keys(all).length, written };
});

/* Set the agent tags of the links named (url → [tag]), written by `by`; merges per link unless replace
 * is true, which drops every other link's. An empty list takes a link's entry away. */
const setAgentTags = (tags, by, replace) => tagQueue(async () => {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return { ok: false, error: "tags must be an object of url → [tag]" };
  const author = String(by || "").trim().slice(0, 60);
  if (!author) return { ok: false, error: "by must name the model that wrote the tags" };
  const all = replace ? {} : await read("agentTags", {});
  const at = new Date().toISOString();
  for (const [url, list] of Object.entries(tags)) {
    if (!Array.isArray(list)) return { ok: false, error: `${url}: expected a list of tag names` };
    const names = tagList(list);
    const key = keyOf(url);
    if (names.length) all[key] = { at, by: author, tags: names }; else delete all[key];
  }
  await browser.storage.local.set({ agentTags: all });
  return { ok: true, count: Object.keys(all).length };
});

/* Add tags to every tab of a stash. A link showing only suggestions or guesses keeps them, now as its own. */
async function tagStash(id, add) {
  const stash = await findStash(id);
  if (!stash) return { ok: false, error: "that stash is gone" };
  const extra = tagList(add);
  if (!extra.length) return { ok: false, error: "no tag given" };
  const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
  const suggested = await read("tagSuggestions", {});
  return editTags(all => {
    for (const t of stash.tabs) {
      const k = keyOf(t.url);
      const mine = suggestionsFor(suggested, k).map(s => s.tag);
      const had = all[k]?.length ? all[k] : mine.length ? mine : guessTags(t.url, caps.get(k));
      all[k] = tagList([...had, ...extra]);
    }
    return { ok: true, tagged: stash.tabs.length };
  });
}

/* Add tags to each of these links, keeping the tags they already carry. */
async function tagLinks(urls, add) {
  const extra = tagList(add);
  if (!extra.length) return { ok: false, error: "no tag given" };
  const keys = [...new Set((Array.isArray(urls) ? urls : []).map(u => keyOf(String(u))))];
  if (!keys.length) return { ok: false, error: "no links given" };
  return editTags(all => {
    for (const k of keys) all[k] = tagList([...(all[k] || []), ...extra]);
    return { ok: true, tagged: keys.length };
  });
}

/* Rename a tag everywhere; renaming onto an existing tag merges the two. */
/* What a rename, merge or delete is about to change: the tags of every link carrying either name,
 * and the library, so putTagsBack can undo it. */
const tagsBefore = (all, lib, names) => ({
  links: Object.fromEntries(Object.entries(all).filter(([, ts]) => names.some(n => ts.includes(n))).map(([k, ts]) => [k, [...ts]])),
  lib: lib.map(d => ({ ...d })),
});

const putTagsBack = before => editTags((all, lib) => {
  if (!before?.links || !Array.isArray(before.lib)) return { ok: false, error: "nothing to put back" };
  for (const [k, ts] of Object.entries(before.links)) all[k] = tagList(ts);
  lib.splice(0, lib.length, ...before.lib);
  return { ok: true };
});

const renameTag = (from, to) => editTags((all, lib) => {
  const a = cleanTag(from), b = cleanTag(to);
  if (!a || !b) return { ok: false, error: "a tag needs a name" };
  const before = tagsBefore(all, lib, [a, b]);
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
  return { ok: true, links: n, before };
});

const deleteTag = tag => editTags((all, lib) => {
  const a = cleanTag(tag);
  const before = tagsBefore(all, lib, [a]);
  const i = lib.findIndex(d => d.name === a);
  if (i !== -1) lib.splice(i, 1);
  let n = 0;
  for (const k of Object.keys(all)) {
    if (!all[k].includes(a)) continue;
    all[k] = all[k].filter(t => t !== a);
    n++;
  }
  return { ok: true, links: n, before };
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
  if (name === "capture-page") await confirmCapture(await captureActive());
  else if (name === "stash-tabs") {
    await notifyStash(await stashTabs());
  } else if (name === "stash-this-tab") {
    await notifyStash(await stashTabs({ scope: "tab" }));
  } else if (name === "show-stashed") {
    await showSessions((await browser.windows.getLastFocused()).id);
  } else if (name === "queue-page") {
    const res = await queueActiveTab();
    await notify(res.added ? "added" : "already here");
  }
});

/* --- right-click menu -----------------------------------------------------------
 * Same actions as the popup, for when reaching for a shortcut is not what you want.
 * "page" context covers a plain right-click; "link" lets you queue a link without
 * visiting it, which is the one thing the keyboard cannot do.
 */

/* The chat pages chat-grab.js reads, as menu URL patterns and as a test on a tab's URL. */
const CHAT_PAGES = ["*://x.com/i/chat/*", "*://www.instagram.com/direct/t/*"];
const CHAT_PAGE_RE = /^https:\/\/((www\.)?x\.com\/i\/chat\/|www\.instagram\.com\/direct\/t\/)/;
const CHAT_LAST_N = 200;

const MENU = [
  { id: "menu-keep", title: "Capture this page", contexts: ["page", "selection", "image"] },
  { id: "menu-shot", title: "Capture this page with a full-page screenshot", contexts: ["page", "selection", "image"] },
  { id: "menu-queue", title: "Add this page to Link Keeper", contexts: ["page", "selection", "image"] },
  { id: "menu-filter", title: "Filter out this page (a site's main page)", contexts: ["page"] },
  { id: "menu-sep", type: "separator", contexts: ["page", "selection", "image"] },
  { id: "menu-list", title: "Links", contexts: ["page", "selection", "image"] },
  { id: "menu-sep-stash", type: "separator", contexts: ["page", "selection", "image"] },
  ...stashMenu("page", "Stash", ["page", "selection", "image"]),
  ...stashMenu("tab", "Stash to Link Keeper", ["tab"]),
  { id: "menu-queue-link", title: "Add this link to Link Keeper", contexts: ["link"] },
  ...chatMenu(),
];

/* On a chat page only: grab the links out of the chat (chat-grab.js). A date range is the popup's. */
function chatMenu() {
  const contexts = ["page", "link", "selection", "image"];
  const documentUrlPatterns = CHAT_PAGES;
  const item = (id, title) => ({ id: `chat:${id}`, parentId: "chat", title, contexts, documentUrlPatterns });
  return [
    { id: "chat", title: "Grab links from this chat", contexts, documentUrlPatterns },
    item("after", "Since the last grab"),
    item("last", `The last ${CHAT_LAST_N} messages`),
    item("all", "The whole chat"),
  ];
}

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
  const chat = /^chat:(after|last|all)$/.exec(info.menuItemId);
  if (chat) {
    const mode = chat[1];
    await notify(describeGrab(await grabChat(tab.id, mode === "last" ? { mode, n: CHAT_LAST_N } : { mode })));
    return;
  }
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
    case "menu-keep": await confirmCapture(await captureActive()); break;
    case "menu-shot": await confirmCapture(await captureActive("", true)); break;
    case "menu-filter": {
      const res = await filterOutPage(tab?.url || "");
      await notify(res.ok ? `${res.rule} is filtered out` : res.error);
      break;
    }
    case "menu-queue": {
      const res = await queueActiveTab();
      await notify(res.added ? "added" : "already here");
      break;
    }
    case "menu-list": await showPage("list.html", tab?.windowId); break;
    case "menu-queue-link":
      if (info.linkUrl) {
        const res = await addItems([{ url: info.linkUrl.split("#")[0], saved_at: new Date().toISOString() }]);
        await notify(res.added ? "link added" : "already here");
      }
      break;
  }
}
browser.menus.onClicked.addListener(onMenuClicked);

/* --- links out of a chat -------------------------------------------------------------- */

function isChatPage(url) { return CHAT_PAGE_RE.test(url || ""); }

async function chatScript(tabId) {
  await browser.scripting.executeScript({ target: { tabId }, files: ["chat-grab.js"] });
}

/* Which chat a tab shows, and when it was last grabbed; null when it is no chat. */
async function chatInfo(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (!isChatPage(tab.url)) return null;
  await chatScript(tabId);
  const [{ result }] = await browser.scripting.executeScript({ target: { tabId }, func: () => ({ ...window.LKChat.info(), run: window.LKChat.poll() }) });
  if (!result?.platform) return null;
  if (result.run?.none) delete result.run;
  const key = result.thread?.id ? `${result.platform}:${result.thread.id}` : null;
  return { ...result, key, last: key ? (await read("chatGrabs", {}))[key] || null : null };
}

/* The links in one grab's messages as capture records: one per link, every distinct sender, the
 * earliest sending, and a shared post's author and text when the chat showed them. */
function chatRecords(messages, thread, platform) {
  // A site's own label first: Instagram's matches what its export import calls the thread.
  const label = thread?.label || thread?.handle || thread?.name || `${platform} chat`;
  const byKey = new Map();
  for (const m of messages) {
    for (const l of m.links || []) {
      if (!l.url) continue;
      const k = keyOf(l.url);
      const at = Number.isFinite(m.at) ? new Date(m.at).toISOString() : null;
      let rec = byKey.get(k);
      if (!rec) {
        rec = { url: l.url, kind: l.kind || "page", saved_at: at, via: "chat-grab", thread: [label], senders: [],
          captured_at: new Date().toISOString(), ...(l.text ? { text: l.text } : {}), ...(l.author ? { author: l.author } : {}),
          ...(l.title ? { title: l.title } : {}), ...(l.posted ? { posted: l.posted } : {}), ...(l.links?.length ? { links: l.links } : {}) };
        byKey.set(k, rec);
      }
      if (at && (!rec.saved_at || at < rec.saved_at)) rec.saved_at = at;
      if (m.sender && !rec.senders.includes(m.sender)) rec.senders.push(m.sender);
      if (!rec.text && l.text) Object.assign(rec, { text: l.text, author: l.author || rec.author, ...(l.posted ? { posted: l.posted } : {}), ...(l.links?.length ? { links: l.links } : {}) });
    }
  }
  return [...byKey.values()];
}

/* Grabbed records into the captures: a new link is added; one already held gains this chat and its
 * senders, and its text if it had none. A page read is never overwritten. */
async function importChatRecords(records) {
  const captures = await getCaptures();
  const byKey = new Map(captures.map(c => [keyOf(c.url), c]));
  let added = 0, updated = 0;
  for (const rec of records) {
    const have = byKey.get(keyOf(rec.url));
    if (!have) {
      captures.push(rec);
      byKey.set(keyOf(rec.url), rec);
      added++;
      continue;
    }
    let changed = false;
    for (const f of ["thread", "senders"]) {
      const list = Array.isArray(have[f]) ? have[f] : have[f] ? [have[f]] : [];
      const more = rec[f].filter(v => !list.includes(v));
      if (more.length) { have[f] = [...list, ...more]; changed = true; }
    }
    if (!have.text && rec.text) { Object.assign(have, { text: rec.text, author: rec.author || have.author, kind: have.kind || rec.kind }); changed = true; }
    if (!have.saved_at && rec.saved_at) { have.saved_at = rec.saved_at; changed = true; }
    if (changed) updated++;
  }
  await setCaptures(captures);
  return { added, updated };
}

/* range: { mode: "after" } (since the last grab; the last CHAT_LAST_N the first time), { mode: "last", n },
 * { mode: "since", since: "YYYY-MM-DD" } or { mode: "all" }. */
async function grabChat(tabId, range) {
  const chat = await chatInfo(tabId).catch(e => ({ error: String(e.message || e) }));
  if (!chat) return { ok: false, error: "this tab is not a chat Link Keeper can read" };
  if (chat.error) return { ok: false, error: chat.error };
  if (chat.locked) return { ok: false, error: "the chat's messages are not on the page: open the chat, enter your passcode if asked, and wait for it to load" };
  let r = { ...range };
  if (r.mode === "after") r = chat.last?.newest ? { mode: "after", after: chat.last.newest } : { mode: "last", n: CHAT_LAST_N };
  if (r.mode === "since") r.since = Date.parse(`${r.since}T00:00:00`);
  if (r.mode === "since" && !Number.isFinite(r.since)) return { ok: false, error: "that date could not be read" };
  if (r.mode === "last") r.n = Math.max(1, Math.min(100000, Number(r.n) || CHAT_LAST_N));
  // Start the grab in the page, then check on it each second until it ends (chat-grab.js start/poll).
  const call = async (func, args = []) => {
    const [inj] = await browser.scripting.executeScript({ target: { tabId }, func, args });
    if (inj?.error) throw new Error(inj.error.message || String(inj.error));
    return inj?.result;
  };
  let res;
  const badge = text => browser.action.setBadgeText({ tabId, text }).catch(() => {});
  try {
    const started = await call(range => window.LKChat.start(range), [r]);
    if (!started?.ok) return { ok: false, error: started?.error || "the grab did not start on the page" };
    // A paused grab can wait as long as you like; the limit is on time spent without word from the page.
    for (let quiet = 0; quiet < 120;) {
      await new Promise(ok => setTimeout(ok, 1000));
      const state = await call(() => window.LKChat.poll()).catch(() => null);
      if (!state) { quiet++; continue; }
      quiet = 0;
      if (state.done) { res = state.result; break; }
      badge(String(state.progress?.links ?? ""));
    }
  } catch (e) {
    return { ok: false, error: `the chat could not be read: ${e.message || e}` };
  } finally {
    badge("");
  }
  // Show what happened in the page's panel too: the popup is likely closed by now.
  const tell = (text, ok) => call((t, o) => window.LKChat.finish(t, o), [text, ok]).catch(() => {});
  if (!res) { const error = "the chat page stopped answering: was it closed or reloaded?"; return { ok: false, error }; }
  if (res.cancelled) { await tell("Cancelled: nothing was saved.", false); return { ok: false, cancelled: true, error: "cancelled: nothing was saved" }; }
  if (!res.ok) { await tell(res.error || "the chat could not be read", false); return { ok: false, error: res.error || "the chat could not be read" }; }
  // A link typed into a message may still be t.co's wrapper; follow it to the real address.
  for (const m of res.messages) {
    for (const l of m.links || []) {
      if (/^https?:\/\/t\.co\//.test(l.url)) l.url = (await resolveLinks([{ href: l.url }]))[0]?.resolved || l.url;
    }
  }
  const records = chatRecords(res.messages, chat.thread, chat.platform);
  const counts = await importChatRecords(records);
  // The grab is a group of its own, newest message first, each link dated by its sending.
  const label = chat.thread?.handle || chat.thread?.name || chat.site;
  if (records.length) {
    await addToGroup([...records].sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""))
      .map(r => ({ url: r.url, title: r.text ? `${r.author?.handle ? `${r.author.handle}: ` : ""}${r.text.replace(/\s+/g, " ").slice(0, 200)}` : r.title, saved_at: r.saved_at })),
      { name: `${label} chat · ${dayLabel()}` });
  }
  const times = res.messages.map(m => m.at).filter(Number.isFinite);
  if (chat.key && times.length) {
    const grabs = await read("chatGrabs", {});
    const prev = grabs[chat.key]?.newest || 0;
    grabs[chat.key] = { newest: Math.max(prev, ...times), at: new Date().toISOString(), name: chat.thread?.handle || chat.thread?.name || null };
    await browser.storage.local.set({ chatGrabs: grabs });
  }
  const out = { ok: true, chat: chat.thread?.handle || chat.thread?.name || chat.site, messages: res.messages.length, links: records.length,
    ...counts, stopped: res.stopped, loads: res.loads, unread: res.unread,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null, to: times.length ? new Date(Math.max(...times)).toISOString() : null };
  await tell(describeGrab(out), true);
  return out;
}

/* Why a grab stopped loading older messages, in words: whether what it brought covers the range. */
const STOPPED = {
  range: "That covers the range.",
  "by-you": "Stopped by you; what was loaded is saved.",
  start: "It reached the start of the chat.",
  "no-loader": "Stopped early: the page's loader for older messages was not found; the site may have changed.",
  "nothing-new": "Stopped early: a load of older messages brought nothing within 20 seconds. Grab again to go further.",
  time: "Stopped early after 15 minutes. Grab again to go further.",
  limit: "Stopped early at 2000 loads. Grab again to go further.",
};
const stoppedFailed = s => (/^failed: /.test(s || "") ? `Stopped early: the site refused to load more (${s.slice(8)}). Wait a while before grabbing again.` : "");

/* What a capture kept, in a few words: "text · 3 links · 1 picture · 12 replies · screenshot". */
function keptParts(r) {
  const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null);
  return [r.text ? "text" : "no text", n(r.links?.length, "link", "links"), n(r.images?.length, "picture", "pictures"),
    n(r.replies?.length, "reply", "replies"), r.screenshot ? `screenshot${r.screenshot.truncated ? " (cut short)" : ""}` : null,
    r.screenshot_error ? "screenshot failed" : null].filter(Boolean).join(" · ");
}

/* A capture made on a page (its shortcut or the page's menu) says so on that page: a card in its
 * bottom-right corner for a few seconds. Where the page cannot take one, a notification instead. */
async function confirmCapture(res) {
  const r = res?.record;
  const card = res?.ok
    ? { ok: true, head: "Captured", line: r ? summarise(r) : "", detail: r ? keptParts(r) : "" }
    : { ok: false, head: "Not captured", line: res?.error || "unknown error", detail: "" };
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: showToast, args: [card] });
  } catch (e) {
    await notify(describe(res));
  }
}

/* Runs in the page. Its own closed shadow root, so the page's styles cannot reach it; a click closes it. */
function showToast({ ok, head, line, detail }) {
  document.getElementById("link-keeper-toast")?.remove();
  const host = document.createElement("div");
  host.id = "link-keeper-toast";
  host.dataset.state = ok ? "captured" : "failed";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .card { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; max-width: 340px; padding: 10px 14px;
      font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #e8e8ee; background: #1d1d24; border: 1px solid #34343f;
      border-left: 3px solid ${ok ? "#5ec27a" : "#e0655b"}; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
      cursor: pointer; animation: in .16s ease-out; transition: opacity .25s; }
    @media (prefers-color-scheme: light) { .card { color: #1d1d24; background: #fff; border-color: #ddd; border-left-color: ${ok ? "#3fa35c" : "#d04a40"}; } .detail { color: #666; } }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    b { display: block; font-size: 12px; color: ${ok ? "#5ec27a" : "#e0655b"}; }
    .line { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
    .detail { margin-top: 2px; font-size: 12px; color: #9a9aa8; }
  </style><div class="card" role="status"><b></b><div class="line"></div><div class="detail"></div></div>`;
  const card = root.querySelector(".card");
  root.querySelector("b").textContent = `Link Keeper · ${head}`;
  root.querySelector(".line").textContent = line;
  root.querySelector(".detail").textContent = detail;
  if (!detail) root.querySelector(".detail").remove();
  const close = () => { card.style.opacity = "0"; setTimeout(() => host.remove(), 260); };
  card.addEventListener("click", close);
  setTimeout(close, ok ? 3500 : 6000);
  document.documentElement.append(host);
}

function describeGrab(res) {
  if (!res.ok) return res.error;
  // Your own calendar's days, not UTC's: a grab since midnight here must not read as the day before.
  const span = res.from ? ` (${dayOf(new Date(res.from))} to ${dayOf(new Date(res.to))})` : "";
  const bits = [`${res.links} links in ${res.messages} messages${span}`, `${res.added} new`];
  if (res.updated) bits.push(`${res.updated} already held, now with this chat`);
  if (res.unread) bits.push(`${res.unread} messages had no readable time`);
  return `${res.chat}: ${bits.join(", ")}.${[STOPPED[res.stopped] || stoppedFailed(res.stopped)].filter(Boolean).map(s => ` ${s}`).join("")}`;
}

/* --- messaging ------------------------------------------------------------------ */

/* Every page's requests, and the agents' through the bridge (bridge.js), which may send only some. */
async function handleMessage(msg) {
  switch (msg.type) {
    case "status": {
      const items = await getItems();
      const captures = await getCaptures();
      const current = await getCurrent();
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return {
        total: items.length,
        captures: captures.length,
        current: current && { url: current.url, isOpen: keyOf(tab?.url || "") === current.key },
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
      return { ok: true };
    }

    case "remove": {
      const drop = new Set(msg.urls.map(keyOf));
      const items = await getItems();
      const removed = items.filter(i => drop.has(keyOf(i.url)));
      await setItems(items.filter(i => !drop.has(keyOf(i.url))));
      let gone = [];
      if (msg.alsoCaptures) {
        const captures = await getCaptures();
        gone = captures.filter(c => drop.has(keyOf(c.url)));
        await setCaptures(captures.filter(c => !drop.has(keyOf(c.url))));
      }
      // A move's undo passes trash: false; so does anything that is putting the entry somewhere else.
      const trashed = msg.trash === false ? [] : await addToTrash([
        ...removed.map(i => ({ kind: "item", url: i.url, title: i.title, item: i })),
        ...gone.map(c => ({ kind: "capture", url: c.url, title: c.title, capture: c })),
      ]);
      return { ok: true, removed: drop.size, items: removed, trashed };
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
      await showPage("list.html", (await browser.windows.getLastFocused()).id, "?cards");
      return { ok: true };

    // Explore became the Links page's detail pane.
    case "open-explore":
      await showPage("list.html", (await browser.windows.getLastFocused()).id, "?pane=1");
      return { ok: true };

    case "open-tags":
      await showPage("list.html", (await browser.windows.getLastFocused()).id, "?tags");
      return { ok: true };

    case "page-info":
      return pageInfo(String(msg.url || ""));

    case "filter-rules":
      return { rules: await getFilterRules() };

    case "set-filter-rules":
      return setFilterRules(msg.rules);

    case "filter-out-page":
      return filterOutPage(String(msg.url || ""));

    case "link-counts":
      return linkCounts();

    // Links' "Refresh from exports": tools/refresh.zsh, started and watched by the helper on this Mac.
    case "refresh-start":
      return hostCall("refresh-start", { offline: !!msg.offline }).catch(e => ({ ok: false, error: String(e.message || e) }));
    case "refresh-status":
      return hostCall("refresh-status").catch(e => ({ ok: false, error: String(e.message || e) }));

    case "preview-counts":
      return previewCounts();
    case "preview-backlog":
      return previewBacklog();
    case "preview-stop":
      if (previewRun) previewRun.stop = true;
      return { ok: true };
    case "preview-one": {
      // Settings or a page asks again for one link (its preview made afresh).
      const caps = new Map((await getCaptures()).map(c => [keyOf(c.url), c]));
      const p = await makePreview(msg.url, caps.get(keyOf(msg.url)));
      await savePreview(keyOf(msg.url), p);
      return { ok: !!p, preview: p };
    }

    case "grouping-status": {
      const rec = (await read("dataPatches", {}))[GROUP_PATCH];
      return rec ? { at: rec.at, groups: rec.groups || 0, links: rec.links || 0, undone: rec.undone || null, skipped: rec.skipped || null } : null;
    }

    case "undo-grouping":
      return undoGrouping();

    case "chat-info":
      return msg.tabId ? chatInfo(msg.tabId).catch(() => null) : null;

    case "chat-control":
      return browser.scripting.executeScript({ target: { tabId: msg.tabId }, func: a => window.LKChat.control(a), args: [msg.action] })
        .then(([inj]) => inj?.result || { ok: false, error: "the chat page did not answer" }, e => ({ ok: false, error: String(e.message || e) }));

    case "grab-chat": {
      // A long chat takes minutes and the popup may be closed by then: the result is also a notification.
      const res = await grabChat(msg.tabId, msg.range || { mode: "after" });
      await notify(describeGrab(res));
      return { ...res, summary: describeGrab(res) };
    }

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
      return restoreTabs(msg.id, msg.ids);

    case "put-back":
      return putBack(msg.stash, msg.tabs || []);

    case "restore-items":
      // Undo of "remove": the entries as they were, back in the list. One already there stays as it is.
      return restoreItems(msg.items || []);

    case "trash-list":
      return { ok: true, entries: await getTrash(), days: TRASH_DAYS };

    case "trash-restore":
      return restoreFromTrash(msg.ids || []);

    // Delete forever; also what an undo uses to take a removal's entries back out of the trash.
    case "trash-delete":
      return { ok: true, removed: await deleteFromTrash(msg.all ? (await getTrash()).map(e => e.id) : msg.ids || []) };

    case "rename-stash": {
      const session = await findStash(msg.id);
      if (!session) return { ok: false, error: "that stash is gone" };
      const name = String(msg.name || "").trim().slice(0, 200);
      await browser.bookmarks.update(msg.id, { title: name || stashTitle(session.created_at) });
      return { ok: true };
    }

    case "delete-stash": {
      const taken = await dropFromStash(msg.id, msg.ids, { trash: msg.trash !== false });
      return { ok: true, removed: taken.length, trashed: taken.trashed || [] };
    }

    case "move-stashed":
      return moveStashed(msg.ids || [], msg.to, msg.before || null);

    case "stash-counts":
      return stashCounts(msg);

    case "stash-settings":
      return { settings: await getStashSettings() };

    case "set-stash-settings": {
      const settings = await getStashSettings();
      const patch = {};
      if (["show", "stay"].includes(msg.afterStash)) patch.afterStash = msg.afterStash;
      await browser.storage.local.set({ stashSettings: { ...settings, ...patch } });
      return { ok: true };
    }

    case "toggle-excluded":
      return toggleExcluded(String(msg.host || "").trim().toLowerCase().replace(/^www\./, ""));

    case "import-stashes":
      return importStashes(msg.stashes, msg.format);

    case "links":
      return getLinks();

    case "set-tags":
      return setTags(String(msg.url || ""), msg.tags);

    case "set-tag-suggestions":
      return setTagSuggestions(msg.suggestions, !!msg.replace);

    // Failure records from outside a run (a run on an older version, kept by an agent): { url: { error, kind } },
    // merged; null clears a link's. Recording one never opens or loads anything.
    case "set-capture-fails": {
      const given = msg.fails && typeof msg.fails === "object" ? Object.entries(msg.fails) : [];
      const KINDS = ["wall", "thin", "skipped", "error"];
      await editCaptureFails(f => {
        for (const [url, v] of given) {
          if (v === null) delete f[keyOf(url)];
          else if (v?.error) f[keyOf(url)] = { error: String(v.error).slice(0, 300), kind: KINDS.includes(v.kind) ? v.kind : "error", at: v.at || new Date().toISOString() };
        }
      });
      return { ok: true, count: given.length };
    }

    case "set-agent-tags":
      return setAgentTags(msg.tags, msg.by, !!msg.replace);

    case "tag-stash":
      return tagStash(msg.id, msg.tags);

    case "tag-links":
      return tagLinks(msg.urls, msg.tags);

    case "rename-tag":
      return renameTag(msg.from, msg.to);

    case "delete-tag":
      return deleteTag(msg.tag);

    case "put-tags-back":
      return putTagsBack(msg.before);

    case "create-tag":
      return createTag(msg.name, msg.hue);

    case "recolor-tag":
      return recolorTag(msg.tag, msg.hue);

    case "open-stash-cards":
      await browser.tabs.create({ url: browser.runtime.getURL("list.html") + `?pane=1${msg.id ? `&stash=${encodeURIComponent(msg.id)}` : ""}` });
      return { ok: true };

    case "add":
      // A page's batch (a paste, a refresh's queue) names its own group; anything else joins the day's.
      return addItems(msg.urls, msg.note, msg.group?.name ? { name: String(msg.group.name).slice(0, 200), group_key: msg.group.key ? String(msg.group.key) : undefined } : dayGroup());

    case "queue-active": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return { ok: false, error: "no active tab" };
      // Queued from the browser, so "now" genuinely is when it was saved.
      return addItems([{ url: tab.url.split("#")[0], saved_at: new Date().toISOString() }], msg.note);
    }

    case "capture-active": {
      // The popup's capture button: the popup says what happened, and so does the page, as after the shortcut.
      const res = await captureActive(msg.note, !!msg.withShot);
      confirmCapture(res);
      return res;
    }

    case "capture-url":
      return captureUrl(msg.url, msg.note);

    // The capture queue (capture-queue.js): Links starts it with the ticked links and drives it from its line.
    case "capture-queue-start":
      return captureQueue.start(msg.urls, msg.speed);
    case "capture-queue-speed":
      return captureQueue.setSpeed(msg.speed);
    case "capture-queue-status":
      return { ok: true, ...(await captureQueue.status()) };
    case "capture-queue-pause":
      return captureQueue.pause();
    case "capture-queue-resume":
      return captureQueue.resume();
    case "capture-queue-stop":
      return captureQueue.stop();
    case "capture-queue-retry":
      return captureQueue.retry();
    case "capture-queue-dismiss":
      return captureQueue.dismiss();

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
      const fresh = [];
      for (const rec of msg.records || []) {
        if (!rec?.url) continue;
        const key = keyOf(rec.url);
        const existing = byId.get(key);
        if (!existing) {
          captures.push(rec);
          byId.set(key, rec);
          fresh.push(rec);
          added++;
        } else if ((!existing.text && rec.text)
          // A reel's watch-pack record (caption, transcript, on-screen text, what it points to) holds
          // all a page read of the reel has and more, and grows as the pack does: it replaces both.
          || (rec.via === "watch-reel" && rec.text && rec.text !== existing.text)) {
          Object.assign(existing, rec);
          enriched++;
        } else {
          skipped++;
        }
      }
      await setCaptures(captures);
      // The links new to Link Keeper join the batch's group: the page names it, else the day's.
      if (fresh.length) {
        const held = new Set((await getSessions()).flatMap(s => s.tabs.map(t => keyOf(t.url))));
        const group = msg.group?.name ? { name: String(msg.group.name).slice(0, 200), group_key: msg.group.key ? String(msg.group.key) : undefined } : dayGroup();
        await addToGroup(fresh.filter(r => !held.has(keyOf(r.url)))
          .map(r => ({ url: r.url, title: r.title || (r.text ? r.text.replace(/\s+/g, " ").slice(0, 200) : undefined), saved_at: r.saved_at || undefined })), group);
      }
      await mergeTags(msg.records || []);
      return { ok: true, added, enriched, skipped, total: captures.length };
    }

    case "export-list":
      return { items: await getItems() };

    case "bridge-status":
      return bridgeStatus();

    case "backup-now":
      return backupNow("by hand");

    case "list-backups":
      return hostCall("list-backups").catch(e => ({ ok: false, error: String(e.message || e) }));

    // What a restore would change: counts here now, and in the backup.
    case "compare-backup": {
      const res = await hostCall("read-backup", { name: String(msg.name || "") }).catch(e => ({ ok: false, error: String(e.message || e) }));
      if (!res.ok) return res;
      if (res.data?.format !== "link-keeper-backup" || !res.data.storage) return { ok: false, error: "not a Link Keeper backup" };
      const count = s => ({
        "links in no stash": (s.items || []).length, captures: (s.captures || []).length,
        "tagged links": Object.keys(s.linkTags || {}).length, tags: (s.tagDefs?.list || []).length,
        "in the Trash": (s.trash || []).length, "filter rules": Array.isArray(s.filterRules) ? s.filterRules.length : DEFAULT_FILTER_RULES.length,
      });
      return { ok: true, at: res.data.at, now: count(await browser.storage.local.get(null)), file: count(res.data.storage) };
    }

    case "restore-backup": {
      const res = await hostCall("read-backup", { name: String(msg.name || "") }).catch(e => ({ ok: false, error: String(e.message || e) }));
      return res.ok ? restoreBackup(res.data, "chosen in Settings") : res;
    }

    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
}
browser.runtime.onMessage.addListener(msg => handleMessage(msg));

/* The toolbar icon carries no count; clear one an earlier version left on it. */
browser.action.setBadgeText({ text: "" }).catch(() => {});
