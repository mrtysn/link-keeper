/* The toolbar popup: the page you are on. Whether it is held already — in which stashes, on the
 * reading list, captured or not — its tags with the palette, and the actions on it: capture it,
 * remove one copy of it, or save it (to the reading list, or by stashing the tab). Below, Stash for
 * the window and links to the viewers. Everything in bulk lives on the pages.
 *
 * Remove acts on one copy only: with several, its menu names each and you pick one.
 */

/* A popup is destroyed the moment it closes, so a note half-typed and the result of the last
 * action would vanish with it. Both are mirrored into storage and restored on open. The message
 * comes back only on the page it was about, and only for a while — after that it is old news about
 * another page. */
const UI_KEY = "popupUi";
const MSG_FOR = 10 * 60 * 1000;
let ui = { note: "", noting: false, msg: "", msgClass: "", url: "", at: 0 };
let uiTimer = null;

function saveUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => browser.storage.local.set({ [UI_KEY]: ui }).catch(() => {}), 250);
}

function say(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
  $("copy-msg").hidden = !text;
  $("undo").hidden = !LinkActions.canUndo();
  Object.assign(ui, { msg: text, msgClass: cls, url: tab?.url || "", at: Date.now() });
  saveUi();
}

$("copy-msg").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("msg").textContent);
    $("copy-msg").textContent = "Copied";
  } catch (e) {
    $("copy-msg").textContent = "Copy failed";
  }
  setTimeout(() => ($("copy-msg").textContent = "Copy"), 1200);
};

$("ver").textContent = `v${browser.runtime.getManifest().version}`;

/* --- the page you are on ------------------------------------------------------------- */

let tab = null;
let info = { link: null, stashes: [] };

// Removing and its undo go through the pages' own actions, over just this link's stashes.
LinkActions.setup({
  data: () => ({ stashes: info.stashes, all: { stashes: info.stashes } }),
  say: text => say(text, "ok"),
  after: () => load(),
});

async function load() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const { tagDefs } = await browser.storage.local.get("tagDefs");
  setTagLibrary(tagDefs);
  info = isWeb(tab?.url || "") ? await send({ type: "page-info", url: tab.url }) : { link: null, stashes: [] };
  render();
}

/* A stash as a short label: its name, or its day, with how many tabs it holds — "Oct 6 · 82 tabs". */
const dayShort = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const stashLabel = s => `${renamed(s) ? s.name : dayShort(s.created_at)} · ${plural(s.tabs.length, "tab")}`;

/* Where it is held: each stash, and the reading list. */
function copies() {
  const link = info.link;
  if (!link) return [];
  const out = link.copies.map(c => {
    const stash = info.stashes.find(s => s.id === c.stash);
    const i = stash ? stash.tabs.findIndex(x => x.id === c.tab) : -1;
    return i === -1 ? null : {
      label: stashLabel(stash), title: `${stashName(stash)}: tab ${i + 1} of ${stash.tabs.length}`,
      menu: `${stashLabel(stash)}, tab ${i + 1}`, name: stashName(stash),
      locked: stash.locked, target: { link, stash, tab: stash.tabs[i] },
    };
  }).filter(Boolean);
  if (link.list && !link.list.loose) out.push({ label: "Reading list", title: "On the reading list", menu: "Reading list", name: "the reading list", list: true, target: { link } });
  return out;
}

// A page held in many places shows the first few; "+N more" shows the rest.
const PLACES_SHOWN = 4;
let showAllPlaces = false;

/* The palette offers the most used tags first, so 1–9 reach the ones you use. */
const byUse = () => {
  const use = info.tagUse || {};
  return [...new Set([...tagPool(), ...Object.keys(use)])].map((t, i) => [t, i]).sort((a, b) => (use[b[0]] || 0) - (use[a[0]] || 0) || a[1] - b[1]).map(([t]) => t);
};

