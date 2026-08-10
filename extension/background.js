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

async function addItems(urls, note = "") {
  const items = await getItems();
  const known = new Set(items.map(i => keyOf(i.url)));
  let added = 0;
  for (const url of urls) {
    if (known.has(keyOf(url))) continue;
    known.add(keyOf(url));
    items.push({ url, status: "pending", added_at: new Date().toISOString(), note: note || undefined });
    added++;
  }
  await setItems(items);
  return { ok: true, added, skipped: urls.length - added, total: items.length };
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
async function openNext(direction = 1) {
  const items = await getItems();
  const pending = items.filter(i => i.status === "pending");
  const target = direction > 0 ? pending[0] : [...items].reverse().find(i => i.status !== "pending");
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

/* Full-page PNG beside the text, never inside it — a base64 image in the JSONL would make the
 * log unreadable and ungreppable. captureTab is Firefox-only and, unlike Chrome's
 * captureVisibleTab, accepts a rect larger than the viewport, so the whole article fits in one
 * image without scroll-and-stitch. Height is clamped because very long pages exceed what the
 * compositor will render.
 */
const SHOT_MAX_PX = 20000;

/* Firefox lists captureTab on the tabs namespace but only materialises it once the extension
 * holds host permission — activeTab is enough for scripting.executeScript, which is why text
 * capture works without it, but not for reading pixels. The grant is optional and requested
 * from the popup, since permissions.request needs a real user gesture. */
async function hasSiteAccess() {
  try {
    return await browser.permissions.contains({ origins: ["*://*/*"] });
  } catch (e) {
    return false;
  }
}

// The compositor will not render an image beyond roughly 32k pixels on a side.
const SHOT_MAX_DEVICE_PX = 32000;

async function screenshot(tabId, slug) {
  if (!browser.downloads) throw new Error("no downloads permission — reload the extension");
  if (!browser.tabs.captureTab) {
    throw new Error(await hasSiteAccess()
      ? "captureTab still missing with site access granted — reload the extension"
      : "needs site access: click 'Keep + screenshot' in the popup once to grant it");
  }

  const [dims] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      w: Math.min(document.documentElement.scrollWidth, window.innerWidth),
      h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      dpr: window.devicePixelRatio || 1,
    }),
  });
  const { w, h, dpr = 1 } = dims?.result || {};
  if (!w || !h) return null;

  // Keep the display's pixel ratio for a crisp image, backing off only if that would exceed
  // what the compositor can render.
  const height = Math.min(h, SHOT_MAX_PX);
  const scale = Math.min(dpr, SHOT_MAX_DEVICE_PX / height);

  const dataUrl = await browser.tabs.captureTab(tabId, {
    rect: { x: 0, y: 0, width: w, height },
    scale,
  });

  // A data: URL is not reliably downloadable in Firefox; a blob URL is.
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  const filename = `link-keeper/${slug}.png`;
  try {
    await browser.downloads.download({ url, filename, saveAs: false });
  } finally {
    // Revoking immediately can cancel the download; give it a moment to start.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return { filename, width: Math.round(w * scale), height: Math.round(height * scale), scale, truncated: h > SHOT_MAX_PX };
}

function slugFor(record, tab) {
  if (record.status_id) return `x-${record.status_id}`;
  const host = (() => {
    try { return new URL(record.url || tab.url).hostname.replace(/^www\./, ""); }
    catch (e) { return "page"; }
  })();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${host}-${stamp}`;
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
  record.captured_at = new Date().toISOString();
  if (note) record.note = note;
  record.links = await resolveLinks(record.links);

  if (withShot) {
    try {
      record.screenshot = await screenshot(tab.id, slugFor(record, tab));
    } catch (e) {
      record.screenshot_error = String(e.message || e);
    }
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

function describe(res) {
  if (!res?.ok) return `failed: ${res?.error || "unknown error"}`;
  const r = res.record;
  if (!r) return "done";
  const who = r.author?.handle ? `${r.author.handle} — ` : "";
  const shot = r.screenshot
    ? ` · png saved${r.screenshot.truncated ? " (cut at 20000px)" : ""}`
    : r.screenshot_error ? ` · screenshot failed: ${r.screenshot_error}` : "";
  const links = r.links?.length ? ` · +${r.links.length} link${r.links.length > 1 ? "s" : ""}` : "";
  return `kept ${who}${r.title || r.url}${links}${shot}`;
}

async function queueActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) return addItems([tab.url.split("#")[0]]);
  return { ok: false, error: "no active tab" };
}

browser.commands.onCommand.addListener(async name => {
  if (name === "capture-page") await notify(describe(await captureActive()));
  else if (name === "next-link") {
    const res = await openNext(1);
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
  { id: "menu-shot", title: "Keep this page + screenshot", contexts: ["page", "selection", "image"] },
  { id: "menu-next", title: "Next link in the list", contexts: ["page", "selection", "image"] },
  { id: "menu-queue", title: "Add this page to the list", contexts: ["page", "selection", "image"] },
  { id: "menu-sep", type: "separator", contexts: ["page", "selection", "image"] },
  { id: "menu-list", title: "See the whole list", contexts: ["page", "selection", "image"] },
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
      const res = await openNext(1);
      await notify(res.ok ? `${res.remaining} left in the list` : `failed: ${res.error}`);
      break;
    }
    case "menu-queue": {
      const res = await queueActiveTab();
      await notify(res.added ? "added to the list" : "already on the list");
      break;
    }
    case "menu-list": await browser.tabs.create({ url: browser.runtime.getURL("list.html") }); break;
    case "menu-queue-link":
      if (info.linkUrl) {
        const res = await addItems([info.linkUrl.split("#")[0]]);
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
        recent: captures.slice(-4).reverse().map(r => ({
          title: r.title, handle: r.author?.handle, url: r.url, links: r.links?.length || 0,
        })),
      };
    }

    /* Everything the list page needs, joined here where keyOf lives. */
    case "dump": {
      const items = await getItems();
      const captures = await getCaptures();
      const byKey = new Map(captures.map(c => [keyOf(c.url), c]));
      const current = await getCurrent();
      return {
        items: items.map(i => {
          const cap = byKey.get(keyOf(i.url)) || null;
          return {
            url: i.url,
            status: i.status,
            added_at: i.added_at,
            note: i.note || cap?.note || null,
            current: current?.key === keyOf(i.url),
            cap: cap && {
              title: cap.title,
              handle: cap.author?.handle || null,
              text: cap.text || null,
              kind: cap.kind,
              links: (cap.links || []).map(l => l.resolved || l.href).filter(Boolean),
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
            note: c.note || null,
            current: false,
            cap: {
              title: c.title,
              handle: c.author?.handle || null,
              text: c.text || null,
              kind: c.kind,
              links: (c.links || []).map(l => l.resolved || l.href).filter(Boolean),
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

    case "open-list":
      await browser.tabs.create({ url: browser.runtime.getURL("list.html") });
      return { ok: true };

    case "add":
      return addItems(msg.urls, msg.note);

    case "queue-active": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return { ok: false, error: "no active tab" };
      return addItems([tab.url.split("#")[0]], msg.note);
    }

    case "next":
      return openNext(1);

    case "skip":
      await markCurrent("seen");
      return openNext(1);

    case "capture-active":
      return captureActive(msg.note, !!msg.withShot);

    case "export":
      return { captures: await getCaptures() };

    case "export-list":
      return { items: await getItems() };

    case "clear-captures":
      await setCaptures([]);
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
