/* Links: every link from the sources chosen in the top bar — stashed tabs, imports, the reading
 * list — one row per URL, grouped by stash, domain, tag, day or month, or in date order.
 *
 * Three view toggles, each remembered: Detail (V) narrows the rows to a sidebar and shows the
 * selected link in full beside them — its capture, where else it is held, other links from its
 * site, and the live preview (P); Compact shows a row as its icon and title only, the default with
 * the pane; Stash tools shows or hides the buttons on stash headings. ?pane=1 opens with the pane,
 * ?stash=<id> shows only that stash.
 *
 * Grouped by stash it is what the Stashed tabs page was: each stash under its own heading with its
 * actions, rows that drag between and within stashes, and the reading list's links after them. A
 * URL held in two stashes shows in both there, since a stash is a container; in every other
 * grouping it shows once, with badges saying where it is held.
 *
 * A row is tagged, captured, removed (that copy only) or skipped. A stash is the only
 * record of the tabs it closed, so Delete and Remove are the only ways to lose one; a lock
 * prevents both, and Delete asks first.
 */

const GROUPS = ["stash", "domain", "tag", "day", "month", "newest", "oldest"];
const GROUP_KEY = "listGroup";
// All is the pile; captured, uncaptured and local split it with nothing left over. Filtered out is
// apart from the pile.
const FILTERS = ["all", "captured", "uncaptured", "local", "filtered"];

let data = { links: [], stashes: [], all: { links: [], stashes: [] }, sources: new Set(), byKey: new Map() };
let settings = { afterStash: "show", afterRestore: "keep", exclude: [] };
let filter = "all";
const domainSel = new Set();   // empty = every domain
const tagSel = new Set();      // empty = every tag; UNTAGGED = links with no tag set by hand
const UNTAGGED = "\u0000untagged";
let domainsExpanded = false;
let renaming = null;
let dragging = null;

/* The view toggles, each remembered in this browser; storage that throws leaves the defaults. */
const PANE_KEY = "listPane", COMPACT_KEY = "listCompact", COMPACT_PANE_KEY = "listCompactPane", TOOLS_KEY = "listTools";
const pref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch (e) { return fallback; }
};
const setPref = (key, on) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch (e) { /* not remembered */ } };
let pane = pref(PANE_KEY, false);
let stashOnly = null;   // ?stash=<id> (or "list"): only that stash, until its banner is closed

let group = "domain";
try { group = localStorage.getItem(GROUP_KEY) || "domain"; } catch (e) { /* storage blocked: default */ }
{
  // ?group=stash is how stashing lands here; ?pane=1 and ?stash=<id> are how Explore's old
  // address and a stash's "Open this stash" do.
  const params = new URLSearchParams(location.search);
  const asked = params.get("group");
  if (asked) {
    group = asked;
    try { localStorage.setItem(GROUP_KEY, asked); } catch (e) { /* not remembered */ }
  }
  if (params.get("pane") === "1") { pane = true; setPref(PANE_KEY, true); }
  if (params.get("stash")) { stashOnly = params.get("stash"); group = "stash"; }
  if ([...params.keys()].length) history.replaceState(null, "", location.pathname + location.hash);
  if (group === "flat") group = "newest";
  if (!GROUPS.includes(group)) group = "domain";
}

const compactNow = () => (pane ? pref(COMPACT_PANE_KEY, true) : pref(COMPACT_KEY, false));
function applyView() {
  document.body.classList.toggle("pane", pane);
  document.body.classList.toggle("compact", compactNow());
  document.body.classList.toggle("no-tools", !pref(TOOLS_KEY, true));
  $("t-pane").setAttribute("aria-pressed", String(pane));
  $("t-compact").setAttribute("aria-pressed", String(compactNow()));
  $("t-tools").setAttribute("aria-pressed", String(pref(TOOLS_KEY, true)));
  $("detail").hidden = !pane;
}
function togglePane(on = !pane) {
  pane = on;
  setPref(PANE_KEY, on);
  applyView();
  render();
}

function say(text) { $("msg").textContent = text; }

async function load() {
  const [d, { settings: st }, stored] = await Promise.all([loadLinks({ keepFiltered: true }), send({ type: "stash-settings" }), browser.storage.local.get(PREVIEW_KEY)]);
  // The pile, and apart from it the filtered-out links, which only the Filtered out filter shows.
  d.filteredLinks = d.links.filter(l => l.tags.includes(FILTER_TAG));
  d.links = d.links.filter(l => !l.tags.includes(FILTER_TAG));
  data = d;
  settings = st;
  previewMode = stored[PREVIEW_KEY] ? "keep" : previewMode === "keep" ? "off" : previewMode;
  render();
}

async function act(msg, done) {
  const res = await send(msg);
  if (res && res.ok === false) say(res.error || "That did not work");
  else if (done) say(done(res));
  await load();
  return res;
}

const stashById = id => data.all.stashes.find(s => s.id === id);
const visibleStash = id => data.stashes.some(s => s.id === id);

/* --- filtering ------------------------------------------------------------------ */

/* A web page's site; local files and browser pages have none, so they group under a name. */
const siteOf = url => ({ web: () => hostOf(url), file: () => "Local files", other: () => "Browser pages" })[kindOf(url)]();

function matches(link, term) {
  if (stashOnly === "list" ? !link.list : stashOnly && !link.copies.some(c => c.stash === stashOnly)) return false;
  if (filter === "captured" && !(isWeb(link.url) && link.cap)) return false;
  if (filter === "uncaptured" && !(isWeb(link.url) && !link.cap)) return false;
  if (filter === "local" && isWeb(link.url)) return false;
  if (domainSel.size && !domainSel.has(siteOf(link.url))) return false;
  if (tagSel.size && ![...tagSel].some(t => (t === UNTAGGED ? !link.tags.length : shownTags(link).tags.includes(t)))) return false;
  if (!term) return true;
  const cap = link.cap;
  const hay = [link.url, link.title, labelOf(link), cap?.text, link.list?.note, cap?.screenshot, link.date, ...shownTags(link).tags,
    ...(cap?.links || []), ...(cap?.reply_links || []).map(l => l.href)].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(term);
}

/* --- rows ----------------------------------------------------------------------- */

const byNewest = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));

function titleLink(link, ctx) {
  const cap = link.cap;
  const web = isWeb(link.url);
  const a = el("a", { className: "ttl", href: link.url, draggable: false });
  if (web) Object.assign(a, { target: "_blank", rel: "noopener noreferrer" });
  const label = labelOf(link);
  if (isTextPost(cap)) {
    const body = cap.text.replace(/\s+/g, " ").trim();
    if (cap.handle) a.append(el("span", { className: "who", textContent: cap.handle }), " ");
    a.append(body);
    a.title = body;
  } else if (label) {
    a.classList.add("titled");
    a.textContent = label;
    a.title = `${label}\n${link.url}`;
  } else {
    a.classList.add("plain");
    a.textContent = shortUrl(link.url);
    a.title = link.url;
  }
  /* A click is Open, as 4 is: a stashed tab reopens through the background, which keeps its
   * container and marks it restored; a reading-list link opens in a new tab and becomes the current
   * entry, so a capture of that tab attaches to it. Middle-click and copy-link behave as on any link. */
  a.addEventListener("click", e => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // With the detail pane, a click selects the row (its pointerdown already did); 4 opens it.
    if (pane) return;
    LinkActions.run("open", { link, ...ctx });
  });
  return a;
}