function render() {
  const web = isWeb(tab?.url || "");
  const link = info.link;
  $("page-icon").replaceWith(Object.assign(srcIcon(tab?.url || "about:blank"), { id: "page-icon" }));
  $("page-title").textContent = (link && labelOf(link)) || tab?.title || "This tab";
  $("page-host").textContent = web ? hostOf(tab.url) : "a browser page";

  // Two lines: where it is held, and whether its text is captured.
  const where = $("where"), cap = $("captured");
  where.textContent = "";
  cap.textContent = "";
  const held = copies();
  cap.hidden = !web;
  if (!web) where.append("Browser pages cannot be saved; Stash still takes the tabs around it.");
  else {
    // Each line: its label, then its values wrapping beside it rather than under it.
    const vals = el("span", { className: "vals" });
    if (!held.length) vals.append(el("span", { className: "none", textContent: link ? "on no list or stash" : "not saved yet" }));
    // One chip per place, with how many copies it holds; past a few places, the rest on request.
    const places = new Map();
    for (const c of held) {
      const key = c.list ? "list" : c.target.stash.id;
      const p = places.get(key) || places.set(key, { label: c.label, titles: [], n: 0 }).get(key);
      p.n++;
      p.titles.push(c.title);
    }
    const all = [...places.values()];
    const shown = showAllPlaces ? all : all.slice(0, PLACES_SHOWN);
    for (const p of shown) vals.append(el("span", { className: "place", textContent: p.n > 1 ? `${p.label} ×${p.n}` : p.label, title: p.titles.join("\n") }));
    if (shown.length < all.length) {
      const more = el("button", { type: "button", className: "place more-places", textContent: `+${all.length - shown.length} more`,
        title: `${held.length} copies in ${all.length} places` });
      more.onclick = () => { showAllPlaces = true; render(); };
      vals.append(more);
    }
    where.append(el("span", { className: "lbl", textContent: "Held" }), vals);
    const at = link && readAt(link);
    cap.append(el("span", { className: "lbl", textContent: "Captured" }), el("span", { className: "vals" },
      at ? el("span", { className: "val", textContent: dayOf(at), title: whenOf(at) }) : el("span", { className: "none", textContent: link?.cap ? "yes" : "not yet" })));
  }

  // Tags: only a link that is held has a place to show them.
  const box = $("tagbox");
  box.textContent = "";
  if (link) {
    const editor = tagEditor(link, () => {}, { order: byUse, limit: 9 });
    box.append(editor);
    if (!document.activeElement || document.activeElement === document.body) editor.querySelector("input").focus();
  }

  $("capture-split").hidden = !web;
  $("keep").firstChild.textContent = link?.cap ? "Capture again " : "Capture ";
  // The likely next step is filled: save a page you do not hold, capture one you hold without its text.
  $("queue").classList.toggle("primary", web && !link);
  $("keep").classList.toggle("primary", web && !!link && !link.cap);
  $("queue").hidden = !web || !!link?.list;
  $("stash-tab").hidden = !web || link?.copies.length > 0;
  const remove = $("remove");
  remove.hidden = !held.length;
  const removable = held.filter(c => !c.locked);
  remove.disabled = !removable.length;
  remove.textContent = held.length > 1 ? "Remove ▾" : "Remove";
  remove.title = !removable.length ? "Its stash is locked"
    : held.length > 1 ? "Take it out of one place; pick which" : `Take it out of ${held[0]?.name}`;
  $("undo").hidden = !LinkActions.canUndo();
}

/* Remove: one copy. With one place it goes at once; with several, the menu names each. */
$("remove").onclick = () => {
  const held = copies();
  if (held.length === 1) return removeCopy(held[0]);
  // One item per place; a place holding several copies loses one, the first, per pick.
  const menu = $("remove-menu");
  menu.textContent = "";
  const places = new Map();
  for (const c of held) {
    const key = c.list ? "list" : c.target.stash.id;
    (places.get(key) || places.set(key, []).get(key)).push(c);
  }
  for (const group of places.values()) {
    const c = group[0];
    const label = group.length > 1 ? `From ${c.label} (1 of ${group.length} copies)` : `From ${c.menu}`;
    const b = el("button", { type: "button", className: "danger", textContent: label, disabled: !!c.locked,
      title: c.locked ? "That stash is locked" : c.title });
    b.onclick = () => { menu.hidePopover(); removeCopy(c); };
    menu.append(b);
  }
  menu.showPopover();
};
const removeCopy = c => LinkActions.run("remove", c.target, c.list ? { fromList: true } : {});
$("undo").onclick = () => LinkActions.undo();

/* --- capture ------------------------------------------------------------------------- */

