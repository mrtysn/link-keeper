/* Stashed tabs: every group of tabs folded away with Stash, newest first.
 *
 * A stash is the only record of the tabs it closed, so everything here is reversible except
 * Delete, which asks first. Restoring keeps the entries and marks them restored; Move to list
 * hands them to the worklist and takes them out of the stash.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

let sessions = [];
let renaming = null;
let menuSeq = 0;
let usingKeyboard = false;
addEventListener("keydown", () => { usingKeyboard = true; }, true);
addEventListener("pointerdown", () => { usingKeyboard = false; }, true);

function say(text) { $("msg").textContent = text; }

function shortUrl(url) { return String(url).replace(/^https?:\/\/(www\.)?/, ""); }

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
  const fix = /not installed/.test(r.helperError || "") ? "; run native/install.zsh in the link-keeper repo once" : "";
  return parts.join(" · ") + (r.helperError ? ` — local files came back as stand-ins: ${r.helperError}${fix}` : "");
}

function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function load() {
  ({ sessions } = await send({ type: "sessions" }));
  render();
}

async function act(msg, done) {
  const res = await send(msg);
  if (res && res.ok === false) say(res.error || "That did not work");
  else if (done) say(done(res));
  await load();
}

/* Row actions live in a native popover, as on the list page: Escape and outside clicks close it. */
function rowMenu(session, tab) {
  const id = `row-menu-${++menuSeq}`;
  const trigger = el("button", { className: "small ghost more", textContent: "⋯", title: "More actions" });
  const name = tab.title || shortUrl(tab.url);
  trigger.setAttribute("aria-label", `More actions for ${name.length > 80 ? `${name.slice(0, 80)}…` : name}`);
  trigger.setAttribute("popovertarget", id);

  const menu = el("div", { id, className: "menu" });
  menu.popover = "auto";
  const item = (text, fn, className = "") => {
    const b = el("button", { textContent: text, className });
    b.onclick = async () => { menu.hidePopover(); await fn(); };
    return b;
  };
  menu.append(
    item("Open", () => act({ type: "restore-stash", id: session.id, urls: [tab.url] }, restored)),
    ...(isWeb(tab.url) ? [item("Move to list", () => act({ type: "move-stash", id: session.id, urls: [tab.url] },
      r => r.added ? "Moved to the list" : "Already on the list; taken out of the stash"))] : []),
    el("hr"),
    item("Remove from stash", () => act({ type: "delete-stash", id: session.id, urls: [tab.url] }), "danger"),
  );
  menu.addEventListener("toggle", e => {
    if (e.newState !== "open") return;
    const r = trigger.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const below = r.bottom + 4 + h <= innerHeight;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    if (usingKeyboard) menu.querySelector("button")?.focus();
  });
  return [trigger, menu];
}

function rowEl(session, tab) {
  const li = el("li");
  if (tab.seen_at) li.classList.add("restored");
  li.append(srcIcon(tab.url));

  const main = el("div", { className: "main" });
  const a = el("a", { className: "ttl", href: tab.url, title: tab.url });
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
    act({ type: "restore-stash", id: session.id, urls: [tab.url] }, restored);
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
  if (tab.container) meta.append(el("span", { className: "badge", textContent: "Container", title: tab.container }));
  if (tab.seen_at) {
    const t = el("time", { dateTime: tab.seen_at, textContent: `restored ${whenOf(tab.seen_at)}` });
    meta.append(t);
  }
  main.append(meta);
  li.append(main, el("div", { className: "acts" }, ...rowMenu(session, tab)));
  return li;
}

function heading(session, shown) {
  const h2 = el("h2");
  if (renaming === session.id) {
    const input = el("input", { className: "rename", value: session.name || "", placeholder: whenOf(session.created_at) });
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
    h2.append(session.name || whenOf(session.created_at));
    if (session.name) h2.append(el("span", { className: "when", textContent: whenOf(session.created_at) }));
  }
  const count = shown === session.tabs.length ? plural(shown, "tab") : `${shown} of ${session.tabs.length}`;
  h2.append(el("span", { className: "n", textContent: count }));

  const button = (text, cls, title, fn) => {
    const b = el("button", { className: `small ${cls}`, textContent: text, title });
    b.onclick = fn;
    return b;
  };
  const n = session.tabs.length;
  h2.append(el("div", { className: "gacts" },
    button("Restore all", "primary", "Reopen every tab, unloaded until you switch to it; the stash stays",
      () => act({ type: "restore-stash", id: session.id }, restored)),
    button("Move to list", "", "Add these to the reading list and take them out of the stash",
      () => act({ type: "move-stash", id: session.id },
        r => `Moved ${r.moved} to the list${r.skipped ? ` (${r.skipped} were already on it)` : ""}` +
          (r.stayed ? ` · ${r.stayed} local or browser pages stay here` : ""))),
    button("Rename", "ghost", "", () => { renaming = session.id; render(); }),
    button("Delete…", "ghost danger", "Remove this stash; its tabs are closed, so this is their only record", () => {
      if (!confirm(`Delete this stash of ${plural(n, "tab")}? They are closed, so this removes the only record of them.`)) return;
      act({ type: "delete-stash", id: session.id }, () => `Deleted a stash of ${plural(n, "tab")}`);
    }),
  ));
  return h2;
}

function render() {
  const term = $("q").value.trim().toLowerCase();
  const total = sessions.reduce((sum, s) => sum + s.tabs.length, 0);
  $("sub").textContent = total
    ? `${plural(total, "tab")} in ${sessions.length === 1 ? "1 stash" : `${sessions.length} stashes`}`
    : "Nothing stashed";
  $("export").disabled = !total;

  const out = $("out");
  out.textContent = "";
  if (!sessions.length) {
    out.append(el("div", { className: "empty" },
      el("p", { className: "title", textContent: "Nothing stashed yet" }),
      el("p", {}, "Stash folds the tabs you have selected, or the whole window, into a group here and closes them. ",
        el("kbd", { textContent: "⌃⇧S" }), " on a Mac, ", el("kbd", { textContent: "Alt+Shift+S" }), " elsewhere.")));
    return;
  }

  let anyShown = false;
  for (const session of sessions) {
    const tabs = term
      ? session.tabs.filter(t => `${t.title || ""} ${t.url}`.toLowerCase().includes(term))
      : session.tabs;
    if (!tabs.length && term) continue;
    anyShown = true;
    const ul = el("ul", { className: "rows stash" });
    for (const tab of tabs) ul.append(rowEl(session, tab));
    out.append(el("section", { className: "group" }, heading(session, tabs.length), ul));
  }
  if (!anyShown) {
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No tab matches" })));
  }
}

$("q").addEventListener("input", render);

$("stash").onclick = () => act({ type: "stash" }, r =>
  `Stashed ${plural(r.stashed, "tab")}${r.why ? ` · left open: ${r.why}` : ""}`);

$("export").onclick = () => {
  const a = document.createElement("a");
  const body = JSON.stringify({ exported_at: new Date().toISOString(), sessions }, null, 2);
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = `link-keeper-stashes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

browser.storage.onChanged.addListener((changes, area) => {
  // A rename in progress would lose its input to a re-render.
  if (area === "local" && changes.sessions && !renaming) load();
});

load();
