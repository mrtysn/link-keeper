/* List: every link from the sources chosen in the top bar — stashed tabs, imports, the reading list
 * — one row per URL, grouped by stash, domain, status, day or month, or in date order.
 *
 * Grouped by stash it is what the Stashed tabs page was: each stash under its own heading with its
 * actions, rows that drag between and within stashes, and the reading list's links after them. A
 * URL held in two stashes shows in both there, since a stash is a container; in every other
 * grouping it shows once, with badges saying where it is held.
 *
 * Keep and Drop are one verdict per URL, written to every copy (judge-link). A stash is the only
 * record of the tabs it closed, so Delete and Remove are the only ways to lose one; a lock
 * prevents both, and Delete asks first.
 */

const GROUPS = ["stash", "domain", "tag", "status", "day", "month", "newest", "oldest"];
const GROUP_KEY = "listGroup";
const FILTERS = ["all", "left", "seen", "kept", "dropped"];

let data = { links: [], stashes: [], all: { links: [], stashes: [] }, sources: new Set(), byKey: new Map() };
let settings = { afterStash: "show", afterRestore: "keep", exclude: [] };
let filter = "all";
const domainSel = new Set();   // empty = every domain
const tagSel = new Set();      // empty = every tag; UNTAGGED = links with no tag set by hand
const UNTAGGED = "\u0000untagged";
let domainsExpanded = false;
let renaming = null;
let dragging = null;

let group = "domain";
try { group = localStorage.getItem(GROUP_KEY) || "domain"; } catch (e) { /* storage blocked: default */ }
{
  // ?group=stash is how the popup's Stashed button and stashing itself land here.
  const asked = new URLSearchParams(location.search).get("group");
  if (asked) {
    group = asked;
    try { localStorage.setItem(GROUP_KEY, asked); } catch (e) { /* not remembered */ }
    history.replaceState(null, "", location.pathname + location.hash);
  }
  if (group === "flat") group = "newest";
  if (!GROUPS.includes(group)) group = "domain";
}

function say(text) { $("msg").textContent = text; }

async function load() {
  const [d, { settings: st }] = await Promise.all([loadLinks(), send({ type: "stash-settings" })]);
  data = d;
  settings = st;
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
  if (filter !== "all" && stateOf(link) !== filter) return false;
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
   * entry, so a keep on that tab attaches to it. Middle-click and copy-link behave as on any link. */
  a.addEventListener("click", e => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
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
    if (link.list && mixed) out.push(el("span", { className: "badge", textContent: "Reading list" }));
    const also = link.copies.filter(c => c.stash !== ctx.stash.id).map(c => stashById(c.stash)).filter(Boolean);
    if (also.length) {
      out.push(el("span", { className: "badge dup", textContent: `Also in ${also.length === 1 ? "1 other stash" : `${also.length} other stashes`}`,
        title: also.map(stashName).join("\n") }));
    }
    return out;
  }
  if (!mixed && link.copies.length < 2) return out;
  if (link.list && mixed) out.push(el("span", { className: "badge", textContent: "Reading list" }));
  for (const source of ["tabs", "import"]) {
    const held = link.copies.map(c => stashById(c.stash)).filter(s => s?.source === source);
    if (!held.length) continue;
    out.push(el("span", { className: "badge", textContent: `${SOURCE_NAMES[source]}${held.length > 1 ? ` ×${held.length}` : ""}`,
      title: held.map(stashName).join("\n") }));
  }
  return out;
}

/* --- keys ------------------------------------------------------------------------
 * A cursor marks the row the keys act on: 1 2 walk it, Q W jump to the previous or next section, a
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
    const anchor = (cmd === "tags" && li.querySelector(".tagedit")) || li.querySelector(".lk-bar .more") || li;
    LinkActions.key(cmd, target, anchor);
  };
}

/* After an action: a verdict moves the cursor on, as does anything that takes the row away; then
 * the page reloads with the cursor where it now is. */
LinkActions.setup({
  data: () => data,
  say,
  tags: (t, anchor) => anchoredPopover(anchor, tagEditor(t.link, () => load())),
  async after(cmd, target, res) {
    if (res.ok === false) return;
    const leaves = ["list", "move", "remove"].includes(cmd) || (cmd === "open" && /taken out/.test(res.say || ""));
    const i = cursorAt();
    if (i !== -1 && rowsOnPage[i].target.link.key === target?.link.key && (((cmd === "keep" || cmd === "drop") && !res.cleared) || leaves)) {
      const next = rowsOnPage[i + 1] || rowsOnPage[i - 1];
      if (next) cursorId = next.id;
    }
    await load();
    setCursor(cursorId);
  },
});

