/* What List, Cards and Explore share about showing a link: DOM and text helpers, a link's label and
 * state, and loading the joined dataset (links.js, via the background) filtered to the sources
 * chosen in the top bar (nav.js). */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
};

const shortUrl = url => String(url).replace(/^https?:\/\/(www\.)?/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;
function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* Mirrors reopenRoute in background.js: what reopening this URL will actually do. */
const isWeb = url => /^(https?|ftp):/.test(url);
function kindOf(url) {
  if (isWeb(url) || url.startsWith(browser.runtime.getURL(""))) return "web";
  return /^file:/.test(url) ? "file" : "other";
}

/* A stash is named after its time until renamed; only a real name is worth showing beside the time. */
const stashName = s => s.name || whenOf(s.created_at);
const renamed = s => s.name && s.name !== whenOf(s.created_at);

/* A plain tweet's title is only its handle, so its text is what identifies it. */
const isTextPost = cap => !!(cap?.text && (!cap.title || /^@?\S+ on X$|^X post$/.test(cap.title)));
function labelOf(link) {
  const cap = link.cap;
  if (!cap) return link.title || null;
  const body = (cap.text || "").replace(/\s+/g, " ").trim();
  if (isTextPost(cap)) return (cap.handle ? `${cap.handle}: ` : "") + body;
  if (cap.handle && cap.title && !cap.title.includes(cap.handle)) return `${cap.handle} — ${cap.title}`;
  return cap.title || cap.handle || link.title || null;
}

/* One state per link, shown the same everywhere: a verdict if it has one, else whether it was seen. */
const stateOf = link => (link.verdict === "keep" ? "kept" : link.verdict === "drop" ? "dropped" : link.seen ? "seen" : "left");
const STATE_NAMES = { left: "Not looked at yet", seen: "Seen, undecided", kept: "Kept", dropped: "Dropped" };
const SOURCE_NAMES = { tabs: "Stashed", import: "Imported", list: "Reading list" };

/* The dataset, cut down to the chosen sources: a link shows if any source holding it is chosen, a
 * stash if its own source is. byKey finds a link from a stash tab's key. */
async function loadLinks() {
  const [data, chosen] = await Promise.all([send({ type: "links" }), window.LinkSources.ready]);
  const sources = window.LinkSources.get() || chosen;
  const counts = { tabs: 0, import: 0, list: 0 };
  for (const l of data.links) for (const s of l.sources) counts[s]++;
  window.LinkSources.setCounts(counts);
  const on = new Set(sources);
  const links = data.links.filter(l => l.sources.some(s => on.has(s)));
  const stashes = data.stashes.filter(s => on.has(s.source));
  return { links, stashes, all: data, sources: on, byKey: new Map(data.links.map(l => [l.key, l])) };
}

/* Stashes are bookmarks, so a change can come from Firefox's own library as well as from here; a
 * stash of forty tabs is forty events, taken as one. busy() holds a reload back while it is true —
 * a rename would lose its input to a re-render, and a drag its row. */
function reloadOnChanges(load, busy = () => false) {
  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (busy() ? soon() : load()), 150);
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["stashMeta", "stashSettings", "captures", "items", "current", "thumbs"].some(k => changes[k])) soon();
  });
  for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) browser.bookmarks?.[ev].addListener(soon);
  window.LinkSources.onChange(load);
}

/* A native popover anchored to its trigger: Escape and outside clicks close it, and it lands on the
 * first item when opened from the keyboard. */
let menuSeq = 0;
let usingKeyboard = false;
addEventListener("keydown", () => { usingKeyboard = true; }, true);
addEventListener("pointerdown", () => { usingKeyboard = false; }, true);
function popoverMenu(label, ariaLabel, items, triggerClass = "small ghost more") {
  const id = `menu-${++menuSeq}`;
  const trigger = el("button", { className: triggerClass, textContent: label, title: ariaLabel });
  trigger.setAttribute("aria-label", ariaLabel.length > 90 ? `${ariaLabel.slice(0, 90)}…` : ariaLabel);
  trigger.setAttribute("popovertarget", id);
  const menu = el("div", { id, className: "menu" });
  menu.popover = "auto";
  for (const it of items.filter(Boolean)) {
    if (it === "-") { menu.append(el("hr")); continue; }
    const b = el("button", { textContent: it.text, className: it.className || "", disabled: !!it.disabled, title: it.title || "" });
    b.onclick = async () => { menu.hidePopover(); await it.run(); };
    menu.append(b);
  }
  menu.addEventListener("toggle", e => {
    if (e.newState !== "open") return;
    const r = trigger.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const below = r.bottom + 4 + h <= innerHeight;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    if (usingKeyboard) menu.querySelector("button:not(:disabled)")?.focus();
  });
  return [trigger, menu];
}
// A popover is placed once, when it opens; scrolling would leave it behind, so close it instead.
addEventListener("scroll", () => {
  for (const open of document.querySelectorAll(".menu:popover-open")) open.hidePopover();
}, { passive: true, capture: true });

/* What restoring said, in words. */
function restoredText(r) {
  const parts = [`Reopened ${plural(r.restored, "tab")}`];
  if (r.viaHelper) parts.push(`${r.viaHelper} local through the helper`);
  if (r.standins) parts.push(`${r.standins} as stand-ins`);
  if (r.removed) parts.push("taken out of the stash");
  const fix = /not installed/.test(r.helperError || "") ? "; run native/install.zsh in the link-keeper repo once" : "";
  return parts.join(" · ") + (r.helperError ? ` — local files came back as stand-ins: ${r.helperError}${fix}` : "");
}

/* Reads a web page in a background tab, asking for that site first — from the click, since a
 * permission prompt must come from one. */
async function readLink(url) {
  let origin;
  try { origin = new URL(url).origin + "/*"; } catch (e) { return { ok: false, error: "That URL cannot be opened" }; }
  const granted = await browser.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return { ok: false, error: `Reading it needs access to ${hostOf(url)}` };
  return send({ type: "capture-url", url });
}
