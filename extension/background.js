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

async function captureActive(note = "") {
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

async function queueActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) return addItems([tab.url.split("#")[0]]);
  return { ok: false, error: "no active tab" };
}

browser.commands.onCommand.addListener(async name => {
  if (name === "capture-page") await captureActive();
  else if (name === "next-link") await openNext(1);
  else if (name === "queue-page") await queueActiveTab();
});

/* --- right-click menu -----------------------------------------------------------
 * Same actions as the popup, for when reaching for a shortcut is not what you want.
 * "page" context covers a plain right-click; "link" lets you queue a link without
 * visiting it, which is the one thing the keyboard cannot do.
 */

const MENU = [
  { id: "menu-keep", title: "Keep this page", contexts: ["page", "selection", "image"] },
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
    case "menu-keep": await captureActive(); break;
    case "menu-next": await openNext(1); break;
    case "menu-queue": await queueActiveTab(); break;
    case "menu-list": await browser.tabs.create({ url: browser.runtime.getURL("list.html") }); break;
    case "menu-queue-link":
      if (info.linkUrl) await addItems([info.linkUrl.split("#")[0]]);
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
      return captureActive(msg.note);

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