function linkChip(href, text, title, className = "") {
  return el("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: text, title, className });
}

/* Where else a link is held, as badges — only worth showing when more than one source is on show. */
function whereBadges(link, ctx) {
  const out = [];
  const mixed = data.sources.size > 1;
  if (ctx) {
    if (link.list && mixed) out.push(Peek.mark(el("span", { className: "badge", textContent: "Reading list" }), "source", `list|${link.key}`));
    const also = link.copies.filter(c => c.stash !== ctx.stash.id).map(c => stashById(c.stash)).filter(Boolean);
    if (also.length) {
      out.push(el("span", { className: "badge dup", textContent: `Also in ${also.length === 1 ? "1 other stash" : `${also.length} other stashes`}`,
        title: also.map(stashName).join("\n") }));
      Peek.mark(out.at(-1), "held", link.key);
    }
    return out;
  }
  if (!mixed && link.copies.length < 2) return out;
  if (link.list && mixed) out.push(Peek.mark(el("span", { className: "badge", textContent: "Reading list" }), "source", `list|${link.key}`));
  for (const source of ["tabs", "import"]) {
    const held = link.copies.map(c => stashById(c.stash)).filter(s => s?.source === source);
    if (!held.length) continue;
    out.push(el("span", { className: "badge", textContent: `${SOURCE_NAMES[source]}${held.length > 1 ? ` ×${held.length}` : ""}`,
      title: held.map(stashName).join("\n") }));
    Peek.mark(out.at(-1), "source", `${source}|${link.key}`);
  }
  return out;
}

/* --- keys ------------------------------------------------------------------------
 * A cursor marks the row the keys act on: W S walk it, A D jump to the previous or next section, a
 * click on a row puts it there. It is held by the row's identity, so a reload keeps it in place. */

let rowsOnPage = [];   // [{ li, target, id }] in page order, rebuilt by each render
let cursorId = null;

function cursorRow(li, target) {
  // A link shows once per stash, but in some groupings once per tag: the nth showing is its own row.
  const base = `${target.stash?.id || ""} ${target.link.key}`;
  const id = `${base} #${rowsOnPage.filter(r => r.base === base).length}`;
  rowsOnPage.push({ li, target, id, base });
  if (id === cursorId) li.classList.add("lk-cursor");
  li.addEventListener("pointerdown", () => setCursor(id, false));
}

function setCursor(id, scroll = true) {
  cursorId = id;
  for (const r of rowsOnPage) r.li.classList.toggle("lk-cursor", r.id === id);
  if (scroll) rowsOnPage.find(r => r.id === id)?.li.scrollIntoView({ block: "nearest" });
  markHeads();
  if (pane) renderDetail();
}

/* A stash's name previews the stash on hover, opened on the cursor's link when it is one of its tabs. */
function markHeads() {
  const at = rowsOnPage.find(r => r.id === cursorId)?.target;
  for (const name of document.querySelectorAll(".group > h2 .name[data-stash]")) {
    const id = name.dataset.stash;
    Peek.mark(name, "stash", at?.stash?.id === id ? `${id}|${at.link.key}` : id);
  }
}
const cursorAt = () => rowsOnPage.findIndex(r => r.id === cursorId);

function walk(by) {
  if (!rowsOnPage.length) return;
  const i = cursorAt();
  const to = i === -1 ? (by > 0 ? 0 : rowsOnPage.length - 1) : Math.max(0, Math.min(rowsOnPage.length - 1, i + by));
  setCursor(rowsOnPage[to].id);
}

function jumpSection(by) {
  const sections = [...document.querySelectorAll("#out section.group")].filter(sec => rowsOnPage.some(r => sec.contains(r.li)));
  if (!sections.length) return;
  const i = cursorAt();
  const here = i === -1 ? (by > 0 ? -1 : sections.length) : sections.indexOf(rowsOnPage[i].li.closest("section.group"));
  const to = sections[Math.max(0, Math.min(sections.length - 1, here + by))];
  const first = rowsOnPage.find(r => to.contains(r.li));
  if (first) setCursor(first.id);
}

/* A key acts on the cursor's row; with no cursor yet, the first press only places it. */
function onRow(cmd) {
  return () => {
    const i = cursorAt();
    if (i === -1) return walk(1);
    const { li, target } = rowsOnPage[i];
    const inPane = pane && document.querySelector(`#detail .lk-bar [data-cmd="${cmd === "open-other" ? "open" : cmd}"]`);
    const anchor = inPane || (cmd === "tags" && li.querySelector(".tagedit")) || li.querySelector(".lk-bar .more") || li;
    LinkActions.key(cmd, target, anchor);
  };
}

/* After an action: anything that takes the row away (or a capture under Not captured) moves the
 * cursor on; then the page reloads with the cursor where it now is. */
LinkActions.setup({
  data: () => data,
  say,
  tags: (t, anchor) => (pane ? $("detail").querySelector(".tagger input")?.focus() : anchoredPopover(anchor, tagEditor(t.link, () => load()))),
  tagNext: () => { walk(1); onRow("tags")(); },
  async after(cmd, target, res) {
    if (res.ok === false) return;
    const leaves = ["list", "move", "remove"].includes(cmd) || (cmd === "open" && /taken out/.test(res.say || ""));
    const i = cursorAt();
    if (i !== -1 && rowsOnPage[i].target.link.key === target?.link.key && (leaves || (cmd === "read" && filter === "uncaptured"))) {
      const next = rowsOnPage[i + 1] || rowsOnPage[i - 1];
      if (next) cursorId = next.id;
    }
    if (res.local) render();
    else await load();
    setCursor(cursorId);
  },
});

LinkKeys.listen({
  prev: () => walk(-1), next: () => walk(1),
  "group-prev": () => jumpSection(-1), "group-next": () => jumpSection(1),
  read: onRow("read"), open: onRow("open"), "open-other": onRow("open-other"),
  tags: onRow("tags"), list: onRow("list"), move: onRow("move"), remove: onRow("remove"),
  undo: () => LinkActions.undo(), filter: () => $("q").focus(),
  detail: () => togglePane(), preview: () => { if (!pane) togglePane(true); setPreview(previewShowing(detailLink()) ? "off" : "this"); },
  escape: () => { document.querySelector(".tagpop")?.remove(); },
}, { labels: { "group-prev": "◂ section", "group-next": "section ▸" } });
$("keys").append(...LinkKeys.hint(["prev", "next", "group-next", "tags", "read", "remove", "open", "detail"]));

// Space and ⇧Space scroll a long detail pane.
addEventListener("keydown", e => {
  if (!pane || e.key !== " " || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
  e.preventDefault();
  $("detail").scrollBy({ top: (e.shiftKey ? -1 : 1) * $("detail").clientHeight * 0.8, behavior: "smooth" });
});

/* What only this page adds to a row's ⋯ menu: opening a reading-list link in this tab, and moving a
 * stashed one up or down its stash. Everything else is the shared bar's. */
function rowExtras(link, ctx) {
  const items = [];
  if (link.list && isWeb(link.url)) {
    items.push({ text: "Open in this tab", run: () => send({ type: "set-current", url: link.url }).then(() => browser.tabs.update({ url: link.url })) });
  }
  if (ctx) {
    const { stash, index } = ctx;
    items.push(
      { text: "Move up", disabled: stash.locked || index === 0, run: () => moveTab(ctx.tab.id, stash.id, stash.tabs[index - 1]?.id) },
      { text: "Move down", disabled: stash.locked || index === stash.tabs.length - 1, run: () => moveTab(ctx.tab.id, stash.id, stash.tabs[index + 2]?.id || null) });
  }
  return items;
}

function rowEl(link, ctx) {
  const li = el("li");
  if (link.list?.current) li.classList.add("current");

  li.append(srcIcon(link.url));
  // The page icon when its text is captured; the column stays when it is not.
  const mark = readMark(link);
  mark.classList.add("mark");
  li.append(mark);

  const main = el("div", { className: "main" });
  const ttl = titleLink(link, ctx);
  // Compact, a row is only its title: hovering it previews the rest.
  if (compactNow()) Peek.mark(ttl, "link", link.key);
  main.append(ttl);
  const cap = link.cap;

  // A titled page carries a description worth a second line, unless the title already is that text.
  const squash = s => String(s || "").replace(/\s+/g, " ").trim();
  const text = squash(cap?.text);
  if (text && !isTextPost(cap) && !squash(labelOf(link)).includes(text.slice(0, 60))) {
    main.append(el("div", { className: "body", textContent: cap.text }));
  }

  const kind = kindOf(link.url);
  const meta = el("div", { className: "meta" });
  if (kind === "web" && group !== "domain") meta.append(el("span", { textContent: hostOf(link.url) }));
  if (kind === "file") {
    meta.append(el("span", { className: "badge", textContent: "Local file",
      title: "Reopened through Link Keeper's helper, or as a stand-in if the helper is not installed" }));
  }
  if (kind === "other") {
    meta.append(el("span", { className: "badge", textContent: "Stand-in",
      title: "Firefox will not let an extension open this page; reopening opens a tab with the URL to paste" }));
  }
  if (!ctx && link.date) {
    const t = el("time", { dateTime: link.date, textContent: link.date.slice(0, 10) });
    t.title = link.list?.saved_at ? "Saved on this date" : link.list ? "Added to the list on this date; the original date is unknown" : "Stashed on this date";
    meta.append(t);
  }
  if (cap?.kind && cap.kind !== "page") meta.append(el("span", { textContent: cap.kind }));
  const read = readBadge(link);
  if (read) meta.append(read);
  if (link.list?.current) meta.append(el("span", { className: "badge current", textContent: "Current" }));
  meta.append(...whereBadges(link, ctx));
  const container = ctx ? ctx.tab.container : link.copies.find(c => c.container)?.container;
  if (container) meta.append(el("span", { className: "badge", textContent: "Container", title: container }));
  if (ctx?.tab.seen_at) meta.append(el("time", { dateTime: ctx.tab.seen_at, textContent: `restored ${whenOf(ctx.tab.seen_at)}` }));
  if (link.list?.note) meta.append(el("span", { className: "note", textContent: link.list.note }));
  const chips = tagChips(link);
  if (chips) meta.append(chips);
  meta.append(tagButton(link, () => render()));
  main.append(meta);

  if (cap?.links?.length) {
    main.append(el("div", { className: "inner" }, ...cap.links.slice(0, 5).map(url => linkChip(url, shortUrl(url), url))));
  }
  // Links harvested from the replies — the author's own reply is the one that usually matters.
  if (cap?.reply_links?.length) {
    main.append(el("div", { className: "inner replies" }, ...cap.reply_links.slice(0, 6).map(l => linkChip(l.href, `↩ ${shortUrl(l.href)}`,
      l.self ? `From the author's own reply (${l.from || "?"})` : `From a reply by ${l.from || "?"}`, l.self ? "from-author" : ""))));
  }
  // Actual thumbnails, not URLs — the point of keeping image links is to see them.
  if (cap?.images?.length) {
    const shots = el("div", { className: "shots" });
    for (const src of cap.images.slice(0, 8)) {
      const img = el("img", { src, loading: "lazy", alt: "" });
      const a = el("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, img);
      // A dead image would otherwise collapse to a hairline beside the text.
      img.addEventListener("error", () => { a.remove(); if (!shots.querySelector("img")) shots.remove(); });
      shots.append(a);
    }
    if (cap.images.length > 8) shots.append(el("span", { className: "png", textContent: `+${cap.images.length - 8} more` }));
    main.append(shots);
  }
  if (cap?.screenshot && !cap.shotThumb) {
    // No preview stored — Firefox's own screenshot, or one taken before previews existed.
    main.append(el("div", { className: "shots" }, el("span", { className: "png", textContent: `📄 ${cap.screenshot}` })));
  }
  if (cap?.shotThumb) {
    const img = el("img", { src: cap.shotThumb, className: "shot-preview", loading: "lazy", alt: "" });
    // The PNG itself lives in Downloads, which this page cannot load; the downloads API opens it.
    const btn = el("button", { className: "shot-btn", title: `Open ${cap.screenshot}` }, img);
    btn.setAttribute("aria-label", `Open screenshot ${cap.screenshot}`);
    btn.onclick = async () => {
      const res = await send({ type: "open-shot", id: cap.shotId, filename: cap.screenshot });
      if (!res?.ok) say(res?.error || "Unable to open the screenshot");
    };
    main.append(el("div", { className: "shots" }, btn));
  }
  li.append(main);

  // The same actions as every page, compact: Open, Keep, Drop, the rest under ⋯.
  const target = { link, ...ctx };
  li.append(LinkActions.bar(target, { compact: true, extra: rowExtras(link, ctx) }));
  cursorRow(li, target);

  if (ctx) dragRow(li, link, ctx);
  return li;
}

/* One malformed row must not blank the page; it falls back to the bare URL. */
function safeRow(link, ctx) {
  try {
    return rowEl(link, ctx);
  } catch (e) {
    console.error("row failed", link.url, e);
    return el("li", {}, el("span"), el("span"), el("div", { className: "main", textContent: `Could not show ${shortUrl(link.url)}: ${e.message}` }));
  }
}

/* --- drag and drop -----------------------------------------------------------------
 * Grouped by stash, a row dropped on the top half of another goes ahead of it, on the bottom half
 * after it; dropped on a stash's heading or the empty end of its list, it goes last. Out of a
 * locked stash, nothing drags. */

function moveTab(id, to, before) {
  return act({ type: "move-stashed", ids: [id], to, before });
}

function clearDropMarks() {
  for (const n of document.querySelectorAll(".drop-before, .drop-after, .drop-end")) n.classList.remove("drop-before", "drop-after", "drop-end");
}

function dropTarget(node, stash, spotOf) {
  node.addEventListener("dragover", e => {
    if (!dragging) return;
    const spot = spotOf(e);
    if (spot === undefined) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    node.classList.add(spot.mark);
  });
  node.addEventListener("dragleave", e => { if (!node.contains(e.relatedTarget)) node.classList.remove("drop-before", "drop-after", "drop-end"); });
  node.addEventListener("drop", e => {
    if (!dragging) return;
    const spot = spotOf(e);
    if (spot === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragging.id;
    dragging = null;
    clearDropMarks();
    if (spot.before !== id) moveTab(id, stash.id, spot.before);
  });
}

function dragRow(li, link, { stash, tab, index }) {
  if (!stash.locked) {
    li.draggable = true;
    li.addEventListener("dragstart", e => {
      dragging = { id: tab.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/uri-list", link.url);
      e.dataTransfer.setData("text/plain", link.url);
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => { dragging = null; li.classList.remove("dragging"); clearDropMarks(); });
  }
  dropTarget(li, stash, e => {
    const r = li.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2
      ? { before: stash.tabs[index + 1]?.id || null, mark: "drop-after" }
      : { before: tab.id, mark: "drop-before" };
  });
}

/* --- stash headings ------------------------------------------------------------------ */

function stashHeading(stash, shown) {
  const h2 = el("h2");
  if (stash.starred) h2.append(el("span", { className: "star-mark", textContent: "★", title: "Starred" }));
  if (stash.locked) h2.append(el("span", { className: "lock-mark", textContent: "Locked" }));
  if (renaming === stash.id) {
    const input = el("input", { className: "rename", value: renamed(stash) ? stash.name : "", placeholder: whenOf(stash.created_at) });
    input.setAttribute("aria-label", "Stash name");
    const finish = async save => {
      if (renaming !== stash.id) return;
      renaming = null;
      if (save) await act({ type: "rename-stash", id: stash.id, name: input.value });
      else render();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    h2.append(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  } else {
    const name = el("span", { className: "name", textContent: stash.name });
    name.dataset.stash = stash.id;
    h2.append(name);
    if (renamed(stash)) h2.append(el("span", { className: "when", textContent: whenOf(stash.created_at) }));
  }
  const n = stash.tabs.length;
  h2.append(el("span", { className: "n", textContent: shown === n ? plural(n, "tab") : `${shown} of ${n}` }));
  if (stash.source === "import") {
    h2.append(el("span", { className: "badge", textContent: `Imported${stash.format ? ` · ${FORMAT_SHORT[stash.format] || stash.format}` : ""}` }));
  }

  const button = (text, cls, title, fn, disabled = false) => {
    const b = el("button", { className: `small ${cls}`, textContent: text, title, disabled });
    b.onclick = fn;
    return b;
  };
  const toggle = (text, on, title, fn) => {
    const b = button(text, "ghost toggle", title, fn);
    b.setAttribute("aria-pressed", String(on));
    return b;
  };
  const locked = stash.locked;
  const imported = stash.source === "import";
  h2.append(el("div", { className: "gacts" },
    button("Restore all", "primary", settings.afterRestore === "remove" && !locked
      ? "Reopen every tab, unloaded until you switch to it, and take them out of the stash"
      : "Reopen every tab, unloaded until you switch to it; the stash stays",
    () => act({ type: "restore-stash", id: stash.id }, restoredText)),
    button("Move to list", "", "Add these to the reading list and take them out of the stash",
      () => act({ type: "move-stash", id: stash.id },
        r => `Moved ${r.moved} to the list${r.skipped ? ` (${r.skipped} were already on it)` : ""}` +
          (r.stayed ? ` · ${r.stayed} local or browser pages stay here` : "")), locked),
    toggle(stash.starred ? "★ Starred" : "☆ Star", stash.starred, "Starred stashes stay at the top",
      () => act({ type: "flag-stash", id: stash.id, starred: !stash.starred })),
    toggle(locked ? "Locked" : "Lock", locked, "A locked stash cannot lose a tab: no delete, remove or move out, and restoring keeps it",
      () => act({ type: "flag-stash", id: stash.id, locked: !locked })),
    ...popoverMenu("⋯", `More actions for the stash ${stashName(stash)}`, [
      { text: "Rename", run: () => { renaming = stash.id; render(); } },
      { text: "Tag all tabs…", title: "Add one tag to every tab in this stash",
        run: () => tagAdder(h2, `Tag all ${plural(n, "tab")} of ${stashName(stash)}`,
          t => act({ type: "tag-stash", id: stash.id, tags: [t] }, r => `Tagged ${plural(r.tagged, "tab")} ${t}`)) },
      { text: imported ? "Mark as stashed from open tabs" : "Mark as imported",
        title: "Which source this stash belongs to in the top bar",
        run: () => act({ type: "set-stash-source", id: stash.id, source: imported ? "tabs" : "import" },
          () => (imported ? "Now under Stashed tabs" : "Now under Imports")) },
      "-",
      { text: "Delete…", className: "danger", disabled: locked, title: locked ? "Unlock it first" : "Remove this stash; its tabs are closed, so this is their only record",
        run: () => {
          if (!confirm(`Delete this stash of ${plural(n, "tab")}? They are closed, so this removes the only record of them.`)) return;
          return act({ type: "delete-stash", id: stash.id }, () => `Deleted a stash of ${plural(n, "tab")}`);
        } },
    ]),
  ));
  dropTarget(h2, stash, () => ({ before: null, mark: "drop-end" }));
  return h2;
}

/* --- grouping ------------------------------------------------------------------------- */

function section(title, count, rows, extraClass = "") {
  const s = el("section", { className: `group${extraClass}` });
  if (title) s.append(el("h2", {}, el("span", { textContent: title }), el("span", { className: "n", textContent: count })));
  s.append(el("ul", { className: "rows" }, ...rows));
  return s;
}

function renderByStash(out, visible, term) {
  const filtering = !!(term || filter !== "all" || domainSel.size || tagSel.size);
  const show = new Set(visible.map(l => l.key));
  let any = false;
  for (const stash of data.stashes) {
    if (stashOnly && stash.id !== stashOnly) continue;
    const rows = stash.tabs.map((tab, index) => ({ tab, index, link: data.byKey.get(tab.key) })).filter(r => r.link && show.has(r.link.key));
    if (!rows.length && filtering) continue;
    any = true;
    const ul = el("ul", { className: "rows stash" }, ...rows.map(r => safeRow(r.link, { stash, tab: r.tab, index: r.index })));
    dropTarget(ul, stash, e => (e.target === ul ? { before: null, mark: "drop-end" } : undefined));
    out.append(el("section", { className: `group${stash.locked ? " locked" : ""}` }, stashHeading(stash, rows.length), ul));
  }
  // Reading-list links not already shown under a stash.
  const listOnly = stashOnly && stashOnly !== "list" ? [] : visible.filter(l => l.list && !l.copies.some(c => visibleStash(c.stash))).sort(byNewest);
  if (listOnly.length) {
    any = true;
    out.append(section("Reading list", listOnly.length, listOnly.map(l => safeRow(l, null)), " list-group"));
  }
  return any;
}

function bucketsOf(visible) {
  if (group === "newest") return [["", [...visible].sort(byNewest)]];
  if (group === "oldest") return [["", [...visible].sort(byNewest).reverse()]];
  if (group === "tag") {
    // A link shows under each of its tags; one with none set by hand goes under Untagged.
    const buckets = new Map();
    for (const l of [...visible].sort(byNewest)) {
      for (const t of l.tags.length ? l.tags : ["Untagged"]) {
        if (!buckets.has(t)) buckets.set(t, []);
        buckets.get(t).push(l);
      }
    }
    return [...buckets.entries()].sort((a, b) => (a[0] === "Untagged") - (b[0] === "Untagged") || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }
  const keyFor = {
    domain: l => siteOf(l.url),
    day: l => (l.date ? new Date(l.date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "No date"),
    month: l => (l.date ? new Date(l.date).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "No date"),
  }[group];
  const buckets = new Map();
  for (const l of [...visible].sort(byNewest)) {
    const k = keyFor(l);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }
  const list = [...buckets.entries()];
  // Domains by size; dates stay newest first, with the undated last.
  if (group === "domain") list.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  else list.sort((a, b) => (a[0] === "No date") - (b[0] === "No date"));
  return list;
}

/* --- domain chips ------------------------------------------------------------------------
 * Multi-select: clicking narrows to the chosen set, clicking again releases; nothing selected means
 * no narrowing. The long tail hides behind an expander so fifty one-off domains do not swallow the
 * toolbar. */
function renderDomainChips() {
  const box = $("domains");
  box.textContent = "";
  const counts = new Map();
  for (const l of data.links) {
    const h = siteOf(l.url);
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const hosts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = domainsExpanded ? hosts : hosts.slice(0, 12);
  const chip = (host, n) => {
    const icon = host === "Local files" ? srcIcon("file:///") : host === "Browser pages" ? srcIcon("about:blank") : srcIcon(`https://${host}/`);
    const b = el("button", { className: "chip" }, icon, host, el("span", { className: "n", textContent: n }));
    b.setAttribute("aria-pressed", String(domainSel.has(host)));
    Peek.mark(b, "site", host);
    b.onclick = () => { domainSel.has(host) ? domainSel.delete(host) : domainSel.add(host); render(); };
    return b;
  };
  for (const [host, n] of shown) box.append(chip(host, n));
  // Selected domains always stay visible, even from the collapsed tail.
  for (const host of domainSel) if (!shown.some(([h]) => h === host)) box.append(chip(host, counts.get(host) || 0));
  if (hosts.length > 12) {
    const more = el("button", { className: "chip ghost", textContent: domainsExpanded ? "Show fewer" : `${hosts.length - 12} more` });
    more.setAttribute("aria-expanded", String(domainsExpanded));
    more.onclick = () => { domainsExpanded = !domainsExpanded; render(); };
    box.append(more);
  }
  if (domainSel.size) {
    const clear = el("button", { className: "chip ghost", textContent: "Clear domains" });
    clear.onclick = () => { domainSel.clear(); render(); };
    box.append(clear);
  }
}

/* Tag toggles, as the domain ones: nothing selected means no narrowing, several mean any of them.
 * Untagged picks the links with no tag set by hand — the ones still to tag. */
function renderTagChips() {
  const box = $("tagchips");
  box.textContent = "";
  const counts = new Map();
  let untagged = 0;
  for (const l of data.links) {
    if (!l.tags.length) untagged++;
    for (const t of shownTags(l).tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (!counts.size && !untagged) return;
  const chip = (id, label, n, node) => {
    const b = el("button", { className: "chip tagchip" }, node || label, el("span", { className: "n", textContent: n }));
    b.setAttribute("aria-pressed", String(tagSel.has(id)));
    b.onclick = () => { tagSel.has(id) ? tagSel.delete(id) : tagSel.add(id); render(); };
    return b;
  };
  box.append(el("span", { className: "rowlabel", textContent: "Tags" }));
  if (untagged) box.append(chip(UNTAGGED, "Untagged", untagged));
  const hand = new Set(data.links.flatMap(l => l.tags));
  for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    box.append(chip(t, t, n, tagChip(t, !hand.has(t))));
  }
  if (tagSel.size) {
    const clear = el("button", { className: "chip ghost", textContent: "Clear tags" });
    clear.onclick = () => { tagSel.clear(); render(); };
    box.append(clear);
  }
}

function setFilter(which) {
  filter = which;
  for (const f of FILTERS) $(`f-${f}`).setAttribute("aria-pressed", String(f === which));
}

function clearFilters() {
  $("q").value = "";
  domainSel.clear();
  tagSel.clear();
  setFilter("all");
  render();
}

/* --- render ------------------------------------------------------------------------------- */

/* With ?stash=<id>, a banner saying so; closing it shows everything again. */
function renderOnly() {
  const box = $("only");
  box.textContent = "";
  const name = stashOnly === "list" ? "the reading list" : stashOnly && stashById(stashOnly) ? stashName(stashById(stashOnly)) : null;
  box.hidden = !name;
  if (!name) return;
  const b = el("button", { type: "button", title: "Show every stash again" }, `Only ${name} ×`);
  b.onclick = () => { stashOnly = null; render(); };
  box.append(b);
}

function render() {
  renderRows();
  renderOnly();
  markHeads();
  if (!pane) return;
  // The pane always shows a link: the cursor's, else the first row's.
  if (cursorAt() === -1 && rowsOnPage.length) setCursor(rowsOnPage[0].id, false);
  else renderDetail();
}

function renderRows() {
  rowsOnPage = [];
  renderDomainChips();
  renderTagChips();
  renderSettings();
  renderDuplicates();
  const term = $("q").value.trim().toLowerCase();
  const total = data.links.length;
  const counts = {
    all: total,
    uncaptured: data.links.filter(l => isWeb(l.url) && !l.cap).length,
    local: data.links.filter(l => !isWeb(l.url)).length,
    filtered: data.filteredLinks.length,
    captured: data.links.filter(l => isWeb(l.url) && l.cap).length,
    untagged: data.links.filter(l => !l.tags.length).length,
  };
  const stashBit = data.stashes.length ? ` · ${data.stashes.length === 1 ? "1 stash" : `${data.stashes.length} stashes`}` : "";
  $("sub").textContent = total
    ? `${plural(total, "link")} · ${counts.captured} captured · ${counts.untagged} untagged${stashBit}`
    : "Nothing to show";
  $("bar-captured").style.width = total ? `${counts.captured / total * 100}%` : "0";
  const names = { all: "All", captured: "Captured", uncaptured: "Not captured", local: "Local & browser", filtered: "Filtered out" };
  for (const f of FILTERS) $(`f-${f}`).replaceChildren(`${names[f]} `, el("span", { className: "n", textContent: counts[f] }));
  $("groupby").value = group;

  const out = $("out");
  out.textContent = "";
  const visible = (filter === "filtered" ? data.filteredLinks : data.links).filter(l => matches(l, term));

  if (!data.sources.size) {
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No source chosen" }),
      el("p", { textContent: "Pick Stashed tabs, Imports or Reading list in the bar at the top." })));
    return;
  }
  if (!total) {
    out.append(el("div", { className: "empty" },
      el("p", { className: "title", textContent: "Nothing here yet" }),
      el("p", {}, "Stash tabs with ", el("kbd", { textContent: "⌃⇧S" }), " (", el("kbd", { textContent: "Alt+Shift+S" }),
        " off a Mac), queue a page with ", el("kbd", { textContent: "Ctrl+Shift+U" }), ", or Import a OneTab export.")));
    return;
  }
  if (!visible.length) {
    const clear = el("button", { textContent: "Clear filters" });
    clear.onclick = clearFilters;
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No matches" }),
      el("p", { textContent: "Nothing shown matches the filter." }), clear));
    return;
  }

  if (group === "stash") {
    renderByStash(out, visible, term);
    return;
  }
  for (const [name, list] of bucketsOf(visible)) out.append(section(name, list.length, list.map(l => safeRow(l, null))));
}

/* --- the detail pane ------------------------------------------------------------------------
 * The cursor's link in full: what is known without touching the network — its capture, where else
 * it is held, other links from its site — and the live preview, which loads the page itself. */

const PREVIEW_KEY = "stashPreview";
const ALL_SITES = { origins: ["*://*/*"] };
const DWELL_MS = 500;
/* The live preview: off (each link opens without it), this link (shown for the link you are on,
 * off again on the next), or keep on (every link, remembered). Only keep on is stored. */
let previewMode = "off";
let previewFor = null;   // the link "this link" was turned on for
const detailLink = () => rowsOnPage[cursorAt()]?.target.link || null;
const previewShowing = link => previewMode === "keep" || (previewMode === "this" && !!link && previewFor === link.key);
let previewTimer = null;
let detailFor = null;

// Kept and skipped are judgements from before 5.38; a list entry now reads as opened or not.
const LIST_STATUS = { pending: "not opened yet", seen: "opened", kept: "opened", skipped: "opened" };

function renderDetail() {
  const box = $("detail");
  const i = cursorAt();
  const row = rowsOnPage[i];
  // A tag being typed in the pane survives the reload its own save sets off.
  if (row && row.id === detailFor && box.contains(document.activeElement)) return;
  // The live page stays loaded while the same link is shown.
  const frame = $("pv-frame");
  const keep = frame && row && frame.dataset.url === row.target.link.url ? frame : null;
  box.textContent = "";
  clearTimeout(previewTimer);
  detailFor = row?.id || null;
  if (!row) {
    box.append(el("div", { className: "dempty" }, el("b", { textContent: "Nothing selected" }), "Pick a link on the left, or walk to one with W S."));
    return;
  }
  const { link, stash, tab } = row.target;
  const url = link.url;
  const kind = kindOf(url);
  const when = stash
    ? `stashed ${whenOf(stash.created_at)}${renamed(stash) ? ` · ${stash.name}` : ""}`
    : link.date ? `${link.list?.saved_at ? "saved" : "added"} ${whenOf(link.date)} · reading list` : "reading list";
  box.append(el("div", { className: "dhead" }, srcIcon(url),
    el("div", {},
      el("div", { className: "site", textContent: kind === "web" ? hostOf(url) : kind === "file" ? "Local file" : "Browser page" }),
      el("div", { className: "when" }, when, readBadge(link))),
    el("div", { className: "pos", textContent: `${i + 1} / ${rowsOnPage.length}` })));

  const title = labelOf(link) || tab?.title || null;
  box.append(el("h2", { className: `dtitle${title ? "" : " plain"}`, textContent: title || shortUrl(url) }));
  box.append(el("div", { className: "durl", textContent: url }));
  box.append(LinkActions.bar(row.target));

  const badges = el("div", { className: "badges" });
  if (tab?.seen_at) badges.append(el("span", { className: "badge", textContent: `restored ${whenOf(tab.seen_at)}` }));
  if (tab?.container) badges.append(el("span", { className: "badge", textContent: "Container" }));
  if (stash?.source === "import") badges.append(el("span", { className: "badge", textContent: "Imported" }));
  if (kind === "other") badges.append(el("span", { className: "badge", textContent: "Opens as a stand-in" }));
  if (badges.childElementCount) box.append(badges);
  // Tags edit in place; T jumps into the field, Enter on it empty moves to the next link. The rows
  // catch up on the next reload, so a filter such as Untagged does not pull the link away mid-edit.
  const tagrow = el("div", { className: "tagrow" }, el("span", { className: "tagrow-label", textContent: "Tags" }), tagEditor(link, () => {}));
  tagrow.addEventListener("tagdone", e => { if (e.detail?.escape) document.activeElement?.blur(); });
  box.append(tagrow);
  box.append(knownBox(row), previewBox(link, keep));
}

function knownBox(row) {
  const { link, stash } = row.target;
  const box = el("section", { className: "box" }, el("h3", { textContent: "Page content" }));
  const c = link.cap;
  if (c?.text) box.append(el("div", { className: "captext" }, c.handle && el("span", { className: "who", textContent: `${c.handle} ` }), c.text));
  else if (c?.title && c.title !== labelOf(link)) box.append(el("p", { className: "muted", textContent: c.title }));
  if (c?.images?.length) {
    box.append(el("div", { className: "thumbs" }, ...c.images.slice(0, 8).map(src => {
      const img = el("img", { src, loading: "lazy", alt: "" });
      img.addEventListener("error", () => img.remove());
      return el("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, img);
    })));
  }
  if (c?.links?.length) {
    box.append(el("div", { className: "inner" }, ...c.links.slice(0, 8).map(href => linkChip(href, shortUrl(href), href))));
  }

  const facts = el("ul", { className: "facts" });
  if (c?.captured_at) facts.append(el("li", { textContent: `Captured ${whenOf(c.captured_at)}` }));
  else if (isWeb(link.url)) facts.append(el("li", { textContent: "Not captured yet. Capture saves its text and images." }));
  if (link.list) facts.append(el("li", { textContent: `On the reading list: ${LIST_STATUS[link.list.status] || link.list.status}` }));
  for (const copy of link.copies) {
    if (stash && copy.stash === stash.id) continue;
    const s = stashById(copy.stash);
    if (!s) continue;
    // A copy shown as its own row is a click away; one that is not, a hover preview.
    const there = rowsOnPage.find(r => r.base === `${s.id} ${link.key}`);
    const name = there
      ? Object.assign(el("button", { className: "link", textContent: stashName(s) }), { onclick: () => setCursor(there.id) })
      : el("span", { className: "peekable", textContent: stashName(s) });
    Peek.mark(name, "stash", `${s.id}|${link.key}`);
    facts.append(el("li", {}, stash ? "Also stashed in " : "Stashed in ", name, visibleStash(s.id) ? "" : " (not shown)"));
  }
  if (isWeb(link.url)) {
    const host = hostOf(link.url);
    const same = data.links.filter(l => l.key !== link.key && isWeb(l.url) && hostOf(l.url) === host).length;
    if (same) {
      const b = el("button", { className: "link", textContent: `Show all ${same + 1}` });
      b.onclick = () => { $("q").value = host; render(); };
      facts.append(el("li", {}, `${plural(same, "other link")} from ${host} `, b));
    }
  }
  box.append(facts);
  return box;
}

function previewBox(link, keep) {
  const url = link.url;
  const box = el("section", { className: "box" }, el("h3", { textContent: "Live preview" }));
  const showing = previewShowing(link);
  const now = previewMode === "keep" ? "keep" : showing ? "this" : "off";
  const seg = el("div", { className: "pvseg", role: "group" });
  seg.setAttribute("aria-label", "Live preview");
  for (const [mode, text, title] of [["off", "Off", "No preview"], ["this", "This link", "Show this link's page; the next link opens without it (P)"],
    ["keep", "Keep on", "Show every link's page as you select it, until you turn it off"]]) {
    const b = el("button", { type: "button", className: "chip small", textContent: text, title });
    b.setAttribute("aria-pressed", String(mode === now));
    b.onclick = () => setPreview(mode);
    seg.append(b);
  }
  box.append(el("div", { className: "pvbar" }, seg, el("kbd", { textContent: "P" })));
  if (!showing) {
    box.append(el("p", { className: "pvnote", textContent: "Each preview loads the real page. This link shows it for this link only; Keep on shows it for every link until you turn it off." }));
    return box;
  }
  if (!isWeb(url)) {
    box.append(el("p", { className: "pvnote", textContent: kindOf(url) === "file"
      ? "Local files cannot be shown inside an extension page. Open reopens it through the helper."
      : "Browser and extension pages cannot be shown here. Open brings it back as a stand-in." }));
    return box;
  }
  if (keep) { box.append(keep); return box; }
  const frame = el("iframe", { id: "pv-frame", title: `Preview of ${labelOf(link) || url}`, referrerPolicy: "no-referrer" });
  frame.dataset.url = url;
  // No allow-top-navigation: a framed page cannot navigate this one away.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  box.append(frame, el("p", { className: "pvnote", textContent: "If the preview is blank, the site refused to be shown; use Open instead." }));
  previewTimer = setTimeout(() => { frame.src = url; }, DWELL_MS);
  return box;
}

async function setPreview(mode) {
  if (mode !== "off" && !(await browser.permissions.contains(ALL_SITES))) {
    // Asked here, from the click: a permission prompt must come from a user gesture.
    const granted = await browser.permissions.request(ALL_SITES).catch(() => false);
    if (!granted) { say("Previews need access to all sites; nothing changed"); mode = "off"; }
  }
  previewMode = mode;
  previewFor = mode === "this" ? detailLink()?.key || null : null;
  await browser.storage.local.set({ [PREVIEW_KEY]: mode === "keep" });
  detailFor = null;
  renderDetail();
}

/* --- settings ------------------------------------------------------------------------------ */

/* Every tag set by hand, with how many links carry it. Renaming onto a tag that exists merges the
 * two; deleting takes it off every link. */
function renderTagManager() {
  const list = $("tag-list");
  list.textContent = "";
  const counts = new Map();
  for (const l of data.all.links) for (const t of l.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (!counts.size) list.append(el("li", { className: "none", textContent: "None yet. Use ✎ on a row to add one." }));
  for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const name = el("button", { className: "link", title: "Rename; a name already in use merges the two" }, tagChip(t));
    name.onclick = () => {
      const input = el("input", { type: "text", value: t, className: "rename-tag" });
      input.setAttribute("aria-label", `Rename ${t}`);
      const done = async save => {
        if (!input.isConnected) return;
        const to = input.value.toLowerCase().replace(/\s+/g, " ").trim();
        if (save && to && to !== t) {
          const merging = counts.has(to);
          await act({ type: "rename-tag", from: t, to }, r => `${merging ? "Merged" : "Renamed"} ${t} → ${to} on ${plural(r.links, "link")}`);
        } else render();
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
      input.addEventListener("blur", () => done(true));
      name.replaceWith(input);
      input.focus();
      input.select();
    };
    const del = el("button", { className: "small ghost", textContent: "×", title: `Delete ${t} from every link` });
    del.setAttribute("aria-label", `Delete the tag ${t}`);
    del.onclick = () => {
      if (!confirm(`Delete the tag “${t}” from ${plural(n, "link")}? The links stay.`)) return;
      act({ type: "delete-tag", tag: t }, r => `Deleted ${t} from ${plural(r.links, "link")}`);
    };
    list.append(el("li", {}, name, el("span", { className: "n", textContent: n }), del));
  }
}

function renderSettings() {
  renderTagManager();
  for (const r of document.querySelectorAll('input[name="after-stash"]')) r.checked = r.value === settings.afterStash;
  for (const r of document.querySelectorAll('input[name="after-restore"]')) r.checked = r.value === settings.afterRestore;
  const list = $("exclude-list");
  list.textContent = "";
  if (!settings.exclude.length) list.append(el("li", { className: "none", textContent: "None yet. Right-click a page → Stash → Never stash this site." }));
  for (const host of settings.exclude) {
    const b = el("button", { className: "small ghost", textContent: "×", title: `Stash ${host} again` });
    b.setAttribute("aria-label", `Stash ${host} again`);
    b.onclick = () => act({ type: "toggle-excluded", host }, () => `${host} will be stashed again`);
    list.append(el("li", {}, srcIcon(`https://${host}/`), el("span", { textContent: host }), b));
  }
}


/* The filtered-out rules: read when Settings opens, saved and applied to every link held. */
async function loadFilterRules() {
  const { rules } = await send({ type: "filter-rules" });
  $("filter-rules").value = (rules || []).join("\n");
}
$("filter-save").onclick = async () => {
  $("filter-msg").textContent = "applying…";
  const res = await send({ type: "set-filter-rules", rules: $("filter-rules").value.split("\n") });
  $("filter-rules").value = (res.rules || []).join("\n");
  $("filter-msg").textContent = res.ok ? `${plural(res.matched, "link")} filtered out${res.added ? `, ${res.added} new` : ""}${res.removed ? `, ${res.removed} back in the pile` : ""}` : (res.error || "not saved");
  load();
};

/* Backups: what the bridge last wrote, and the files to restore from. */
async function loadBackups() {
  const st = await send({ type: "bridge-status" });
  const last = st.lastBackup;
  $("backup-status").textContent = st.state !== "on" ? `Not backing up: ${st.error || "the helper is not running"}.`
    : st.error ? `Not backing up: ${st.error}.`
    : last?.ok ? `Backed up to ${st.folder} at ${new Date(last.at).toLocaleString()}, about a minute after each change.`
    : last ? `The last backup failed: ${last.error}` : `Backing up to ${st.folder}, about a minute after each change.`;
  const list = st.state === "on" ? await send({ type: "list-backups" }) : { backups: [] };
  const pick = $("backup-pick");
  pick.textContent = "";
  for (const b of list.backups || []) pick.append(el("option", { value: b.name, textContent: `${b.name} · ${new Date(b.modified).toLocaleString()} · ${Math.round(b.bytes / 1024)} KB` }));
  pick.disabled = $("backup-restore").disabled = !pick.options.length;
  $("backup-now").disabled = st.state !== "on";
}
$("backup-now").onclick = async () => {
  const res = await send({ type: "backup-now" });
  say(res.ok ? `Backed up to ${res.file}` : `Not backed up: ${res.error}`);
  loadBackups();
};
$("backup-restore").onclick = async () => {
  const name = $("backup-pick").value;
  if (!name || !confirm(`Replace tags, captures, the reading list and settings with ${name}? What is here now is saved to a pre-restore file first.`)) return;
  const res = await send({ type: "restore-backup", name });
  say(res.ok ? `Restored the backup of ${new Date(res.backup_at).toLocaleString()}${res.stashes ? `, and wrote ${plural(res.stashes, "stash")} again` : ""}` : `Not restored: ${res.error}`);
  loadBackups();
  load();
};

for (const r of document.querySelectorAll('input[name="after-stash"]')) r.onchange = () => act({ type: "set-stash-settings", afterStash: r.value });
for (const r of document.querySelectorAll('input[name="after-restore"]')) r.onchange = () => act({ type: "set-stash-settings", afterRestore: r.value });
$("exclude-form").onsubmit = e => {
  e.preventDefault();
  let host = $("exclude-host").value.trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname; } catch (err) { /* keep what was typed */ }
  host = host.replace(/^www\./, "").replace(/\/.*$/, "");
  if (!host || settings.exclude.includes(host)) return;
  $("exclude-host").value = "";
  act({ type: "toggle-excluded", host }, () => `${host} will not be stashed`);
};

function openPanel(which) {
  for (const id of ["settings-panel", "import-panel", "dups-panel"]) $(id).hidden = id !== which || !$(id).hidden;
  $("settings").setAttribute("aria-expanded", String(!$("settings-panel").hidden));
  if (!$("settings-panel").hidden) { loadFilterRules(); loadBackups(); }
  $("import").setAttribute("aria-expanded", String(!$("import-panel").hidden));
  $("dups").setAttribute("aria-expanded", String(!$("dups-panel").hidden));
  if (!$("import-panel").hidden) $("import-text").focus();
  if (!$("dups-panel").hidden) renderDuplicates();
}
$("settings").onclick = () => openPanel("settings-panel");
$("dups").onclick = () => openPanel("dups-panel");

/* --- duplicates -----------------------------------------------------------------------------
 * Every link held in more than one place among the sources on show — two stashes, or a stash and
 * the reading list — as a card with a checkbox per copy. Nothing starts ticked, a locked stash's
 * copy cannot be, and only what is ticked is removed, after one confirm. */

const picked = new Set();   // copy ids: "tab:<bookmark id>" or "list:<link key>"

function duplicateSets() {
  const out = [];
  for (const link of data.links) {
    const copies = link.copies.filter(c => visibleStash(c.stash)).map(c => {
      const stash = stashById(c.stash);
      const at = stash.tabs.findIndex(t => t.id === c.tab);
      return { id: `tab:${c.tab}`, stash, tab: c.tab, locked: stash.locked,
        label: stashName(stash), detail: `${stash.source === "import" ? "imported" : "stashed"} ${whenOf(stash.created_at)} · tab ${at + 1} of ${stash.tabs.length}` };
    });
    if (link.list && !link.list.loose && data.sources.has("list")) {
      const LIST = { pending: "not opened yet", seen: "opened", kept: "opened", skipped: "opened" };
      copies.push({ id: `list:${link.key}`, list: true, locked: false, label: "Reading list",
        detail: `${LIST[link.list.status] || link.list.status}${link.list.added_at ? ` · added ${link.list.added_at.slice(0, 10)}` : ""}` });
    }
    if (copies.length > 1) out.push({ link, copies });
  }
  return out.sort((a, b) => b.copies.length - a.copies.length || (labelOf(a.link) || a.link.url).localeCompare(labelOf(b.link) || b.link.url));
}

function renderDuplicates() {
  const sets = duplicateSets();
  $("dups").hidden = !sets.length && $("dups-panel").hidden;
  $("dups").textContent = `Duplicates (${sets.length})…`;
  if ($("dups-panel").hidden) return;
  // What was ticked stays ticked across a reload, as long as the copy is still there.
  const ids = new Set(sets.flatMap(s => s.copies.map(c => c.id)));
  for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);

  const box = $("dups-list");
  box.textContent = "";
  if (!sets.length) box.append(el("p", { className: "none", textContent: "No link appears twice in the sources shown." }));
  for (const { link, copies } of sets) {
    const title = labelOf(link);
    const card = el("div", { className: "dup-card" },
      el("div", { className: "dup-head" }, srcIcon(link.url),
        el("div", {}, el("div", { className: `dup-title${title ? "" : " plain"}`, textContent: title || shortUrl(link.url), title: link.url }),
          title && el("div", { className: "dup-url", textContent: shortUrl(link.url) }))));
    for (const c of copies) {
      const box2 = el("input", { type: "checkbox", checked: picked.has(c.id), disabled: c.locked });
      box2.onchange = () => { box2.checked ? picked.add(c.id) : picked.delete(c.id); paintDupCount(); };
      card.append(el("label", { className: `dup-row${c.locked ? " locked" : ""}` }, box2,
        el("span", { className: "dup-where", textContent: c.label }),
        el("span", { className: "dup-detail", textContent: c.locked ? `${c.detail} · locked` : c.detail })));
    }
    box.append(card);
  }
  paintDupCount();
}

function paintDupCount() {
  $("dups-remove").disabled = !picked.size;
  $("dups-remove").textContent = picked.size ? `Remove ${copiesWord(picked.size)}` : "Remove selected";
}
// plural() would say "copys".
const copiesWord = n => (n === 1 ? "1 copy" : `${n} copies`);

$("dups-remove").onclick = async () => {
  const sets = duplicateSets();
  const chosen = sets.flatMap(s => s.copies.filter(c => picked.has(c.id) && !c.locked).map(c => ({ ...c, link: s.link })));
  if (!chosen.length) return;
  const gone = sets.filter(s => s.copies.every(c => picked.has(c.id))).length;
  const warn = gone ? ` ${gone === 1 ? "1 link loses" : `${gone} links lose`} every copy and will be gone entirely.` : "";
  if (!confirm(`Remove ${copiesWord(chosen.length)}? A stashed tab is closed, so its copy may be its only record.${warn}`)) return;
  const byStash = new Map();
  for (const c of chosen.filter(c => c.stash)) {
    if (!byStash.has(c.stash.id)) byStash.set(c.stash.id, []);
    byStash.get(c.stash.id).push(c.tab);
  }
  let removed = 0;
  for (const [id, ids] of byStash) removed += (await send({ type: "delete-stash", id, ids }))?.removed || 0;
  const listUrls = chosen.filter(c => c.list).map(c => c.link.url);
  if (listUrls.length) removed += (await send({ type: "remove", urls: listUrls }))?.removed || 0;
  picked.clear();
  say(`Removed ${copiesWord(removed)}`);
  await load();
};
$("dups-close").onclick = () => openPanel("dups-panel");

/* Where Keep with a screenshot saves: a folder inside Downloads, the only place an extension may
 * write. Committed on Enter or leaving the field, so every keystroke is not a write. */
send({ type: "get-folder" }).then(({ folder, fallback }) => {
  $("folder").value = folder;
  $("folder").placeholder = fallback;
  $("folder-echo").textContent = folder || fallback;
});
async function saveFolder() {
  const { folder } = await send({ type: "set-folder", folder: $("folder").value });
  $("folder").value = folder;
  $("folder-echo").textContent = folder || "";
  say(folder ? `Screenshots go to Downloads/${folder}/` : "Screenshots go to Downloads/");
}
$("folder").onchange = saveFolder;
$("folder").onkeydown = e => { if (e.key === "Enter") saveFolder(); };

/* --- import ---------------------------------------------------------------------------------
 * One panel for everything: stashes (OneTab, TidyTab, a Link Keeper export, CSV, text with links)
 * become stashes marked as imported; capture JSONL merges into the reading list. */

const FORMAT_NAMES = {
  "link-keeper": "a Link Keeper export", tidytab: "a TidyTab export", json: "a JSON list", csv: "CSV",
  onetab: "OneTab's Export URLs", text: "text with links in it", captures: "capture JSONL",
};
const FORMAT_SHORT = { "link-keeper": "Link Keeper", tidytab: "TidyTab", json: "JSON", csv: "CSV", onetab: "OneTab", text: "text" };
let parsed = null;
const importDest = () => document.querySelector('input[name="import-dest"]:checked')?.value || "stashes";

/* Dates written after a URL on its own line — "https://… 2024-03-05", as a Telegram or notes export
 * gives them — which the reading list keeps as the date the link was saved. */
function datedLines(text) {
  const dates = new Map();
  for (const line of String(text).split("\n")) {
    const [url, ...rest] = line.trim().split(/\s+/);
    const stamp = rest.join(" ").replace(/^\|\s*/, "").trim();
    if (!/^https?:\/\//.test(url || "") || !stamp || Number.isNaN(Date.parse(stamp))) continue;
    dates.set(url, new Date(stamp).toISOString());
  }
  return dates;
}

/* What an import to the reading list adds: every link found, with its date if one was given. */
function listEntries() {
  const dates = datedLines($("import-text").value);
  const seen = new Set();
  const out = [];
  for (const st of parsed.stashes) {
    for (const t of st.tabs) {
      if (!/^(https?|ftp):/.test(t.url) || seen.has(t.url)) continue;
      seen.add(t.url);
      out.push({ url: t.url, title: t.title, saved_at: dates.get(t.url) || st.created_at || undefined });
    }
  }
  return out;
}

function previewImport() {
  $("import-cancel").textContent = "Cancel";
  parsed = parseStashImport($("import-text").value);
  const note = $("import-msg");
  note.className = "";
  if (parsed.format === "captures") {
    note.textContent = `Read as capture JSONL: ${plural(parsed.records.length, "record")}; they merge into the reading list` +
      (parsed.skipped ? ` · ${plural(parsed.skipped, "line")} unreadable` : "") + ".";
    $("import-go").disabled = !parsed.records.length;
    $("import-dest").hidden = true;
    return;
  }
  $("import-dest").hidden = !parsed.format;
  const n = parsed.stashes.reduce((sum, s) => sum + s.tabs.length, 0);
  if (!parsed.format) note.textContent = "Paste OneTab's Export URLs, a TidyTab or Link Keeper export, CSV with a url column, capture JSONL, or any text with links.";
  else if (!n) { note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}, but found no links.`; note.className = "bad"; }
  else if (importDest() === "list") {
    const entries = listEntries();
    const dated = entries.filter(e => e.saved_at).length;
    note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}: ${plural(entries.length, "web link")} for the reading list` +
      (dated ? `, ${dated} with a date` : "") + (n > entries.length ? ` · ${n - entries.length} local or repeated skipped` : "") + ".";
    $("import-go").disabled = !entries.length;
    return;
  }
  else note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}: ${plural(n, "tab")} in ${plural(parsed.stashes.filter(s => s.tabs.length).length, "stash")}, under Imports` +
    (parsed.skipped ? ` · ${plural(parsed.skipped, "line")} without a link skipped` : "") + ".";
  $("import-go").disabled = !n;
}
for (const r of document.querySelectorAll('input[name="import-dest"]')) r.onchange = previewImport;

$("import").onclick = () => { openPanel("import-panel"); previewImport(); };
$("import-text").addEventListener("input", previewImport);
$("import-file").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  $("import-text").value = await file.text();
  previewImport();
};
$("import-cancel").onclick = () => {
  $("import-panel").hidden = true;
  $("import").setAttribute("aria-expanded", "false");
};

function importDone(text) {
  $("import-text").value = "";
  $("import-file").value = "";
  parsed = null;
  $("import-go").disabled = true;
  $("import-cancel").textContent = "Close";
  $("import-msg").className = "ok";
  $("import-msg").textContent = text;
}

const captureSummary = res => `${res.added} new, ${res.enriched} filled in, ${res.skipped} already known` +
  `${res.marked ? `, ${res.marked} taken off the queue` : ""}; ${res.total} captures in all`;

/* Writing a few hundred bookmarks takes seconds, so the panel counts them as Firefox reports each
 * one, then stays open with the result instead of vanishing. */
$("import-go").onclick = async () => {
  if (parsed?.format === "captures") {
    const res = await send({ type: "import-captures", records: parsed.records });
    importDone(captureSummary(res));
    return load();
  }
  if (!parsed?.stashes.length) return;
  if (importDest() === "list") {
    // Re-adding a link with a date fills the date in; one already dated is left as it is.
    const res = await send({ type: "add", urls: listEntries() });
    importDone(`Added ${plural(res.added, "link")} to the reading list` + (res.updated ? `, ${res.updated} dated` : "") +
      (res.skipped ? `, ${res.skipped} already on it` : "") + `; ${res.total} on the list`);
    return load();
  }
  const total = parsed.stashes.reduce((sum, s) => sum + s.tabs.length, 0);
  const note = $("import-msg"), bar = $("import-progress");
  const controls = ["import-go", "import-cancel", "import-text", "import-file"].map($);
  for (const c of controls) c.disabled = true;
  let written = 0;
  const onCreated = (id, node) => {
    if (!node.url) return;
    written++;
    bar.value = Math.min(written, total);
    note.textContent = `Importing… ${written} of ${total} tabs`;
  };
  note.className = "";
  note.textContent = `Importing… 0 of ${total} tabs`;
  bar.max = total;
  bar.value = 0;
  bar.hidden = false;
  browser.bookmarks.onCreated.addListener(onCreated);
  let res;
  try {
    res = await send({ type: "import-stashes", stashes: parsed.stashes, format: parsed.format });
  } finally {
    browser.bookmarks.onCreated.removeListener(onCreated);
    bar.hidden = true;
    for (const c of controls) c.disabled = false;
  }
  if (res?.ok) {
    importDone(`Imported ${plural(res.tabs, "tab")} in ${plural(res.stashes, "stash")}; grouped by stash, they are at the top, under Imports.`);
  } else {
    previewImport();
    note.className = "bad";
    note.textContent = res?.error || "The import did not go through; nothing was written.";
  }
  await load();
};

/* If a refresh is waiting on loopback, take it now. Import is idempotent, so doing this on every
 * visit costs nothing and means the only step after a rebuild is opening this page. */
async function takePendingRefresh() {
  const res = await send({ type: "fetch-pending" });
  if (!res?.ok) return;
  // A refresh hands over both halves: what it could read, and what it could not. The second lot
  // are the only links that still need a browser, so they go straight onto the queue.
  let records = [], queue = [];
  const body = res.body.trim();
  if (body.startsWith("{") && !body.includes("\n{")) {
    try {
      const bundle = JSON.parse(body);
      records = bundle.captures || [];
      queue = bundle.queue || [];
    } catch (e) { return; }
  } else {
    records = parseStashImport(body).records || [];
  }
  if (!records.length && !queue.length) return;
  const bits = [];
  if (records.length) {
    const out = await send({ type: "import-captures", records });
    bits.push(`${records.length} read: ${out.added} new, ${out.enriched} filled in${out.marked ? `, ${out.marked} off the queue` : ""}`);
  }
  if (queue.length) {
    const out = await send({ type: "add", urls: queue });
    bits.push(`${queue.length} needing a browser: ${out.added} queued${out.skipped ? `, ${out.skipped} already there` : ""}`);
  }
  openPanel("import-panel");
  $("import-msg").className = "ok";
  $("import-msg").textContent = `From the last refresh: ${bits.join("; ")}`;
  load();
}

/* --- page actions ------------------------------------------------------------------------------- */

$("q").addEventListener("input", render);
$("groupby").onchange = () => {
  group = $("groupby").value;
  try { localStorage.setItem(GROUP_KEY, group); } catch (e) { /* not remembered */ }
  render();
};
for (const f of FILTERS) $(`f-${f}`).onclick = () => { setFilter(f); render(); };

$("stash").onclick = () => act({ type: "stash" }, r => `Stashed ${plural(r.stashed, "tab")}${r.why ? ` · left open: ${r.why}` : ""}`);


function download(name, type, body) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
{
  const [trigger, menu] = popoverMenu("Export", "Export", [
    { text: "Stashes (JSON)", title: "Every stash; Import reads it back", run: async () => {
      const { sessions } = await send({ type: "sessions" });
      if (!sessions.length) return say("Nothing stashed");
      download(`link-keeper-stashes-${new Date().toISOString().slice(0, 10)}.json`, "application/json",
        JSON.stringify({ exported_at: new Date().toISOString(), sessions }, null, 2));
      say(`Exported ${plural(sessions.length, "stash")} to Downloads`);
    } },
    { text: "Reading list (JSONL)", title: "Every reading-list entry with its status and dates", run: async () => {
      const { items } = await send({ type: "export-list" });
      if (!items.length) return say("The reading list is empty");
      download("link-worklist.jsonl", "application/x-ndjson",
        items.map(r => JSON.stringify(r).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")).join("\n") + "\n");
      say(`Exported ${items.length === 1 ? "1 entry" : `${items.length} entries`} to Downloads`);
    } },
    { text: "Captures (JSONL)", title: "Every captured page, one JSON object per line", run: async () => {
      const { captures } = await send({ type: "export" });
      if (!captures.length) return say("Nothing captured yet");
      download("link-captures.jsonl", "application/x-ndjson",
        captures.map(r => JSON.stringify(r).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")).join("\n") + "\n");
      say(`Exported ${plural(captures.length, "capture")} to Downloads`);
    } },
  ], "");
  trigger.id = "export";
  $("export-slot").replaceWith(trigger, menu);
}

$("t-pane").onclick = () => togglePane();
$("t-compact").onclick = () => { setPref(pane ? COMPACT_PANE_KEY : COMPACT_KEY, !compactNow()); applyView(); };
$("t-tools").onclick = () => { setPref(TOOLS_KEY, !pref(TOOLS_KEY, true)); applyView(); };
applyView();

if (location.hash === "#import") { openPanel("import-panel"); previewImport(); }
takePendingRefresh();
reloadOnChanges(load, () => !!(renaming || dragging));
load();