async function capture(withShot = false) {
  say(withShot ? "capturing the page, then the screenshot…" : "capturing the page…");
  const res = await send({ type: "capture-active", note: $("note").value.trim(), withShot });
  if (res?.ok) {
    const r = res.record;
    const inner = r.links?.length ? ` (+${r.links.length} link${r.links.length > 1 ? "s" : ""})` : "";
    // The page's title is above; the message says what happened, and why a screenshot failed.
    const head = `captured${inner}`;
    if (r.screenshot) {
      const s = r.screenshot;
      say(`${head}\npng ${s.width}×${s.height}${s.tiles ? ` from ${s.tiles} tiles` : ""} → ${s.filename}`, "ok");
    } else if (r.screenshot_error) {
      say(`${head}\nscreenshot failed: ${r.screenshot_error}`, "bad");
    } else {
      say(head, "ok");
    }
    showNote(false);
  } else {
    say(res?.error || "could not capture that page", "bad");
  }
  load();
}
$("keep").onclick = () => capture(false);

/* permissions.request needs a real user gesture, so the grant happens here rather than in the
 * background where the capture runs. Already-granted returns true immediately. */
$("keep-shot").onclick = async () => {
  $("keep-menu").hidePopover();
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: ["*://*/*"] });
  } catch (e) {
    return say(`could not request permission: ${e.message}`, "bad");
  }
  if (!granted) return say("the screenshot needs site access; you declined", "bad");
  capture(true);
};

/* The note field shows only when asked for; it goes with the next capture, and Enter captures. */
function showNote(on) {
  $("note-row").hidden = !on;
  if (!on) $("note").value = "";
  Object.assign(ui, { noting: on, note: on ? $("note").value : "" });
  saveUi();
  if (on) $("note").focus();
}
$("keep-note").onclick = () => { $("keep-menu").hidePopover(); showNote(true); };
$("note").addEventListener("input", () => { ui.note = $("note").value; saveUi(); });
$("note").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); capture(false); }
  if (e.key === "Escape") { e.preventDefault(); showNote(false); }
});

/* --- saving it ----------------------------------------------------------------------- */

$("queue").onclick = async () => {
  const res = await send({ type: "queue-active", note: $("note").value.trim() });
  say(res.ok ? (res.added ? "added to the reading list" : "already on the reading list") : (res.error || "could not add"), res.added ? "ok" : "");
  load();
};

/* The stash shows its stashes as the tabs close, so the popup has nothing left to show. */
async function stash(scope) {
  const res = await send({ type: "stash", scope });
  if (res.ok) window.close();
  else say(res.error, "bad");
}
$("stash-tab").onclick = () => stash("tab");
$("stash").onclick = () => stash("auto");
for (const b of document.querySelectorAll("#stash-menu [data-scope]")) {
  b.onclick = () => { $("stash-menu").hidePopover(); stash(b.dataset.scope); };
}

/* Menus open beside their arrow, flipped up if they would run off the popup. */
for (const [menu, anchor] of [["stash-menu", "stash-more"], ["keep-menu", "keep-more"], ["remove-menu", "remove"]]) {
  $(menu).addEventListener("toggle", e => {
    if (e.newState !== "open") return;
    const r = $(anchor).getBoundingClientRect(), m = $(menu);
    const below = r.bottom + 4 + m.offsetHeight <= innerHeight;
    m.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - 4 - m.offsetHeight)}px`;
    m.style.left = `${Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4))}px`;
  });
}

/* --- the viewers --------------------------------------------------------------------- */

for (const b of document.querySelectorAll(".viewers [data-open]")) {
  b.onclick = async () => {
    await send({ type: b.dataset.open });
    window.close();
  };
}

/* Restore what the last popup session had in flight: the note, and the message if it is about
 * this page and recent. */
async function restoreUi() {
  const got = await browser.storage.local.get(UI_KEY).catch(() => ({}));
  ui = { ...ui, ...(got[UI_KEY] || {}) };
  if (ui.noting) {
    $("note-row").hidden = false;
    $("note").value = ui.note || "";
  }
  if (ui.msg && ui.url === (tab?.url || "") && Date.now() - (ui.at || 0) < MSG_FOR) {
    $("msg").textContent = ui.msg;
    $("msg").className = ui.msgClass || "";
    $("copy-msg").hidden = false;
  }
}

load().then(restoreUi);
