/* Stashed tabs: every group of tabs folded away with Stash, newest first, starred ones on top.
 *
 * Stashes are Firefox bookmarks (Other Bookmarks / Link Keeper stashes), so edits made in Firefox's
 * own library show up here too. A stash is the only record of the tabs it closed, so everything
 * here is reversible except Delete and Remove, which a lock prevents and Delete asks about first.
 * Rows drag between and within stashes; the ⋯ menu does the same from the keyboard.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

let sessions = [];
let settings = { afterStash: "show", afterRestore: "keep", exclude: [] };
let renaming = null;
let menuSeq = 0;
let usingKeyboard = false;
let dragging = null;
addEventListener("keydown", () => { usingKeyboard = true; }, true);
addEventListener("pointerdown", () => { usingKeyboard = false; }, true);

const VIEW_KEY = "stashView";
let view = "stash";
try { view = localStorage.getItem(VIEW_KEY) || "stash"; } catch (e) { /* storage blocked: default view */ }

function say(text) { $("msg").textContent = text; }

function shortUrl(url) { return String(url).replace(/^https?:\/\/(www\.)?/, ""); }

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;

/* Mirrors reopenRoute in background.js: what a restore of this URL will actually open. */
const isWeb = url => /^(https?|ftp):/.test(url);
function kindOf(url) {
  if (isWeb(url) || url.startsWith(browser.runtime.getURL(""))) return "web";
  return /^file:/.test(url) ? "file" : "other";
}

function restored(r) {
  const parts = [`Reopened ${plural(r.restored, "tab")}`];
  if (r.viaHelper) parts.push(`${r.viaHelper} local through the helper`);
  if (r.standins) parts.push(`${r.standins} as stand-ins`);
  if (r.removed) parts.push("taken out of the stash");
  const fix = /not installed/.test(r.helperError || "") ? "; run native/install.zsh in the link-keeper repo once" : "";
  return parts.join(" · ") + (r.helperError ? ` — local files came back as stand-ins: ${r.helperError}${fix}` : "");
}

function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
// A stash is named after its time until renamed; only a real name is worth showing beside the time.
const renamed = s => s.name && s.name !== whenOf(s.created_at);