LinkKeys.listen({
  prev: () => walk(-1), next: () => walk(1),
  "pane-prev": () => jumpSection(-1), "pane-next": () => jumpSection(1),
  drop: onRow("drop"), keep: onRow("keep"), read: onRow("read"), open: onRow("open"), "open-other": onRow("open-other"),
  tags: onRow("tags"), list: onRow("list"), move: onRow("move"), remove: onRow("remove"),
  undo: () => LinkActions.undo(), filter: () => $("q").focus(),
  escape: () => { document.querySelector(".tagpop")?.remove(); },
});
$("keys").append(...LinkKeys.hint(["prev", "next", "pane-next", "drop", "keep", "open", "tags"]));

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
  const state = stateOf(link);
  const li = el("li");
  li.dataset.status = state;
  if (link.list?.current) li.classList.add("current");

  li.append(srcIcon(link.url));
  const mark = el("span", { className: "mark", title: STATE_NAMES[state] });
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", STATE_NAMES[state]);
  li.append(mark);

  const main = el("div", { className: "main" });
  main.append(titleLink(link, ctx));
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
  if (link.list && !cap && kind === "web") meta.append(el("span", { textContent: "not read yet" }));
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
    return el("li", {}, el("span"), el("span"), el("div", { className: "main", textContent: `${shortUrl(link.url)} — could not render: ${e.message}` }));
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
    h2.append(el("span", { className: "name", textContent: stash.name }));
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
    button("Explore", "", "Browse this stash with a sidebar, details and a live preview",
      () => send({ type: "open-stash-cards", id: stash.id })),
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
    const rows = stash.tabs.map((tab, index) => ({ tab, index, link: data.byKey.get(tab.key) })).filter(r => r.link && show.has(r.link.key));
    if (!rows.length && filtering) continue;
    any = true;
    const ul = el("ul", { className: "rows stash" }, ...rows.map(r => safeRow(r.link, { stash, tab: r.tab, index: r.index })));
    dropTarget(ul, stash, e => (e.target === ul ? { before: null, mark: "drop-end" } : undefined));
    out.append(el("section", { className: `group${stash.locked ? " locked" : ""}` }, stashHeading(stash, rows.length), ul));
  }
  // Reading-list links not already shown under a stash.
  const listOnly = visible.filter(l => l.list && !l.copies.some(c => visibleStash(c.stash))).sort(byNewest);
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
  if (group === "status") {
    return ["left", "seen", "kept", "dropped"]
      .map(s => [STATE_NAMES[s], visible.filter(l => stateOf(l) === s).sort(byNewest)])
      .filter(([, list]) => list.length);
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

function render() {
  rowsOnPage = [];
  renderDomainChips();
  renderTagChips();
  renderSettings();
  renderDuplicates();
  const term = $("q").value.trim().toLowerCase();
  const counts = { left: 0, seen: 0, kept: 0, dropped: 0 };
  for (const l of data.links) counts[stateOf(l)]++;
  const total = data.links.length;

  const stashBit = data.stashes.length ? ` · ${data.stashes.length === 1 ? "1 stash" : `${data.stashes.length} stashes`}` : "";
  $("sub").textContent = total
    ? `${plural(total, "link")} · ${counts.kept} kept · ${counts.dropped} dropped · ${counts.seen} seen · ${counts.left} left${stashBit}`
    : "Nothing to show";
  for (const [id, k] of [["bar-kept", "kept"], ["bar-seen", "seen"], ["bar-skipped", "dropped"]]) {
    $(id).style.width = total ? `${counts[k] / total * 100}%` : "0";
  }
  const names = { all: "All", left: "Left", seen: "Seen", kept: "Kept", dropped: "Dropped" };
  for (const f of FILTERS) $(`f-${f}`).replaceChildren(`${names[f]} `, el("span", { className: "n", textContent: f === "all" ? total : counts[f] }));
  $("groupby").value = group;

  const dropped = data.all.stashes.reduce((n, s) => n + (s.locked ? 0 : s.tabs.filter(t => t.verdict === "drop").length), 0);
  $("clear-dropped").hidden = !dropped;
  $("clear-dropped").textContent = `Clear ${dropped} dropped from stashes…`;

  const out = $("out");
  out.textContent = "";
  const visible = data.links.filter(l => matches(l, term));

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
      el("p", { textContent: "Nothing on show matches the filter." }), clear));
    return;
  }

  if (group === "stash") {
    renderByStash(out, visible, term);
    return;
  }
  for (const [name, list] of bucketsOf(visible)) out.append(section(name, list.length, list.map(l => safeRow(l, null))));
}

/* --- settings ------------------------------------------------------------------------------ */

/* Every tag set by hand, with how many links carry it. Renaming onto a tag that exists merges the
 * two; deleting takes it off every link. */
function renderTagManager() {
  const list = $("tag-list");
  list.textContent = "";
  const counts = new Map();
  for (const l of data.all.links) for (const t of l.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (!counts.size) list.append(el("li", { className: "none", textContent: "None yet. ✎ on any row adds one." }));
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
      const LIST = { pending: "not opened yet", seen: "opened", kept: "kept", skipped: "skipped" };
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
  if (!sets.length) box.append(el("p", { className: "none", textContent: "No link is held twice among the sources on show." }));
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
  `${res.marked ? `, ${res.marked} taken off the queue` : ""} — ${res.total} captures held`;

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
      (res.skipped ? `, ${res.skipped} already on it` : "") + ` — ${res.total} on the list`);
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
    bits.push(`${records.length} read — ${out.added} new, ${out.enriched} filled in${out.marked ? `, ${out.marked} off the queue` : ""}`);
  }
  if (queue.length) {
    const out = await send({ type: "add", urls: queue });
    bits.push(`${queue.length} needing a browser — ${out.added} queued${out.skipped ? `, ${out.skipped} already there` : ""}`);
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

$("clear-dropped").onclick = () => {
  const n = data.all.stashes.reduce((sum, s) => sum + (s.locked ? 0 : s.tabs.filter(t => t.verdict === "drop").length), 0);
  if (!confirm(`Remove the ${n} stashed tabs you dropped? They are closed, so this removes the only record of them. Locked stashes keep theirs.`)) return;
  act({ type: "clear-dropped" }, r => `Removed ${plural(r.removed, "dropped tab")}`);
};

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
    { text: "Captures (JSONL)", title: "Every page read, one JSON object per line", run: async () => {
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

if (location.hash === "#import") { openPanel("import-panel"); previewImport(); }
takePendingRefresh();
reloadOnChanges(load, () => !!(renaming || dragging));
load();
