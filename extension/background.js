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

/* Images stay beside the text, never inside it — a base64 PNG in the JSONL would make the log
 * unreadable and ungreppable, which defeats the point of keeping text at all.
 *
 * Firefox's own Take Screenshot produces a better full-page PNG than an extension can, and
 * MV3 does not expose captureTab at all — the schema lists it but it never materialises, with
 * or without host permission. So screenshots are yours to take and the extension's job is only
 * to notice one and attach it to the right capture.
 *
 * Correlation is by time, in both directions: a screenshot saved shortly before or after a
 * capture belongs to it. Two minutes is generous enough for a slow save and tight enough that
 * unrelated downloads do not get adopted.
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

  // A screenshot you already took, waiting to be claimed.
  const { pendingShot } = await browser.storage.local.get("pendingShot");
  if (pendingShot && Date.now() - pendingShot.at < SHOT_WINDOW_MS) {
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

function describe(res) {
  if (!res?.ok) return `failed: ${res?.error || "unknown error"}`;
  const r = res.record;
  if (!r) return "done";
  const who = r.author?.handle ? `${r.author.handle} — ` : "";
  const shot = r.screenshot ? ` · png ${r.screenshot.filename}` : "";
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