async function load() {
  const [{ sessions: all }, { settings: st }] = await Promise.all([send({ type: "sessions" }), send({ type: "stash-settings" })]);
  sessions = all;
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

/* Every URL that is in more than one stash, with the names of the stashes that hold it. */
function duplicates() {
  const where = new Map();
  for (const s of sessions) for (const t of s.tabs) {
    if (!where.has(t.url)) where.set(t.url, new Set());
    where.get(t.url).add(s);
  }
  return where;
}

/* --- row menu ---------------------------------------------------------------------
 * A native popover, as on the list page: Escape and outside clicks close it. It also carries
 * the keyboard's way to do what dragging does. */
function rowMenu(session, tab, index) {
  const id = `row-menu-${++menuSeq}`;
  const trigger = el("button", { className: "small ghost more", textContent: "⋯", title: "More actions" });
  const name = tab.title || shortUrl(tab.url);
  trigger.setAttribute("aria-label", `More actions for ${name.length > 80 ? `${name.slice(0, 80)}…` : name}`);
  trigger.setAttribute("popovertarget", id);

  const menu = el("div", { id, className: "menu" });
  menu.popover = "auto";
  const item = (text, fn, className = "", disabled = false) => {
    const b = el("button", { textContent: text, className, disabled });
    b.onclick = async () => { menu.hidePopover(); await fn(); };
    return b;
  };
  const locked = session.locked;
  const others = sessions.filter(s => s.id !== session.id).slice(0, 8);
  menu.append(
    item("Open", () => act({ type: "restore-stash", id: session.id, ids: [tab.id] }, restored)),
    isWeb(tab.url) && item("Move to list", () => act({ type: "move-stash", id: session.id, ids: [tab.id] },
      r => r.added ? "Moved to the list" : "Already on the list; taken out of the stash"), "", locked),
    el("hr"),
    item("Move up", () => moveTab(tab.id, session.id, session.tabs[index - 1]?.id), "", index === 0),
    item("Move down", () => moveTab(tab.id, session.id, session.tabs[index + 2]?.id || null), "", index === session.tabs.length - 1),
    ...others.map(s => item(`Move to ${s.name}`, () => moveTab(tab.id, s.id, null), "", locked)),
    el("hr"),
    item("Remove from stash", () => act({ type: "delete-stash", id: session.id, ids: [tab.id] }), "danger", locked),
  );
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

function moveTab(id, to, before) {
  return act({ type: "move-stashed", ids: [id], to, before });
}

/* --- drag and drop ----------------------------------------------------------------
 * A row dropped on the top half of another goes ahead of it, on the bottom half after it; dropped
 * on a stash's heading or the empty end of its list, it goes last. Out of a locked stash, nothing
 * drags. */
function clearDropMarks() {
  for (const n of document.querySelectorAll(".drop-before, .drop-after, .drop-end")) n.classList.remove("drop-before", "drop-after", "drop-end");
}

function dropTarget(node, session, beforeOf) {
  node.addEventListener("dragover", e => {
    if (!dragging) return;
    const spot = beforeOf(e);
    if (spot === undefined) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    node.classList.add(spot.mark);
  });
  node.addEventListener("dragleave", e => { if (!node.contains(e.relatedTarget)) node.classList.remove("drop-before", "drop-after", "drop-end"); });
  node.addEventListener("drop", e => {
    if (!dragging) return;
    const spot = beforeOf(e);
    if (spot === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragging.id;
    dragging = null;
    clearDropMarks();
    if (spot.before === id) return;
    moveTab(id, session.id, spot.before);
  });
}

function rowEl(session, tab, index, dups) {
  const li = el("li");
  if (tab.seen_at) li.classList.add("restored");
  if (tab.verdict === "drop") li.classList.add("dropped");
  li.append(srcIcon(tab.url));

  const main = el("div", { className: "main" });
  const a = el("a", { className: "ttl", href: tab.url, title: tab.url, draggable: false });
  if (tab.title) {
    a.classList.add("titled");
    a.textContent = tab.title;
  } else {
    a.classList.add("plain");
    a.textContent = shortUrl(tab.url);
  }
  // A plain click goes through the background so the entry is marked and the container kept;
  // middle-click and copy-link still behave as on any link.
  a.addEventListener("click", e => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    act({ type: "restore-stash", id: session.id, ids: [tab.id] }, restored);
  });
  main.append(a);

  const kind = kindOf(tab.url);
  const meta = el("div", { className: "meta" });
  if (kind === "web") meta.append(el("span", { textContent: hostOf(tab.url) }));
  if (kind === "file") {
    meta.append(el("span", { className: "badge", textContent: "Local file",
      title: "Reopened through Link Keeper's helper, or as a stand-in if the helper is not installed" }));
  }
  if (kind === "other") {
    meta.append(el("span", { className: "badge", textContent: "Stand-in",
      title: "Firefox will not let an extension open this page; restore opens a tab with the URL to paste" }));
  }
  if (tab.verdict === "keep") meta.append(el("span", { className: "badge keep", textContent: "✓ Kept" }));
  if (tab.verdict === "drop") meta.append(el("span", { className: "badge drop", textContent: "✕ Dropped" }));
  if (tab.container) meta.append(el("span", { className: "badge", textContent: "Container", title: tab.container }));
  const also = [...(dups.get(tab.url) || [])].filter(s => s.id !== session.id);
  if (also.length) {
    meta.append(el("span", { className: "badge dup", textContent: `Also in ${also.length === 1 ? "1 other stash" : `${also.length} other stashes`}`,
      title: also.map(s => s.name).join("\n") }));
  }
  if (tab.seen_at) meta.append(el("time", { dateTime: tab.seen_at, textContent: `restored ${whenOf(tab.seen_at)}` }));
  main.append(meta);
  li.append(main, el("div", { className: "acts" }, ...rowMenu(session, tab, index)));

  if (!session.locked) {
    li.draggable = true;
    li.addEventListener("dragstart", e => {
      dragging = { id: tab.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/uri-list", tab.url);
      e.dataTransfer.setData("text/plain", tab.url);
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => { dragging = null; li.classList.remove("dragging"); clearDropMarks(); });
  }
  dropTarget(li, session, e => {
    const r = li.getBoundingClientRect();
    const lower = e.clientY > r.top + r.height / 2;
    return lower ? { before: session.tabs[index + 1]?.id || null, mark: "drop-after" } : { before: tab.id, mark: "drop-before" };
  });
  return li;
}

function heading(session, shown) {
  const h2 = el("h2");
  if (session.starred) h2.append(el("span", { className: "star-mark", textContent: "★", title: "Starred" }));
  if (session.locked) h2.append(el("span", { className: "lock-mark", textContent: "Locked" }));
  if (renaming === session.id) {
    const input = el("input", { className: "rename", value: renamed(session) ? session.name : "", placeholder: whenOf(session.created_at) });
    input.setAttribute("aria-label", "Stash name");
    const finish = async save => {
      if (renaming !== session.id) return;
      renaming = null;
      if (save) await act({ type: "rename-stash", id: session.id, name: input.value });
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
    h2.append(el("span", { className: "name", textContent: session.name }));
    if (renamed(session)) h2.append(el("span", { className: "when", textContent: whenOf(session.created_at) }));
  }
  const count = shown === session.tabs.length ? plural(shown, "tab") : `${shown} of ${session.tabs.length}`;
  h2.append(el("span", { className: "n", textContent: count }));

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
  const n = session.tabs.length;
  const locked = session.locked;
  h2.append(el("div", { className: "gacts" },
    button("Restore all", "primary", settings.afterRestore === "remove" && !locked
      ? "Reopen every tab, unloaded until you switch to it, and take them out of the stash"
      : "Reopen every tab, unloaded until you switch to it; the stash stays",
    () => act({ type: "restore-stash", id: session.id }, restored)),
    button("Move to list", "", "Add these to the reading list and take them out of the stash",
      () => act({ type: "move-stash", id: session.id },
        r => `Moved ${r.moved} to the list${r.skipped ? ` (${r.skipped} were already on it)` : ""}` +
          (r.stayed ? ` · ${r.stayed} local or browser pages stay here` : "")), locked),
    button("Explore", "", "Browse this stash with a sidebar, details and a live preview",
      () => send({ type: "open-stash-cards", id: session.id })),
    toggle(session.starred ? "★ Starred" : "☆ Star", session.starred, "Starred stashes stay at the top",
      () => act({ type: "flag-stash", id: session.id, starred: !session.starred })),
    toggle(locked ? "Locked" : "Lock", locked, "A locked stash cannot lose a tab: no delete, remove or move out, and restoring keeps it",
      () => act({ type: "flag-stash", id: session.id, locked: !locked })),
    button("Rename", "ghost", "", () => { renaming = session.id; render(); }),
    button("Delete…", "ghost danger", locked ? "Unlock it first" : "Remove this stash; its tabs are closed, so this is their only record", () => {
      if (!confirm(`Delete this stash of ${plural(n, "tab")}? They are closed, so this removes the only record of them.`)) return;
      act({ type: "delete-stash", id: session.id }, () => `Deleted a stash of ${plural(n, "tab")}`);
    }, locked),
  ));
  dropTarget(h2, session, () => ({ before: null, mark: "drop-end" }));
  return h2;
}

/* Date headings for the day and month views; the stash view has none. */
function bucketOf(session) {
  const d = new Date(session.created_at);
  if (view === "day") return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (view === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return null;
}

function render() {
  const term = $("q").value.trim().toLowerCase();
  const total = sessions.reduce((sum, s) => sum + s.tabs.length, 0);
  $("sub").textContent = total
    ? `${plural(total, "tab")} in ${sessions.length === 1 ? "1 stash" : `${sessions.length} stashes`} · kept in Firefox bookmarks`
    : "Nothing stashed";
  $("export").disabled = !total;
  const dropped = sessions.reduce((n, s) => n + (s.locked ? 0 : s.tabs.filter(t => t.verdict === "drop").length), 0);
  $("clear-dropped").hidden = !dropped;
  $("clear-dropped").textContent = `Clear ${dropped} dropped…`;
  $("view").value = view;
  renderSettings();

  const out = $("out");
  out.textContent = "";
  if (!sessions.length) {
    out.append(el("div", { className: "empty" },
      el("p", { className: "title", textContent: "Nothing stashed yet" }),
      el("p", {}, "Stash folds the tabs you have selected, or the whole window, into a group here and closes them. ",
        el("kbd", { textContent: "⌃⇧S" }), " on a Mac, ", el("kbd", { textContent: "Alt+Shift+S" }), " elsewhere. ",
        "Right-click a tab for one tab, the tabs to its left or right, or every window.")));
    return;
  }

  // In the date views stashes go by date, starred or not.
  const ordered = view === "stash" ? sessions : [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const dups = duplicates();
  let anyShown = false, lastBucket = null;
  for (const session of ordered) {
    const tabs = term
      ? session.tabs.filter(t => `${t.title || ""} ${t.url}`.toLowerCase().includes(term))
      : session.tabs;
    if (!tabs.length && term) continue;
    anyShown = true;
    const bucket = bucketOf(session);
    if (bucket && bucket !== lastBucket) {
      out.append(el("h2", { className: "bucket", textContent: bucket }));
      lastBucket = bucket;
    }
    const ul = el("ul", { className: "rows stash" });
    for (const tab of tabs) ul.append(rowEl(session, tab, session.tabs.indexOf(tab), dups));
    dropTarget(ul, session, e => (e.target === ul ? { before: null, mark: "drop-end" } : undefined));
    const section = el("section", { className: `group${session.locked ? " locked" : ""}` }, heading(session, tabs.length), ul);
    out.append(section);
  }
  if (!anyShown) {
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No tab matches" })));
  }
}

/* --- settings ---------------------------------------------------------------------- */

function renderSettings() {
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

for (const r of document.querySelectorAll('input[name="after-stash"]')) {
  r.onchange = () => act({ type: "set-stash-settings", afterStash: r.value });
}
for (const r of document.querySelectorAll('input[name="after-restore"]')) {
  r.onchange = () => act({ type: "set-stash-settings", afterRestore: r.value });
}
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
  for (const id of ["settings-panel", "import-panel"]) $(id).hidden = id !== which || !$(id).hidden;
  $("settings").setAttribute("aria-expanded", String(!$("settings-panel").hidden));
  $("import").setAttribute("aria-expanded", String(!$("import-panel").hidden));
  if (!$("import-panel").hidden) $("import-text").focus();
}
$("settings").onclick = () => openPanel("settings-panel");

/* --- import ---------------------------------------------------------------------------- */

const FORMAT_NAMES = {
  "link-keeper": "a Link Keeper export", tidytab: "a TidyTab export", json: "a JSON list", csv: "CSV",
  onetab: "OneTab's Export URLs", text: "text with links in it",
};
let parsed = null;

function previewImport() {
  parsed = parseStashImport($("import-text").value);
  const n = parsed.stashes.reduce((sum, s) => sum + s.tabs.length, 0);
  const note = $("import-msg");
  note.className = "";
  if (!parsed.format) note.textContent = "Paste OneTab's Export URLs, a TidyTab or Link Keeper export, CSV with a url column, or any text with links.";
  else if (!n) { note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}, but found no links.`; note.className = "bad"; }
  else note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}: ${plural(n, "tab")} in ${plural(parsed.stashes.filter(s => s.tabs.length).length, "stash")}` +
    (parsed.skipped ? ` · ${plural(parsed.skipped, "line")} without a link skipped` : "") + ".";
  $("import-go").disabled = !n;
}

$("import").onclick = () => { openPanel("import-panel"); previewImport(); };
$("import-text").addEventListener("input", previewImport);
$("import-file").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  $("import-text").value = await file.text();
  previewImport();
};
$("import-cancel").onclick = () => { $("import-panel").hidden = true; $("import").setAttribute("aria-expanded", "false"); };
$("import-go").onclick = async () => {
  if (!parsed?.stashes.length) return;
  $("import-go").disabled = true;
  const res = await act({ type: "import-stashes", stashes: parsed.stashes },
    r => `Imported ${plural(r.tabs, "tab")} in ${plural(r.stashes, "stash")}`);
  if (res?.ok) {
    $("import-text").value = "";
    $("import-file").value = "";
    $("import-panel").hidden = true;
    $("import").setAttribute("aria-expanded", "false");
  } else previewImport();
};

/* --- page actions ------------------------------------------------------------------------ */

$("q").addEventListener("input", render);
$("view").onchange = () => {
  view = $("view").value;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* storage blocked: not remembered */ }
  render();
};

$("stash").onclick = () => act({ type: "stash" }, r =>
  `Stashed ${plural(r.stashed, "tab")}${r.why ? ` · left open: ${r.why}` : ""}`);

$("clear-dropped").onclick = () => {
  const n = sessions.reduce((sum, s) => sum + (s.locked ? 0 : s.tabs.filter(t => t.verdict === "drop").length), 0);
  if (!confirm(`Remove the ${n} tabs you dropped? They are closed, so this removes the only record of them. Locked stashes keep theirs.`)) return;
  act({ type: "clear-dropped" }, r => `Removed ${plural(r.removed, "dropped tab")}`);
};

$("export").onclick = () => {
  const a = document.createElement("a");
  const body = JSON.stringify({ exported_at: new Date().toISOString(), sessions }, null, 2);
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = `link-keeper-stashes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/* Stashes are bookmarks, so a change can come from Firefox's own library as well as from here; a
 * stash of forty tabs is forty events, taken as one. A rename in progress would lose its input to
 * a re-render, and a drag its row. */
let reloadTimer = null;
const reloadSoon = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (!renaming && !dragging) load(); else reloadSoon(); }, 150);
};
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stashMeta || changes.stashSettings)) reloadSoon();
});
for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) browser.bookmarks?.[ev].addListener(reloadSoon);

load();
