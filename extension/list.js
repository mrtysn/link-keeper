/* Links: every link from the sources chosen in the top bar — stashed tabs, imports, the reading
 * list — one row per URL, grouped by stash, domain, tag, day or month, or in date order.
 *
 * Two view toggles, each remembered: Side by side (V) narrows the rows to a sidebar and shows the
 * selected link in full beside them — its capture, where else it is held, other links from its
 * site, and the live preview (P); Compact shows a row as its icon and title only, the default with
 * the pane. ?pane=1 opens with the pane,
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

const GROUPS = ["stash", "domain", "tag", "chat", "day", "month", "newest", "oldest"];
const GROUP_KEY = "listGroup";
/* Three switches that combine, each cycling through three states on a click (the first is off):
 * Captured: any web page, only captured ones, only ones not captured yet. Local & browser: included,
 * only them, left out. Filtered out: left out of the pile (as the rules in Settings say), included,
 * only them. */
const BAR = { captured: ["any", "only", "out"], local: ["in", "only", "out"], filtered: ["out", "in", "only"], dups: ["any", "only", "out"] };
// Links held in more than one place (duplicateSets), worked out on each render for the Duplicates switch.
let dupKeys = new Set();

let data = { links: [], stashes: [], all: { links: [], stashes: [] }, sources: new Set(), byKey: new Map() };
let settings = { afterStash: "show", exclude: [] };
const bar = { captured: "any", local: "in", filtered: "out", dups: "any" };
const barOn = () => Object.keys(BAR).some(k => bar[k] !== BAR[k][0]);
const domainSel = new Set();   // empty = every domain
const tagSel = new Set();      // empty = every tag; UNTAGGED = links with no tag set by hand
// A chip's second click leaves its site or tag out instead: everything except it.
const domainOut = new Set();
const tagOut = new Set();
const UNTAGGED = "\u0000untagged";
// Untagged links the tag model has suggestions for: the Cards page's Suggested deck, as a tag chip.
const SUGGESTED = "\u0000suggested";
const hasSuggestions = l => !l.tags.length && !!l.suggested?.length;
let domainsExpanded = false;
let tagsExpanded = false;
let renaming = null;
let dragging = null;

/* The view toggles, each remembered in this browser; storage that throws leaves the defaults. */
const COMPACT_KEY = "listCompact", COMPACT_PANE_KEY = "listCompactPane";
const pref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch (e) { return fallback; }
};
const setPref = (key, on) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch (e) { /* not remembered */ } };

/* The panes' widths, in px, remembered: the list on the left (--side-w) and the live preview on the
 * right (--pv-w). A grip between two panes drags its boundary; arrow keys move it while it has focus,
 * and a double-click puts it back. */
const GRIPS = [
  { grip: "pane-grip", pane: "out", prop: "--side-w", key: "listSideWidth", from: "left", min: 14, max: 0.6 },
  { grip: "pv-grip", pane: "preview", prop: "--pv-w", key: "listPreviewWidth", from: "right", min: 16, max: 0.6 },
];
function setPaneWidth(g, px, save = false) {
  const panes = $("panes"), rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  if (px == null) { panes.style.removeProperty(g.prop); try { localStorage.removeItem(g.key); } catch (e) { /* fine */ } return; }
  const w = Math.round(Math.max(g.min * rem, Math.min(px, panes.clientWidth * g.max)));
  panes.style.setProperty(g.prop, `${w}px`);
  $(g.grip).setAttribute("aria-valuenow", String(w));
  if (save) try { localStorage.setItem(g.key, String(w)); } catch (e) { /* not remembered */ }
}
for (const g of GRIPS) {
  const grip = $(g.grip), panes = $("panes");
  try { const w = Number(localStorage.getItem(g.key)); if (w) panes.style.setProperty(g.prop, `${w}px`); } catch (e) { /* default */ }
  const width = () => $(g.pane).getBoundingClientRect().width;
  grip.addEventListener("pointerdown", e => {
    if (e.button) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("resizing");
    const box = panes.getBoundingClientRect();
    const move = ev => setPaneWidth(g, g.from === "left" ? ev.clientX - box.left - 6 : box.right - ev.clientX - 6);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing");
      setPaneWidth(g, width(), true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("dblclick", () => setPaneWidth(g, null));
  grip.addEventListener("keydown", e => {
    const by = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    if (!by) return;
    e.preventDefault();
    e.stopPropagation();
    setPaneWidth(g, width() + by * (e.shiftKey ? 4 : 1) * (g.from === "left" ? 1 : -1), true);
  });
}
// The list and the selected link side by side, always.
const pane = true;
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
  if (params.get("stash")) { stashOnly = params.get("stash"); group = "stash"; }
  // ?tags opens the tag row (the Tags page's old address forwards here); ?tag=<name> also picks it.
  if (params.has("tags") || params.get("tag")) tagsExpanded = true;
  // ?cards turns card mode on: the Cards page's old address forwards here with it.
  if (params.has("cards")) setPref("listCards", true);
  if (params.get("tag")) tagSel.add(cleanTag(params.get("tag")));
  // Its own parameters are taken up and dropped from the address; any other (the preview's) stays.
  const own = ["group", "pane", "stash", "tags", "tag", "cards"];
  if (own.some(k => params.has(k))) {
    for (const k of own) params.delete(k);
    history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash);
  }
  if (group === "flat") group = "newest";
  if (!GROUPS.includes(group)) group = "domain";
}

const compactNow = () => (pane ? pref(COMPACT_PANE_KEY, true) : pref(COMPACT_KEY, false));
function applyView() {
  document.body.classList.toggle("pane", pane);
  document.body.classList.toggle("compact", compactNow());
  $("t-compact").setAttribute("aria-pressed", String(compactNow()));
  $("detail").hidden = !pane;
  fitPanes();
}
// The side panes stick 64px down and must end at the window's bottom edge. At scroll 0 they start
// lower than that (nav and filter bar above), so their height is what is left from where they are.
function fitPanes() {
  const panes = $("panes");
  if (!pane || !panes) return document.body.style.removeProperty("--pane-h");
  const top = Math.max(64, panes.getBoundingClientRect().top);
  document.body.style.setProperty("--pane-h", `${Math.max(160, window.innerHeight - top - 8)}px`);
}
new MutationObserver(() => fitPanes()).observe(document.body, { childList: true });
window.addEventListener("scroll", fitPanes, { passive: true });
window.addEventListener("resize", fitPanes);

/* A message in a fixed spot at the foot of the window, gone after a while; the page is too long to put it below the list. */
let sayTimer = null;
function say(text) {
  $("msg").textContent = text;
  clearTimeout(sayTimer);
  if (text) sayTimer = setTimeout(() => { $("msg").textContent = ""; }, 8000);
}

async function load() {
  const [d, { settings: st }, stored] = await Promise.all([loadLinks({ keepFiltered: true }), send({ type: "stash-settings" }), browser.storage.local.get(PREVIEW_KEY)]);
  // The pile, and apart from it the filtered-out links, which only the Filtered out filter shows.
  d.filteredLinks = d.links.filter(l => l.tags.includes(FILTER_TAG));
  d.links = d.links.filter(l => !l.tags.includes(FILTER_TAG));
  data = d;
  settings = st;
  previewMode = stored[PREVIEW_KEY] ? "keep" : previewMode === "keep" ? "off" : previewMode;
  render();
  await loadTrash();
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

/* Captured, for the filters and counts: a capture that read its page. A thin one (links.js capThin: almost
 * no text) counts as not captured, so Not captured shows it and Capture reads it again. */
const hasRead = l => !!l.cap && !l.cap.thin;

/* A web page's site; local files and browser pages have none, so they group under a name. */
const siteOf = url => ({ web: () => hostOf(url), file: () => "Local files", other: () => "Browser pages" })[kindOf(url)]();

function matches(link, term) {
  if (stashOnly === "list" ? !link.list : stashOnly && !link.copies.some(c => c.stash === stashOnly)) return false;
  if (bar.captured === "only" && !(isWeb(link.url) && hasRead(link))) return false;
  if (bar.captured === "out" && !(isWeb(link.url) && !hasRead(link))) return false;
  if (bar.local === "only" && isWeb(link.url)) return false;
  if (bar.local === "out" && !isWeb(link.url)) return false;
  if (bar.dups === "only" && !dupKeys.has(link.key)) return false;
  if (bar.dups === "out" && dupKeys.has(link.key)) return false;
  if (domainSel.size && !domainSel.has(siteOf(link.url))) return false;
  if (domainOut.has(siteOf(link.url))) return false;
  const hasTag = t => (t === UNTAGGED ? !link.tags.length : t === SUGGESTED ? hasSuggestions(link) : shownTags(link).tags.includes(t));
  if (tagSel.size && ![...tagSel].some(hasTag)) return false;
  if ([...tagOut].some(hasTag)) return false;
  if (!term) return true;
  const cap = link.cap;
  const hay = [link.url, link.title, labelOf(link), cap?.text, link.note, cap?.screenshot, link.date, ...shownTags(link).tags,
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

/* Where else a link is held: the other stashes holding it. Where it came from is the detail pane's. */
function whereBadges(link, ctx) {
  const out = [];
  if (ctx) {
    const also = link.copies.filter(c => c.stash !== ctx.stash.id).map(c => stashById(c.stash)).filter(Boolean);
    if (also.length) {
      out.push(el("span", { className: "badge dup", textContent: `Also in ${also.length === 1 ? "1 other stash" : `${also.length} other stashes`}`,
        title: also.map(stashName).join("\n") }));
      Peek.mark(out.at(-1), "held", link.key);
    }
    return out;
  }
  const held = link.copies.map(c => stashById(c.stash)).filter(Boolean);
  if (held.length > 1) {
    out.push(el("span", { className: "badge dup", textContent: `In ${held.length} stashes`, title: held.map(stashName).join("\n") }));
    Peek.mark(out.at(-1), "held", link.key);
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

/* --- selecting: tick links, tag or capture them together ----------------------------
 * Select puts a checkbox on every row; shift-click ticks the run between two. A link is ticked by its
 * key, so it stays ticked in every stash that shows it. The selection is the ticked links shown now: a
 * link a filter hides keeps its tick, but is left out of the count, Tag… and Capture until it shows
 * again (folded groups count as shown). Tag… adds one tag to all of them; Capture hands the ones not
 * captured yet to the capture queue. */

let selecting = false;
const ticked = new Set();
let lastTick = null;   // the row index of the last tick, the other end of a shift-click

// The ticked links shown now, by key.
function selectedKeys() {
  const shown = new Set(rowsOnPage.map(r => r.target.link.key));
  return [...ticked].filter(k => shown.has(k));
}

function paintSelectBar() {
  $("selbar").hidden = !selecting;
  $("t-select").setAttribute("aria-pressed", String(selecting));
  document.body.classList.toggle("selecting", selecting);
  const n = selectedKeys().length, hidden = ticked.size - n;
  $("sel-count").textContent = n ? `${plural(n, "link")} selected${hidden ? ` · ${hidden} more hidden by filters` : ""}`
    : hidden ? `${plural(hidden, "ticked link")} hidden by filters` : "Tick links to tag or capture them";
  $("sel-tag").disabled = $("sel-capture").disabled = !n;
  $("sel-clear").disabled = !ticked.size;
}

function paintTicks() {
  for (const r of rowsOnPage) {
    const box = r.li.querySelector(":scope > .tick");
    if (box) box.checked = ticked.has(r.target.link.key);
  }
  paintSelectBar();
}

function tickBox(li, link) {
  const box = el("input", { type: "checkbox", className: "tick", title: "Select this link; shift-click ticks the run since the last one" });
  box.setAttribute("aria-label", `Select ${labelOf(link) || shortUrl(link.url)}`.slice(0, 120));
  box.checked = ticked.has(link.key);
  box.addEventListener("pointerdown", e => e.stopPropagation());
  box.onclick = e => {
    e.stopPropagation();
    const at = rowsOnPage.findIndex(r => r.li === li);
    const run = e.shiftKey && lastTick !== null && rowsOnPage[lastTick]
      ? rowsOnPage.slice(Math.min(at, lastTick), Math.max(at, lastTick) + 1) : [rowsOnPage[at]];
    for (const r of run) box.checked ? ticked.add(r.target.link.key) : ticked.delete(r.target.link.key);
    lastTick = at;
    paintTicks();
  };
  return box;
}

function setSelecting(on) {
  selecting = on;
  if (!on) ticked.clear();
  lastTick = null;
  paintTicks();
}

/* Hands the ticked web links not captured yet, or captured thin (links.js capThin), to the capture queue.
 * It asks for every site first: a link may redirect anywhere, and reading the page it lands on needs
 * that site too. The prompt has to come straight from the click, so it is the first thing awaited. */
async function captureTicked() {
  const links = selectedKeys().map(k => data.links.find(l => l.key === k)).filter(l => l && /^https?:/.test(l.url));
  const urls = links.filter(l => !hasRead(l)).map(l => l.url);
  if (!urls.length) { say(links.length ? "Every ticked link is captured already" : "None of the ticked links is a web page"); return; }
  const granted = await browser.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  if (!granted) { say("Capturing needs access to the sites the links lead to; Firefox asks once"); return; }
  const res = await send({ type: "capture-queue-start", urls, speed: queueSpeed() });
  if (!res?.ok) { say(res?.error || "The capture queue did not start"); return; }
  const done = links.length - urls.length;
  say(`Queued ${plural(res.added, "link")} to capture${done ? `; ${done} captured already` : ""}`);
  setSelecting(false);
  showQueue(res);
}

/* --- the capture queue's line ----------------------------------------------------------
 * capture-queue.js runs the queue; this line shows it while it runs and after, until dismissed: how far
 * it is, the site it waits on and for how long, the sites it stopped, and each failed link with why. */
let queue = null;
let queueTick = null;
// The speed a queue runs at, remembered here for the next one: gentle, normal or fast (capture-queue.js, SPEEDS).
const SPEED_KEY = "captureSpeed";
const queueSpeed = () => { try { return localStorage.getItem(SPEED_KEY) || "normal"; } catch (e) { return "normal"; } };

function showQueue(q) {
  queue = q?.ok === false ? queue : q;
  paintQueue();
}

function queueText() {
  const q = queue;
  const failed = q.failed.length;
  const done = q.captured + q.skipped + failed;
  const head = { running: "Capturing", paused: "Capture paused", done: "Capture finished", stopped: "Capture stopped" }[q.status] || "Capture";
  const parts = [`${done} of ${q.total} done`, `${q.captured} captured`];
  if (q.skipped) parts.push(`${q.skipped} captured already`);
  if (failed) parts.push(`${failed} failed`);
  let wait = "";
  if (q.status === "running") {
    if (q.active.length) wait = `reading ${q.active.map(u => hostOf(u)).join(", ")}`;
    else if (q.next) wait = `next ${q.next.host} in ${Math.max(0, Math.ceil((q.next.at - Date.now()) / 1000))} s`;
  }
  return [head, parts.join(" · "), wait];
}

function paintQueue() {
  const box = $("capq");
  clearInterval(queueTick);
  queueTick = null;
  const wasHidden = box.hidden;
  if (!queue?.status || queue.status === "idle") {
    box.hidden = true;
    if (!wasHidden) fitPanes();
    return;
  }
  const [head, counts, wait] = queueText();
  const button = (label, type, title) => {
    const b = el("button", { type: "button", className: "small", textContent: label, title });
    b.onclick = async () => showQueue(await send({ type }));
    return b;
  };
  const acts = el("span", { className: "acts" });
  if (["running", "paused"].includes(queue.status)) {
    const pace = el("select", { className: "small", title: "Gentle: one link at a time, every wait doubled. Fast: three at a time, waits halved" });
    pace.setAttribute("aria-label", "Capture speed");
    for (const [value, label] of [["gentle", "Gentle"], ["normal", "Normal"], ["fast", "Fast"]]) pace.append(el("option", { value, textContent: label }));
    pace.value = queue.speed || "normal";
    pace.onchange = async () => {
      try { localStorage.setItem(SPEED_KEY, pace.value); } catch (e) { /* remembered for this run only */ }
      showQueue(await send({ type: "capture-queue-speed", speed: pace.value }));
    };
    acts.append(pace);
  }
  if (queue.status === "running") acts.append(button("Pause", "capture-queue-pause", "Finish the pages loading now, then wait"));
  if (queue.status === "paused") acts.append(button("Resume", "capture-queue-resume", "Carry on with the links still waiting"));
  if (["running", "paused"].includes(queue.status)) acts.append(button("Stop", "capture-queue-stop", "Drop the links still waiting; what was captured stays"));
  if (queue.failed.length) acts.append(button("Retry failed", "capture-queue-retry", "Put the failed links back in line, their sites no longer stopped"));
  if (["done", "stopped"].includes(queue.status)) acts.append(button("Dismiss", "capture-queue-dismiss", "Clear this line"));
  const waitNode = el("span", { className: "wait", textContent: wait });
  box.replaceChildren(el("b", { className: "what", textContent: head }), el("span", { textContent: counts }), waitNode, acts);
  const stopped = Object.entries(queue.stoppedSites || {});
  if (queue.failed.length) {
    const list = el("ul");
    for (const f of queue.failed) list.append(el("li", { textContent: `${f.url} — ${f.error}` }));
    const sum = `${plural(queue.failed.length, "failed link")}${stopped.length ? ` · stopped ${stopped.map(([h]) => h).join(", ")}` : ""}`;
    box.append(el("details", {}, el("summary", { textContent: sum }), list));
  }
  box.hidden = false;
  if (wasHidden) fitPanes();
  // The wait counts down between the queue's own changes.
  if (queue.status === "running" && !queue.active.length && queue.next) queueTick = setInterval(() => { waitNode.textContent = queueText()[2]; }, 1000);
}

async function loadQueue() {
  showQueue(await send({ type: "capture-queue-status" }));
}
browser.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.captureQueue) loadQueue(); });

function bulkTagPopover(anchor) {
  const urls = selectedKeys().map(k => data.links.find(l => l.key === k)?.url).filter(Boolean);
  if (!urls.length) return;
  const input = el("input", { type: "text", placeholder: `tag ${plural(urls.length, "link")}, Enter`, autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", `Tag ${plural(urls.length, "link")}`);
  const palette = el("div", { className: "palette", role: "group" });
  palette.setAttribute("aria-label", "Tags to pick");
  const box = el("div", { className: "tagger" }, input, palette);
  const apply = async tag => {
    const name = cleanTag(tag);
    if (!name) return;
    const res = await send({ type: "tag-links", urls, tags: [name] });
    pop.dispatchEvent(new Event("tagdone"));
    say(res?.ok ? `Tagged ${plural(res.tagged, "link")} ${name}` : res?.error || "That did not work");
    await load();
  };
  const draw = () => {
    const q = input.value.toLowerCase().replace(/[^a-z0-9]/g, "");
    palette.textContent = "";
    for (const t of tagPool().filter(n => !q || n.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q))) {
      const b = el("button", { type: "button", className: "tag pick", title: `Tag ${plural(urls.length, "link")} ${t}` }, t);
      b.style.setProperty("--h", tagHue(t));
      b.addEventListener("pointerdown", e => e.preventDefault());
      b.onclick = () => apply(t);
      palette.append(b);
    }
  };
  input.oninput = draw;
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); apply(input.value); } };
  draw();
  const pop = anchoredPopover(anchor, box);
}

/* The row's place counted in links, not rows: a link held in two stashes is one link, so the pane
 * counts the same total as the page's header. */
function linkNumber(i) {
  const seen = new Set();
  for (const r of rowsOnPage.slice(0, i + 1)) seen.add(r.target.link.key);
  return seen.size;
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
    const inPane = pane && document.querySelector(`#detail .lk-bar [data-cmd="${cmd}"]`);
    const anchor = inPane || (cmd === "tags" && li.querySelector(".tagedit")) || li.querySelector(".lk-bar .more") || li;
    LinkActions.key(cmd, target, anchor);
  };
}

/* After an action: anything that takes the row away (or a capture under Not captured) moves the
 * cursor on; then the page reloads with the cursor where it now is. */
LinkActions.setup({
  data: () => data,
  say,
  // In card mode the editor opens over the card, which redraws with each tag saved.
  tags: (t, anchor) => (cardMode ? anchoredPopover($("detail").querySelector(".cm-card.top .cm-head") || anchor, tagEditor(t.link, () => load()))
    : $("detail").querySelector(".tagger input")?.focus()),
  tagNext: () => { walk(1); onRow("tags")(); },
  // A removal shows at once: its row dims and the Remove button says so, until the reload redraws them.
  before(cmd, target, opts) {
    if (cmd !== "remove") return;
    const stash = opts.fromList ? null : target.stash || LinkActions.copyOf?.(target)?.stash || null;
    for (const r of rowsOnPage) {
      if (r.target.link.key === target.link.key && (r.target.stash?.id || null) === (stash?.id || null)) r.li.classList.add("leaving");
    }
    for (const b of $("detail").querySelectorAll('.lk-bar > button[data-cmd="remove"]')) { b.textContent = "Removing…"; b.disabled = true; }
  },
  async after(cmd, target, res) {
    if (res.ok === false) { if (cmd === "remove") render(); return; }
    // In card mode, accepting a card's suggested tags deals the next card, as removing does.
    const leaves = ["move", "remove", ...(cardMode ? ["accept"] : [])].includes(cmd);
    const i = cursorAt();
    if (i !== -1 && rowsOnPage[i].target.link.key === target?.link.key && (leaves || (cmd === "read" && bar.captured === "out"))) {
      const next = cardMode ? cardAfter(rowsOnPage[i]) : rowsOnPage[i + 1] || rowsOnPage[i - 1];
      if (next) cursorId = next.id;
      if (cardMode && cmd === "remove") cardTally.removed++;
    }
    if (cmd === "undo" && res.cmd === "remove") cardTally.removed = Math.max(0, cardTally.removed - 1);
    if (res.local) render();
    else await load();
    // In card mode an undone removal or accept comes back on top, where it was dealt.
    if (cardMode && cmd === "undo" && ["remove", "accept"].includes(res.cmd) && target) {
      const back = rowsOnPage.find(r => r.target.link.key === target.link.key && (!target.stash || r.target.stash?.id === target.stash.id));
      if (back) cursorId = back.id;
    }
    setCursor(cursorId);
  },
});

LinkKeys.listen({
  prev: () => (cardMode ? cardStep(-1) : walk(-1)), next: () => (cardMode ? cardSkip() : walk(1)),
  "group-prev": () => jumpSection(-1), "group-next": () => jumpSection(1),
  read: onRow("read"), open: onRow("open"),
  tags: onRow("tags"), accept: onRow("accept"), move: onRow("move"), remove: () => (cardMode ? cardRemove() : onRow("remove")()),
  undo: () => LinkActions.undo(), filter: () => $("q").focus(),
  preview: () => { setPreview(previewShowing(detailLink()) ? "off" : "this"); },
  escape: () => { document.querySelector(".tagpop")?.remove(); },
}, { labels: { "group-prev": "◂ section", "group-next": "section ▸" } });
// The Keys toggle shows or hides the key guide, and says whether it is showing.
$("t-keys").onclick = () => LinkKeys.toggleGuide();
const paintKeysToggle = () => $("t-keys").setAttribute("aria-pressed", String(!!document.getElementById("key-guide")));
new MutationObserver(paintKeysToggle).observe(document.body, { childList: true });
paintKeysToggle();

// Space and ⇧Space scroll a long detail pane.
addEventListener("keydown", e => {
  if (!pane || e.key !== " " || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
  e.preventDefault();
  $("detail").scrollBy({ top: (e.shiftKey ? -1 : 1) * $("detail").clientHeight * 0.8, behavior: "smooth" });
});

/* What only this page adds to a row's ⋯ menu: opening a link that is in no stash in this tab, and moving a
 * stashed one up or down its stash. Everything else is the shared bar's. */
function rowExtras(link, ctx) {
  const items = [];
  if (link.list && isWeb(link.url)) {
    items.push({ text: "Open in this tab", run: () => send({ type: "set-current", url: link.url }).then(() => browser.tabs.update({ url: link.url })) });
  }
  if (ctx) {
    const { stash, index } = ctx;
    items.push(
      { text: "Move up", disabled: index === 0, run: () => moveTab(ctx.tab.id, stash.id, stash.tabs[index - 1]?.id) },
      { text: "Move down", disabled: index === stash.tabs.length - 1, run: () => moveTab(ctx.tab.id, stash.id, stash.tabs[index + 2]?.id || null) });
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
  } else if (!text && link.preview?.text && !squash(labelOf(link)).includes(squash(link.preview.text).slice(0, 60))) {
    // Not captured: its preview's line says what it is (Compact hides it, as it hides the body).
    main.append(el("div", { className: "body", textContent: link.preview.text }));
  }
  if (link.preview?.image) main.append(el("img", { className: "rowthumb", src: link.preview.image, alt: "", loading: "lazy" }));

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
    t.title = link.list?.saved_at ? "Saved on this date" : link.list ? "Added on this date; the original date is unknown" : "Stashed on this date";
    meta.append(t);
  }
  if (cap?.kind && cap.kind !== "page") meta.append(el("span", { textContent: cap.kind }));
  const read = readBadge(link);
  if (read) meta.append(read);
  if (link.list?.current) meta.append(el("span", { className: "badge current", textContent: "Current" }));
  meta.append(...whereBadges(link, ctx));
  const container = ctx ? ctx.tab.container : link.copies.find(c => c.container)?.container;
  if (container) meta.append(el("span", { className: "badge", textContent: "Container", title: container }));
  if (link.note) meta.append(el("span", { className: "note", textContent: link.note }));
  const chips = tagChips(link);
  if (chips) meta.append(chips);
  meta.append(tagButton(link, () => render()));
  main.append(meta);
  const agent = agentRow(link);
  if (agent) main.append(agent);

  if (cap?.links?.length) {
    main.append(el("div", { className: "inner" }, ...cap.links.slice(0, 5).map(url => linkChip(url, shortUrl(url), url))));
  }
  // How many replies were kept, and the links among them — the author's own reply is the one that usually matters.
  if (cap?.reply_links?.length || cap?.reply_count) {
    main.append(el("div", { className: "inner replies" }, cap.reply_count ? el("span", { className: "badge", textContent: `${cap.reply_count} ${cap.reply_count === 1 ? "reply" : "replies"} kept` }) : null, ...(cap.reply_links || []).slice(0, 6).map(l => linkChip(l.href, `↩ ${shortUrl(l.href)}`,
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
  li.prepend(tickBox(li, link));

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
 * after it; dropped on a stash's heading or the empty end of its list, it goes last. */

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
  li.draggable = true;
  li.addEventListener("dragstart", e => {
    dragging = { id: tab.id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/uri-list", link.url);
    e.dataTransfer.setData("text/plain", link.url);
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => { dragging = null; li.classList.remove("dragging"); clearDropMarks(); });
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

  // Every action is under ⋯, so a heading is its name and count.
  h2.append(el("div", { className: "gacts" },
    ...popoverMenu("⋯", `Actions for the stash ${stashName(stash)}`, [
      { text: "Open all", title: "Reopen every tab, unloaded until you switch to it; the stash stays",
        run: () => act({ type: "restore-stash", id: stash.id }, restoredText) },
      "-",
      { text: "Rename", run: () => { renaming = stash.id; render(); } },
      { text: "Tag all tabs…", title: "Add one tag to every tab in this stash",
        run: () => tagAdder(h2, `Tag all ${plural(n, "tab")} of ${stashName(stash)}`,
          t => act({ type: "tag-stash", id: stash.id, tags: [t] }, r => `Tagged ${plural(r.tagged, "tab")} ${t}`)) },
      "-",
      { text: "Delete…", className: "danger", title: "Remove this stash; its tabs are closed, so this is their only record",
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

function section(title, count, rows, extraClass = "", sub = "") {
  const s = el("section", { className: `group${extraClass}` });
  s.dataset.key = title || "";
  if (title) s.append(el("h2", {}, el("span", { className: "name", textContent: title }), ...(sub ? [el("span", { className: "when", textContent: sub })] : []), el("span", { className: "n", textContent: count })));
  s.append(el("ul", { className: "rows" }, ...rows));
  return s;
}

function renderByStash(out, visible, term) {
  const filtering = !!(term || barOn() || domainSel.size || tagSel.size || domainOut.size || tagOut.size);
  const show = new Set(visible.map(l => l.key));
  let any = false;
  for (const stash of data.stashes) {
    if (stashOnly && stash.id !== stashOnly) continue;
    const rows = stash.tabs.map((tab, index) => ({ tab, index, link: data.byKey.get(tab.key) })).filter(r => r.link && show.has(r.link.key));
    if (!rows.length && filtering) continue;
    any = true;
    const ul = el("ul", { className: "rows stash" }, ...rows.map(r => safeRow(r.link, { stash, tab: r.tab, index: r.index })));
    dropTarget(ul, stash, e => (e.target === ul ? { before: null, mark: "drop-end" } : undefined));
    const sec = el("section", { className: "group" }, stashHeading(stash, rows.length), ul);
    sec.dataset.key = stash.id;
    out.append(sec);
  }
  // The links in no stash shown, after the stashes.
  const listOnly = stashOnly && stashOnly !== "list" ? [] : visible.filter(l => l.list && !l.copies.some(c => visibleStash(c.stash))).sort(byNewest);
  if (listOnly.length) {
    any = true;
    out.append(section("Not in a stash", listOnly.length, listOnly.map(l => safeRow(l, null)), " list-group"));
  }
  return any;
}

const NO_CHAT = "Not from a chat";

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
  if (group === "chat") {
    // A link shows under each thread it came from, labelled with the account when one is known; the rest go last.
    const buckets = new Map();
    for (const l of [...visible].sort(byNewest)) {
      for (const t of l.origin?.thread?.length ? l.origin.thread : [NO_CHAT]) {
        if (!buckets.has(t)) buckets.set(t, { links: [], account: null });
        const b = buckets.get(t);
        b.links.push(l);
        b.account ||= l.origin?.account || null;
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => (a[0] === NO_CHAT) - (b[0] === NO_CHAT) || b[1].links.length - a[1].links.length || a[0].localeCompare(b[0]))
      .map(([name, b]) => [name, b.links, b.account || ""]);
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
/* A row of chips under a toggle that shows it whole or as one line. Selected chips come first, so
 * they stay in sight on the collapsed line; Clear sits beside the toggle for the same reason. */
/* Three small dots on a three-state control, the current state's filled: what a click cycles through,
 * so the next state is never a surprise. */
function stateDots(at, n = 3) {
  const d = el("span", { className: "tri-dots" });
  d.setAttribute("aria-hidden", "true");
  for (let i = 0; i < n; i++) d.append(el("i", { className: i === at ? "on" : "" }));
  return d;
}

/* A Sites or Tags chip cycles: off → only it → everything except it → off. */
function cycleChip(id, only, except) {
  if (only.has(id)) { only.delete(id); except.add(id); }
  else if (except.has(id)) except.delete(id);
  else only.add(id);
}
function markChip(b, id, only, except) {
  b.setAttribute("aria-pressed", String(only.has(id)));
  b.classList.toggle("excluded", except.has(id));
  b.title = only.has(id) ? "Showing only these · next click: everything except them" : except.has(id) ? "Left out · next click: clear" : "Next click: show only these";
}

function chipRow(box, label, expanded, flip, chips, selected, clear) {
  const chev = el("span", { className: "chev" });
  chev.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const toggle = el("button", { className: "rowtoggle" }, label, chev);
  Object.assign(toggle, {
    title: expanded ? "Show one line" : "Show them all" });
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.onclick = flip;
  box.classList.toggle("collapsed", !expanded);
  box.append(toggle);
  if (selected.size) {
    const x = el("button", { className: "chip ghost", textContent: `Clear ${label.toLowerCase()}` });
    x.onclick = clear;
    box.append(x);
  }
  box.append(...chips);
}

function renderDomainChips() {
  const box = $("domains");
  box.textContent = "";
  const counts = new Map();
  const captured = new Map();   // per web site, how many of its links are captured
  for (const l of data.links) {
    const h = siteOf(l.url);
    counts.set(h, (counts.get(h) || 0) + 1);
    if (isWeb(l.url) && hasRead(l)) captured.set(h, (captured.get(h) || 0) + 1);
  }
  const rank = h => (domainSel.has(h) ? 2 : domainOut.has(h) ? 1 : 0);
  const hosts = [...counts.entries()].sort((a, b) => (rank(b[0]) - rank(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]));
  const chip = (host, n) => {
    const icon = host === "Local files" ? srcIcon("file:///") : host === "Browser pages" ? srcIcon("about:blank") : srcIcon(`https://${host}/`);
    // A web site with links left to capture counts them as captured of all: 12/132.
    const web = host !== "Local files" && host !== "Browser pages";
    const c = captured.get(host) || 0;
    const count = web && c < n ? `${c}/${n}` : String(n);
    const b = el("button", { className: "chip" }, icon, el("span", { className: "lbl", textContent: host }), el("span", { className: "n", textContent: count }));
    markChip(b, host, domainSel, domainOut);
    if (web) b.title = `${c} of ${plural(n, "link")} captured · ${b.title}`;
    Peek.mark(b, "site", host);
    b.onclick = () => { cycleChip(host, domainSel, domainOut); render(); };
    return b;
  };
  // Opening or closing a row redraws that row only: a full render rebuilds every link row.
  chipRow(box, "Sites", domainsExpanded, () => { domainsExpanded = !domainsExpanded; renderDomainChips(); },
    hosts.map(([host, n]) => chip(host, n)), new Set([...domainSel, ...domainOut]), () => { domainSel.clear(); domainOut.clear(); render(); });
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
    const b = el("button", { className: "chip tagchip" }, node ? el("span", { className: "lbl" }, node) : el("span", { className: "lbl", textContent: label }), el("span", { className: "n", textContent: n }));
    markChip(b, id, tagSel, tagOut);
    b.onclick = () => { cycleChip(id, tagSel, tagOut); render(); };
    return b;
  };
  for (const t of tagSel) if (t !== UNTAGGED && t !== SUGGESTED && !counts.has(t)) counts.set(t, 0);   // a picked tag stays in the row
  const hand = new Set(data.links.flatMap(l => l.tags));
  const chips = [];
  if (untagged) chips.push(chip(UNTAGGED, "Untagged", untagged));
  const suggested = data.links.filter(hasSuggestions).length;
  if (suggested) chips.push(chip(SUGGESTED, "Suggested", suggested));
  const ordered = [...counts.entries()].sort((a, b) => (tagSel.has(b[0]) - tagSel.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [t, n] of ordered) chips.push(chip(t, t, n, tagChip(t, !hand.has(t), "Suggested, not on any link as a tag yet")));
  if (tagSel.has(UNTAGGED)) chips.sort((a, b) => (b.getAttribute("aria-pressed") === "true") - (a.getAttribute("aria-pressed") === "true"));
  chips.unshift(newTagChip());
  chipRow(box, "Tags", tagsExpanded, () => { tagsExpanded = !tagsExpanded; renderTagChips(); }, chips, new Set([...tagSel, ...tagOut]), () => { tagSel.clear(); tagOut.clear(); render(); });
}

/* The tag bar, under the tag chips: a new tag, and with one tag picked, that tag's tools — its count
 * in each layer (yours, the model's suggestions, the site's guesses), making it yours on the links it
 * is only suggested for, rename, merge into another, colour and delete. Tags used to be their own page. */
const HUES = [0, 25, 45, 90, 140, 170, 195, 215, 250, 280, 310, 335];
function hueRow(current, onPick) {
  const row = el("div", { className: "hues", role: "group" });
  row.setAttribute("aria-label", "Colour");
  const auto = el("button", { type: "button", className: "auto", title: "A colour chosen from its name" });
  auto.setAttribute("aria-pressed", String(current == null));
  auto.onclick = () => onPick(null);
  row.append(auto);
  for (const h of HUES) {
    const b = el("button", { type: "button", title: `Hue ${h}` });
    b.style.setProperty("--h", h);
    b.setAttribute("aria-pressed", String(current === h));
    b.onclick = () => onPick(h);
    row.append(b);
  }
  return row;
}

function renderTagBar() {
  const bar = $("tagbar");
  bar.textContent = "";
  const picked = [...tagSel].filter(t => t !== UNTAGGED && t !== SUGGESTED);
  const one = picked.length === 1 && tagSel.size === 1 ? picked[0] : null;
  bar.hidden = !one;
  if (bar.hidden) return;

  {
    const layers = { own: [], suggested: [], site: [] };
    for (const l of data.links) {
      const s = shownTags(l);
      if (s.tags.includes(one)) layers[s.from].push(l);
    }
    const others = [...new Set([...TAG_LIB.names, ...data.links.flatMap(l => shownTags(l).tags)])].filter(t => t !== one).sort();
    const rename = el("button", { type: "button", className: "small", textContent: "Rename" });
    rename.onclick = () => {
      const input = el("input", { type: "text", value: one, className: "rename-tag" });
      input.setAttribute("aria-label", `Rename ${one}`);
      const done = async keep => {
        if (!input.isConnected) return;
        const to = input.value.toLowerCase().replace(/\s+/g, " ").trim();
        if (!keep || !to || to === one) return render();
        const merging = others.includes(to);
        const res = await renameTagUndoably(one, to, merging, layers.own.length);
        if (!res) return render();
        if (!res.ok) return say(res.error || "Unable to rename it");
        tagSel.clear(); tagSel.add(to);
        say(`${merging ? "Merged" : "Renamed"} ${one} → ${to} on ${plural(res.links, "link")} · ⌘Z undoes it`);
        await load();
      };
      input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
      input.addEventListener("blur", () => done(true));
      rename.replaceWith(input);
      input.focus();
      input.select();
    };
    const merge = el("select", { title: "Give its links another tag instead, and delete this one" },
      el("option", { value: "", textContent: "Merge into…" }), ...others.map(t => el("option", { value: t, textContent: t })));
    merge.setAttribute("aria-label", `Merge ${one} into another tag`);
    merge.onchange = async () => {
      const to = merge.value;
      if (!to) return;
      const res = await renameTagUndoably(one, to, true, layers.own.length);
      if (!res) { merge.value = ""; return; }
      if (!res.ok) return say(res.error || "Unable to merge it");
      tagSel.clear(); tagSel.add(to);
      say(`Merged ${one} into ${to} on ${plural(res.links, "link")} · ⌘Z undoes it`);
      await load();
    };
    const del = el("button", { type: "button", className: "small danger", textContent: "Delete" });
    del.onclick = async () => {
      const res = await deleteTagUndoably(one, layers.own.length);
      if (!res) return;
      if (!res.ok) return say(res.error || "Unable to delete it");
      tagSel.clear();
      say(`Deleted ${one}${res.links ? ` from ${plural(res.links, "link")}; the links stay` : ""} · ⌘Z puts it back`);
      await load();
    };
    const colours = hueRow(TAG_LIB.hue.has(one) ? TAG_LIB.hue.get(one) : null, async h => {
      const res = await send({ type: "recolor-tag", tag: one, hue: h });
      if (!res?.ok) say(res?.error || "Unable to recolour it");
      await load();
    });
    const loose = [...layers.suggested, ...layers.site];
    const adopt = loose.length && el("button", { type: "button", className: "small",
      textContent: `Make it yours on ${plural(loose.length, "link")}`,
      title: `Give the ${loose.length} links it is only suggested or guessed for the tag ${one} as yours; their other suggestions stop showing` });
    if (adopt) adopt.onclick = async () => {
      const res = await send({ type: "tag-links", urls: loose.map(l => l.url), tags: [one] });
      say(res?.ok ? `Tagged ${plural(res.tagged, "link")} ${one}` : res?.error || "Unable to tag them");
      await load();
    };
    bar.append(el("div", { className: "tb-tag" }, tagChip(one),
      el("span", { className: "tb-count", textContent: `${layers.own.length} yours · ${layers.suggested.length} suggested · ${layers.site.length} guessed from the site` }),
      adopt || "", el("span", { className: "tb-tools" }, rename, merge, del)), colours);
  }

}

/* "+ New tag", first in the Tags row so it shows with the row folded: it turns into a name field;
 * Enter makes the tag and picks it, so the tag bar offers its colour; Escape or leaving drops it. */
function newTagChip() {
  const b = el("button", { type: "button", className: "chip ghost tb-newtag", textContent: "+ New tag" });
  b.onclick = () => {
    const name = el("input", { type: "text", placeholder: "New tag name, Enter", className: "tb-new" });
    name.setAttribute("aria-label", "New tag name");
    const form = el("form", { className: "tb-make" }, name);
    form.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") form.replaceWith(b);
    });
    name.addEventListener("blur", () => { if (!name.value.trim() && form.isConnected) form.replaceWith(b); });
    form.onsubmit = async e => {
      e.preventDefault();
      const res = await send({ type: "create-tag", name: name.value, hue: null });
      if (!res?.ok) return say(res?.error ? res.error[0].toUpperCase() + res.error.slice(1) : "Unable to make it");
      tagSel.clear(); tagSel.add(res.tag);
      say(`Made ${res.tag}. Press T on a link to add it.`);
      await load();
    };
    b.replaceWith(form);
    name.focus();
  };
  return b;
}

/* Each switch shows its state: its name and count, ticked when narrowing to it, struck through when
 * leaving it out; the title says what the next click does. A switch keeps the width of its widest
 * state (every state is drawn in one cell, all but the current one hidden), so clicking it never
 * reflows the bar: "Not captured", bold and ticked, would push the view toggles onto a second row. */
const MARKS = { only: "✓", in: "+", out: "✕" };
function drawBar(counts) {
  const look = {
    captured: { any: ["", "Captured", counts.captured, "Show only captured pages"], only: ["only", "Captured", counts.captured, "Show only pages not captured yet"],
      out: ["only", "Not captured", counts.uncaptured, "Show every page again"] },
    local: { in: ["", "Local & browser", counts.local, "Show only local files and browser pages"], only: ["only", "Local & browser", counts.local, "Leave local files and browser pages out"],
      out: ["out", "Local & browser", counts.local, "Bring local files and browser pages back"] },
    filtered: { out: ["", "Filtered out", counts.filtered, "Include the filtered-out pages too"], in: ["in", "Filtered out", counts.filtered, "Show only the filtered-out pages"],
      only: ["only", "Filtered out", counts.filtered, "Leave the filtered-out pages out again"] },
    dups: { any: ["", "Duplicates", counts.dups, "Show only links held in more than one place, with the tools to remove copies"],
      only: ["only", "Duplicates", counts.dups, "Leave the duplicated links out"], out: ["out", "Duplicates", counts.dups, "Show every link again"] },
  };
  for (const k of Object.keys(BAR)) {
    const [state, label, n, next] = look[k][bar[k]];
    const b = $(`f-${k}`);
    b.dataset.state = state || "0";
    b.setAttribute("aria-pressed", String(!!state));
    b.title = `Next click: ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
    const face = (st, lbl, count) => el("span", { className: "face" },
      ...(MARKS[st] ? [el("span", { className: "mark", textContent: MARKS[st] }), " "] : []),
      el("span", { className: "lbl", textContent: lbl }), " ", el("span", { className: "n", textContent: count }));
    const ghosts = Object.values(look[k]).map(([st, lbl, count]) => {
      const g = face(st, lbl, count);
      g.classList.add("ghost");
      g.setAttribute("aria-hidden", "true");
      return g;
    });
    b.replaceChildren(el("span", { className: "faces" }, face(state, label, n), ...ghosts), stateDots(BAR[k].indexOf(bar[k])));
  }
}

function cycleBar(k) {
  const states = BAR[k];
  bar[k] = states[(states.indexOf(bar[k]) + 1) % states.length];
  // Only duplicates: their removal tools open under the bar; leaving that state closes them.
  if (k === "dups" && (bar.dups === "only") === $("dups-panel").hidden) openPanel("dups-panel");
}

function clearFilters() {
  $("q").value = "";
  domainSel.clear();
  tagSel.clear();
  domainOut.clear();
  tagOut.clear();
  for (const k of Object.keys(BAR)) bar[k] = BAR[k][0];
  render();
}

/* --- render ------------------------------------------------------------------------------- */

/* With ?stash=<id>, a banner saying so; closing it shows everything again. */
function renderOnly() {
  const box = $("only");
  box.textContent = "";
  const name = stashOnly === "list" ? "the links in no stash" : stashOnly && stashById(stashOnly) ? stashName(stashById(stashOnly)) : null;
  box.hidden = !name;
  if (!name) return;
  const b = el("button", { type: "button", title: "Show every stash again" }, `Only ${name} ×`);
  b.onclick = () => { stashOnly = null; render(); };
  box.append(b);
}

/* In the list beside the pane, the section you are in keeps its heading at the top (CSS sticky), and
 * the next section's heading waits at the bottom: a copy that stands in until the real one scrolls
 * up to that spot and takes over, then rises to become the one at the top. A click on it goes there. */
function drawNextHead() {
  const out = $("out");
  let next = $("next-head");
  if (!next) {
    next = el("button", { id: "next-head", type: "button" });
    next.onclick = () => { const g = out.querySelector(`.group[data-next-target="1"]`); if (g) out.scrollTo({ top: g.offsetTop, behavior: "smooth" }); };
  }
  if (next.parentNode !== out) out.append(next);
  const bottom = out.scrollTop + out.clientHeight;
  let found = null;
  for (const g of out.querySelectorAll(":scope > .group")) {
    g.removeAttribute("data-next-target");
    const h = g.querySelector(":scope > h2");
    // #out is positioned (sticky), so a section's offsetTop is measured from it.
    if (!found && h && g.offsetTop + h.offsetHeight > bottom) found = g;
  }
  next.hidden = !found || !pane;
  if (!found) return;
  found.dataset.nextTarget = "1";
  const h = found.querySelector(":scope > h2");
  const name = h.querySelector(".name")?.textContent || "";
  next.replaceChildren(el("span", { className: "name", textContent: name.trim() }), el("span", { className: "n", textContent: h.querySelector(".n")?.textContent || "" }));
  next.title = `Next: ${name.trim()}`;
}
let nextHeadFrame = 0;
$("out").addEventListener("scroll", () => { cancelAnimationFrame(nextHeadFrame); nextHeadFrame = requestAnimationFrame(drawNextHead); }, { passive: true });

/* The groups' order, for every grouping: by date — a stash's when it came in, any other group's
 * newest link — either way, or by how many links each holds. A catch-all group ("Not in a stash",
 * "Not from a chat", "Untagged") stays last. Rows keep their order inside a group; the keyboard walks
 * them in the new page order. */
const SORT_KEY = "listGroupSort";
let groupSort = (() => { try { return localStorage.getItem(SORT_KEY) || "newest"; } catch (e) { return "newest"; } })();
const CATCH_ALL = new Set(["Not in a stash", NO_CHAT, "Untagged"]);
function sortGroups() {
  const out = $("out");
  const groups = [...out.querySelectorAll(":scope > section.group")];
  if (groups.length < 2) return;
  const linkOf = new Map(rowsOnPage.map(r => [r.li, r.target.link]));
  const facts = new Map(groups.map(g => {
    const lis = [...g.querySelectorAll("ul.rows > li")];
    const stash = data.stashes.find(s => s.id === g.dataset.key);
    const dates = lis.map(li => linkOf.get(li)?.date).filter(Boolean).sort();
    return [g, { n: lis.length, at: stash?.ingested_at || stash?.created_at || dates.at(-1) || "", last: CATCH_ALL.has(g.dataset.key) || g.classList.contains("list-group") }];
  }));
  const by = { newest: (a, b) => b.at.localeCompare(a.at), oldest: (a, b) => a.at.localeCompare(b.at), most: (a, b) => b.n - a.n, fewest: (a, b) => a.n - b.n }[groupSort];
  const order = [...groups].sort((x, y) => { const a = facts.get(x), b = facts.get(y); return (a.last - b.last) || by(a, b); });
  const anchor = groups[0].previousSibling;
  out.insertBefore(el("span"), anchor ? anchor.nextSibling : out.firstChild).replaceWith(...order);
  // The keyboard walks the page: put the rows in their new order.
  rowsOnPage.sort((a, b) => (a.li.compareDocumentPosition(b.li) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}
$("sortby").value = groupSort;
$("sortby").onchange = () => {
  groupSort = $("sortby").value;
  try { localStorage.setItem(SORT_KEY, groupSort); } catch (e) { /* not remembered */ }
  render();
};

/* Any group folds: a chevron at the head of its heading, pointing down when open and turned 90° to
 * point right when folded. A folded group's rows are not drawn into the walk, so the keyboard skips
 * them; which groups are folded is remembered per grouping. */
const FOLD_KEY = "listFolded";
let folded = (() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || "[]")); } catch (e) { return new Set(); } })();
const foldId = g => `${group}:${g.dataset.key || ""}`;
function foldGroups() {
  for (const g of $("out").querySelectorAll(":scope > section.group")) {
    const h2 = g.querySelector(":scope > h2");
    if (!h2) continue;
    const id = foldId(g);
    const shut = folded.has(id);
    g.classList.toggle("folded", shut);
    const btn = el("button", { type: "button", className: "fold", title: shut ? "Show this group's links" : "Fold this group" });
    btn.setAttribute("aria-expanded", String(!shut));
    btn.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.onclick = e => {
      e.stopPropagation();
      folded.has(id) ? folded.delete(id) : folded.add(id);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch (err) { /* not remembered */ }
      render();
    };
    h2.prepend(btn);
    if (shut) {
      const gone = new Set(g.querySelectorAll("ul.rows > li"));
      rowsOnPage = rowsOnPage.filter(r => !gone.has(r.li));
      // A selected row folded away is no longer where the keyboard is: the next visible one takes over.
      for (const li of gone) li.classList.remove("lk-cursor");
    }
  }
}

function render() {
  renderRows();
  if (selecting) paintSelectBar();   // what a filter hides leaves the count
  sortGroups();
  foldGroups();
  renderOnly();
  markHeads();
  // The chip rows and the tag bar above the panes change height as they draw: measure again after.
  requestAnimationFrame(() => { fitPanes(); drawNextHead(); });
  if (!pane) return;
  // The pane always shows a link: the cursor's, else the first row's.
  if (cursorAt() === -1 && rowsOnPage.length) setCursor(rowsOnPage[0].id, false);
  else renderDetail();
}

function renderRows() {
  rowsOnPage = [];
  lastTick = null;
  renderDomainChips();
  renderTagChips();
  renderTagBar();
  renderSettings();
  renderDuplicates();
  const term = $("q").value.trim().toLowerCase();
  const total = data.links.length;
  const counts = {
    all: total,
    uncaptured: data.links.filter(l => isWeb(l.url) && !hasRead(l)).length,
    local: data.links.filter(l => !isWeb(l.url)).length,
    filtered: data.filteredLinks.length,
    captured: data.links.filter(l => isWeb(l.url) && hasRead(l)).length,
    untagged: data.links.filter(l => !l.tags.length).length,
    dups: (dupKeys = new Set(duplicateSets().map(s => s.link.key))).size,
  };
  const stashBit = data.stashes.length ? ` · ${data.stashes.length === 1 ? "1 stash" : `${data.stashes.length} stashes`}` : "";
  $("sub").textContent = total
    ? `${plural(total, "link")} · ${counts.captured} captured · ${counts.untagged} untagged${stashBit}`
    : "Nothing to show";
  drawBar(counts);
  $("groupby").value = group;

  const out = $("out");
  out.textContent = "";
  const pool = bar.filtered === "only" ? data.filteredLinks : bar.filtered === "in" ? data.links.concat(data.filteredLinks) : data.links;
  const visible = pool.filter(l => matches(l, term));

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
  for (const [name, list, sub] of bucketsOf(visible)) out.append(section(name, list.length, list.map(l => safeRow(l, null)), "", sub));
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


/* --- card mode ------------------------------------------------------------------------------
 * The Cards page, folded in: with Cards on, the detail pane deals the cursor's group (a stash, a
 * site, a tag, a day: whatever Group by makes) as a stack of cards, in list order or shuffled.
 * Dragging the top card left removes it, right or up skips it; S skips, W steps back, Q removes,
 * and D A deal the next or previous group. The sidebar marks the card on top. */

const CARDS_KEY = "listCards", SHUFFLE_KEY = "listCardsShuffle", CARD_THRESHOLD = 105;
let cardMode = pref(CARDS_KEY, false);
let cardShuffle = pref(SHUFFLE_KEY, false);
const cardTally = { removed: 0, skipped: 0 };
const shuffledOrder = new Map();   // a group's key → its row ids in the order they were shuffled into
let cardFlying = false;

const groupOf = row => row?.li.closest("section.group") || null;
const groupKey = sec => sec?.dataset.key || sec?.querySelector("h2")?.textContent || "";

function shuffleList(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* The rows of a row's group, in the order they are dealt. A shuffled group keeps its order while it
 * is dealt: a removed card leaves it, a new one joins at the end. */
function deckOf(row) {
  const sec = groupOf(row);
  const rows = rowsOnPage.filter(r => groupOf(r) === sec);
  if (!cardShuffle) return rows;
  const key = groupKey(sec), ids = rows.map(r => r.id);
  const kept = (shuffledOrder.get(key) || []).filter(id => ids.includes(id));
  const order = kept.length ? [...kept, ...shuffleList(ids.filter(id => !kept.includes(id)))] : shuffleList(ids);
  shuffledOrder.set(key, order);
  return order.map(id => rows.find(r => r.id === id));
}

/* One card on: the next in the deck, else the first of the next group (the previous, going back). */
function cardStep(by) {
  const row = rowsOnPage[cursorAt()];
  if (!row) return walk(by);
  const deck = deckOf(row);
  const to = deck[deck.indexOf(row) + by];
  if (to) return setCursor(to.id);
  const sections = [...document.querySelectorAll("#out section.group")].filter(sec => rowsOnPage.some(r => groupOf(r) === sec));
  const next = sections[sections.indexOf(groupOf(row)) + by];
  if (!next) return;
  const first = rowsOnPage.find(r => groupOf(r) === next);
  const nextDeck = deckOf(first);
  setCursor((by > 0 ? nextDeck[0] : nextDeck.at(-1)).id);
}

/* The next card after a row leaves the deck: the one after it, else the one before. */
function cardAfter(row) {
  const deck = deckOf(row), i = deck.indexOf(row);
  return deck[i + 1] || deck[i - 1] || null;
}

function cardFly(xdir, ydir = 0) {
  const top = $("detail").querySelector(".cm-card.top");
  if (!top) return Promise.resolve();
  cardFlying = true;
  top.style.transition = "transform .28s ease-out, opacity .28s ease-out";
  top.style.transform = `translate(${xdir * 620}px, ${ydir * 620 + (ydir ? 0 : 40)}px) rotate(${xdir * 22}deg)`;
  top.style.opacity = "0";
  return new Promise(ok => setTimeout(() => { cardFlying = false; ok(); }, 190));
}

async function cardSkip() {
  const i = cursorAt(), row = rowsOnPage[i];
  if (!row) return;
  await cardFly(0, -1);
  cardTally.skipped++;
  const from = row.id;
  LinkActions.push({ label: "Skip", cmd: "later", target: row.target, local: true, run: () => {
    cardTally.skipped = Math.max(0, cardTally.skipped - 1);
    cursorId = from;
  } });
  cardStep(1);
}

async function cardRemove() {
  const row = rowsOnPage[cursorAt()];
  if (!row) return;
  await cardFly(-1);
  LinkActions.run("remove", row.target);
}

function setCardMode(on) {
  cardMode = on;
  setPref(CARDS_KEY, on);
  $("t-cards").setAttribute("aria-pressed", String(on));
  detailFor = null;
  renderDetail();
}

/* A card: the site, what is known of the page, where else it is held, and Open. */
function cardEl(row, top) {
  const { link } = row.target;
  const cap = link.cap || {};
  const host = isWeb(link.url) ? hostOf(link.url) : kindOf(link.url) === "file" ? "Local file" : "Browser page";
  const card = el("article", { className: `cm-card${top ? " top" : ""}` });
  const head = el("div", { className: "cm-head" }, srcIcon(link.url),
    el("div", {}, el("div", { className: "cm-host", textContent: cap.name ? `${cap.name} · ${host}` : host }),
      el("div", { className: "cm-when" }, [link.date && `saved ${String(link.date).slice(0, 10)}`, cap.kind && cap.kind !== "page" && cap.kind].filter(Boolean).join(" · ") + " ", readBadge(link) || "")));
  const suggestions = suggestionRow(link);
  const chips = suggestions ? null : tagChips(link);
  if (chips) head.append(chips);
  card.append(head, el("div", { className: "cm-title", textContent: labelOf(link) || row.target.tab?.title || shortUrl(link.url) }));
  if (suggestions) card.append(suggestions);
  const agent = agentRow(link);
  if (agent) card.append(agent);
  const body = (cap.text || link.preview?.text || "").replace(/\s+/g, " ").trim();
  if (body && !(labelOf(link) || "").includes(body.slice(0, 40))) card.append(el("div", { className: "cm-body", textContent: body }));
  const note = cap.note || link.note;
  if (note) card.append(el("div", { className: "cm-note", textContent: note }));
  // The saved preview picture first: it lasts where a captured image's address may have expired.
  const pics = [...(link.preview?.image ? [link.preview.image] : []), ...(cap.shotThumb ? [cap.shotThumb] : []), ...(cap.images || []).slice(0, link.preview?.image ? 2 : 3)];
  if (pics.length) card.append(el("div", { className: "cm-thumbs" }, ...pics.map(src => el("img", { src, loading: "lazy", alt: "" }))));
  const also = link.copies.filter(c => c.stash !== row.target.stash?.id).map(c => stashById(c.stash)).filter(Boolean);
  if (also.length) card.append(el("div", { className: "cm-ctx", textContent: `Also in ${plural(also.length, "other stash")}: ${also.slice(0, 2).map(stashName).join(", ")}${also.length > 2 ? ", …" : ""}` }));
  const open = el("a", { className: "cm-open", href: link.url, target: "_blank", rel: "noopener noreferrer", textContent: "Open ↗" });
  open.addEventListener("click", e => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    LinkActions.run("open", row.target);
  });
  card.append(el("div", { className: "cm-foot" }, open, el("span", { className: "cm-url", textContent: shortUrl(link.url).slice(0, 70) })),
    el("div", { className: "cm-stamp keep", textContent: "skip" }), el("div", { className: "cm-stamp drop", textContent: "remove" }));
  return card;
}

/* The pane in card mode: the deal's count and Shuffle, the stack, and the actions under it. */
function renderCards(row) {
  const box = $("detail");
  const deck = deckOf(row), at = deck.indexOf(row);
  const shuffleB = el("button", { type: "button", className: "chip small", textContent: "Shuffle", title: "Deal this group's cards in a random order" });
  shuffleB.setAttribute("aria-pressed", String(cardShuffle));
  shuffleB.onclick = () => { cardShuffle = !cardShuffle; setPref(SHUFFLE_KEY, cardShuffle); shuffledOrder.clear(); detailFor = null; renderDetail(); };
  const name = groupOf(row)?.querySelector("h2 .name, h2 > span")?.textContent || "";
  box.append(el("div", { className: "cm-tally" },
    el("span", { textContent: `${at + 1} of ${deck.length}${name ? ` in ${name}` : ""}` }),
    el("span", {}, "removed ", el("b", { textContent: cardTally.removed })),
    el("span", {}, "skipped ", el("b", { textContent: cardTally.skipped })),
    shuffleB));
  const stage = el("div", { className: "cm-stage" });
  deck.slice(at, at + 3).reverse().forEach((r, i, arr) => {
    const depth = arr.length - 1 - i;
    const c = cardEl(r, depth === 0);
    c.style.transform = `translateY(${depth * 9}px) scale(${1 - depth * 0.035})`;
    c.style.opacity = depth > 1 ? ".55" : "1";
    c.style.zIndex = String(10 - depth);
    stage.append(c);
  });
  box.append(stage);
  armCard(stage.querySelector(".cm-card.top"));

  const skipB = el("button", { type: "button", title: `On to the next card, nothing recorded (${LinkKeys.showOf("next")})` }, "Skip", el("kbd", { textContent: LinkKeys.showOf("next") }));
  skipB.onclick = () => cardSkip();
  const undoB = el("button", { type: "button", title: `Undo the last action (${LinkKeys.showOf("undo")})`, disabled: !LinkActions.canUndo() }, "Undo", el("kbd", { textContent: LinkKeys.showOf("undo") }));
  undoB.onclick = () => LinkActions.undo();
  const bar = LinkActions.bar(row.target);
  const remove = bar.querySelector('[data-cmd="remove"]');
  if (remove) remove.onclick = e => { e.stopPropagation(); cardRemove(); };
  const more = bar.querySelector(".more");
  more ? more.before(skipB, undoB) : bar.append(skipB, undoB);
  box.append(el("div", { className: "cm-actions" }, bar),
    el("p", { className: "cm-keys" }, "Drag left to remove, right or up to skip, or ", ...LinkKeys.hint(["tags", "accept", "read", "remove", "next", "prev", "group-next", "open"])));
}

function armCard(card) {
  if (!card) return;
  let x0 = 0, y0 = 0, dx = 0, dy = 0, dragging = false;
  card.addEventListener("pointerdown", e => {
    if (e.target.closest("a, button, input")) return;
    dragging = true; dx = dy = 0;
    x0 = e.clientX; y0 = e.clientY;
    card.setPointerCapture(e.pointerId);
    card.style.transition = "none";
  });
  card.addEventListener("pointermove", e => {
    if (!dragging) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const p = Math.min(Math.abs(dx) / CARD_THRESHOLD, 1);
    card.querySelector(".cm-stamp.keep").style.opacity = dx > 0 ? p : 0;
    card.querySelector(".cm-stamp.drop").style.opacity = dx < 0 ? p : 0;
  });
  card.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform .28s ease-out, opacity .28s ease-out";
    if (dx <= -CARD_THRESHOLD) cardRemove();
    else if (dx >= CARD_THRESHOLD || dy < -CARD_THRESHOLD) cardSkip();
    else { card.style.transform = ""; card.querySelectorAll(".cm-stamp").forEach(s => (s.style.opacity = 0)); }
  });
  card.addEventListener("pointercancel", () => { dragging = false; card.style.transform = ""; });
}

function renderDetail() {
  const box = $("detail");
  const i = cursorAt();
  const row = rowsOnPage[i];
  // A tag being typed in the pane survives the reload its own save sets off.
  if (row && row.id === detailFor && box.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
  box.textContent = "";
  clearTimeout(previewTimer);
  detailFor = row?.id || null;
  renderPreview(row?.target.link || null);
  if (!row) {
    box.append(el("div", { className: "dempty" }, el("b", { textContent: "Nothing selected" }), "Pick a link on the left, or walk to one with W S."));
    return;
  }
  if (cardMode) return renderCards(row);
  const { link, stash, tab } = row.target;
  const url = link.url;
  const kind = kindOf(url);
  const when = stash
    ? `stashed ${whenOf(stash.created_at)}${renamed(stash) ? ` · ${stash.name}` : ""}`
    : link.date ? `${link.list?.saved_at ? "saved" : "added"} ${whenOf(link.date)} · not in a stash` : "not in a stash";
  box.append(el("div", { className: "dhead" }, srcIcon(url),
    el("div", {},
      el("div", { className: "site", textContent: kind === "web" ? hostOf(url) : kind === "file" ? "Local file" : "Browser page" }),
      el("div", { className: "when" }, when, readBadge(link))),
    el("div", { className: "pos", textContent: `${linkNumber(i)} / ${new Set(rowsOnPage.map(r => r.target.link.key)).size}` })));

  const title = headingOf(link) || tab?.title || null;
  box.append(el("h2", { className: `dtitle${title ? "" : " plain"}`, textContent: title || shortUrl(url) }));
  box.append(el("div", { className: "durl", textContent: url }));
  box.append(LinkActions.bar(row.target));

  // Tags edit in place; T jumps into the field, Enter on it empty moves to the next link. The rows
  // catch up on the next reload, so a filter such as Untagged does not pull the link away mid-edit.
  const tagrow = el("div", { className: "tagrow" }, el("span", { className: "tagrow-label", textContent: "Tags" }), tagEditor(link, () => {}));
  tagrow.addEventListener("tagdone", e => { if (e.detail?.escape) document.activeElement?.blur(); });
  box.append(tagrow);
  box.append(knownBox(row), previewControls(link));
}

function knownBox(row) {
  const { link, stash, tab } = row.target;
  const kind = kindOf(link.url);
  const box = el("section", { className: "box" }, el("h3", { textContent: "Page content" }));
  const c = link.cap;
  // Not captured, but with a preview: its picture and line, as a chat app shows under a link.
  const pv = link.preview;
  if (!c?.text && pv && (pv.image || pv.text)) {
    box.append(el("div", { className: "pvcard" }, pv.image ? el("img", { src: pv.image, alt: "" }) : "",
      el("div", {}, pv.title && pv.title !== labelOf(link) ? el("b", { textContent: pv.title }) : "", pv.text ? el("p", { textContent: pv.text }) : "")));
  }
  // A post's heading already names its author.
  if (c?.text) box.append(el("div", { className: "captext" }, c.handle && !isTextPost(c) && el("span", { className: "who", textContent: `${c.handle} ` }), c.text));
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
  // What Open does differently for this link.
  if (tab?.container) facts.append(el("li", { textContent: "Opens in its Firefox container, signed in as it was" }));
  if (kind === "other") facts.append(el("li", { textContent: "Firefox will not let Link Keeper open this address: Open shows a page with it to copy into the address bar" }));
  const dm = dmOriginText(link.origin);
  if (dm) facts.append(el("li", { textContent: `Direct message: ${dm}` }));
  if (c?.reply_count) facts.append(el("li", { textContent: `${c.reply_count} ${c.reply_count === 1 ? "reply" : "replies"} captured` }));
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
      // A site filter, the Sites row's own, so it shows as a selected chip there and clears as one.
      const only = domainSel.size === 1 && domainSel.has(host);
      const b = el("button", { className: "link", textContent: only ? "Show every site" : `Show only these ${same + 1}` });
      b.onclick = () => {
        domainSel.clear();
        domainOut.clear();
        if (!only) domainSel.add(host);
        render();
        setCursor(cursorId);
      };
      facts.append(el("li", {}, `${plural(same, "other link")} from ${host} `, b));
    }
  }
  box.append(facts);
  return box;
}

/* The live preview's switch, at the foot of the link: off, this link only, or every link (P). */
function previewControls(link) {
  const box = el("section", { className: "box" }, el("h3", { textContent: "Live preview" }));
  const now = previewMode === "keep" ? "keep" : previewShowing(link) ? "this" : "off";
  // One button that cycles: off → this link → kept on for every link → off.
  const look = { off: ["0", "Off", "this", "Show this link's page beside it; the next link opens without it"],
    this: ["only", "This link", "keep", "Keep showing each link's page as you move between links"],
    keep: ["in", "Kept on for every link", "off", "Turn the preview off"] };
  const [state, text, next, title] = look[now];
  const b = el("button", { type: "button", className: "chip small pvcycle", title: `Next click: ${title.charAt(0).toLowerCase()}${title.slice(1)}` },
    el("span", { className: "lbl", textContent: text }), stateDots(["off", "this", "keep"].indexOf(now)));
  b.dataset.state = state;
  b.setAttribute("aria-label", `Live preview: ${text}. ${title}`);
  b.onclick = () => setPreview(next);
  box.append(el("div", { className: "pvbar" }, b, el("kbd", { textContent: "P" })),
    el("p", { className: "pvnote", textContent: "The page loads in a third pane on the right, which you can widen or narrow by its edge." }));
  return box;
}

/* The third pane: the selected link's real page, when the preview is on for it. Its frame stays
 * loaded while the same link is shown. */
function renderPreview(link) {
  const pane = $("preview");
  const on = !!link && previewShowing(link);
  document.body.classList.toggle("previewing", on);
  pane.hidden = $("pv-grip").hidden = !on;
  const frame = $("pv-frame");
  if (on && frame && frame.dataset.url === link.url) return;
  pane.textContent = "";
  clearTimeout(previewTimer);
  if (!on) return;
  const close = el("button", { type: "button", className: "small ghost", textContent: "×", title: "Turn the preview off" });
  close.onclick = () => setPreview("off");
  pane.append(el("div", { className: "pvhead" }, el("span", { className: "pvsite", textContent: isWeb(link.url) ? hostOf(link.url) : shortUrl(link.url) }), close));
  if (!isWeb(link.url)) {
    pane.append(el("p", { className: "pvnote", textContent: kindOf(link.url) === "file"
      ? "Local files cannot be shown inside an extension page. Open reopens it through the helper."
      : "Browser and extension pages cannot be shown here. Open brings it back as a stand-in." }));
    return;
  }
  const f = el("iframe", { id: "pv-frame", title: `Preview of ${labelOf(link) || link.url}`, referrerPolicy: "no-referrer" });
  f.dataset.url = link.url;
  // No allow-top-navigation: a framed page cannot navigate this one away.
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  pane.append(f, el("p", { className: "pvnote", textContent: "Blank? The site refused to be shown; use Open instead." }));
  previewTimer = setTimeout(() => { f.src = link.url; }, DWELL_MS);
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
/* Every tag on a link, as the chip row counts them: yours, and for links with none of yours, the
 * model's suggestions or the site's guess (dashed). Yours can be renamed, merged and deleted here. */
function renderTagManager() {
  const list = $("tag-list");
  list.textContent = "";
  const total = new Map(), own = new Map();
  for (const l of data.all.links) {
    for (const t of shownTags(l).tags) total.set(t, (total.get(t) || 0) + 1);
    for (const t of l.tags) own.set(t, (own.get(t) || 0) + 1);
  }
  if (!total.size) list.append(el("li", { className: "none", textContent: "None yet. Press T on a link to add one." }));
  for (const [t, all] of [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const n = own.get(t) || 0;
    const count = el("a", { className: "n", href: `list.html?tag=${encodeURIComponent(t)}`, textContent: all,
      title: `${t}: ${n} yours, ${all - n} suggested or guessed · show its links` });
    if (!n) { list.append(el("li", {}, tagChip(t, true, "Suggested or guessed; not on any link as your tag yet"), count)); continue; }
    const name = el("button", { className: "link", title: "Rename; a name already in use merges the two" }, tagChip(t));
    name.onclick = () => {
      const input = el("input", { type: "text", value: t, className: "rename-tag" });
      input.setAttribute("aria-label", `Rename ${t}`);
      const done = async save => {
        if (!input.isConnected) return;
        const to = input.value.toLowerCase().replace(/\s+/g, " ").trim();
        if (save && to && to !== t) {
          const merging = own.has(to) || TAG_LIB.names.includes(to);
          const r = await renameTagUndoably(t, to, merging, n);
          if (r) say(r.ok ? `${merging ? "Merged" : "Renamed"} ${t} → ${to} on ${plural(r.links, "link")} · ⌘Z undoes it` : r.error || "Unable to rename it");
          await load();
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
    del.onclick = async () => {
      const r = await deleteTagUndoably(t, n);
      if (!r) return;
      say(r.ok ? `Deleted ${t} from ${plural(r.links, "link")} · ⌘Z puts it back` : r.error || "Unable to delete it");
      await load();
    };
    list.append(el("li", {}, name, count, del));
  }
}

function renderSettings() {
  renderTagManager();
  const nf = data.filteredLinks.length;
  $("filter-count").textContent = nf ? `${plural(nf, "link")} match the rules now.` : "no link matches the rules now.";
  for (const r of document.querySelectorAll('input[name="after-stash"]')) r.checked = r.value === settings.afterStash;
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
/* Previews for the links held before they existed: Settings says how many, and makes them one page at a
 * time (background.js previewBacklog), asking first for leave to read pages when it is not given. */
let previewTimer2 = null;
async function loadPreviews() {
  clearTimeout(previewTimer2);
  const c = await send({ type: "preview-counts" });
  if (!c) return;
  const run = c.run && !c.run.finished ? c.run : null;
  $("preview-status").textContent = run
    ? `Making previews: ${run.done} of ${run.total} done, ${run.made} made, ${run.none} with none, ${run.failed} could not be read. One page every few seconds.`
    : `${c.made} of ${c.links} links have a preview; ${c.missing} have none yet${c.none ? ` and ${c.none} offer none` : ""}.`;
  $("preview-go").hidden = !!run;
  $("preview-go").disabled = !c.missing;
  $("preview-go").textContent = `Make previews for ${plural(c.missing, "link")}`;
  $("preview-stop").hidden = !run;
  if (run) previewTimer2 = setTimeout(loadPreviews, 1500);
  else if (c.run?.finished) load();
}
$("preview-go").onclick = async () => {
  // Pages not captured are read once each; that needs leave to read any site, asked from this click.
  if (!(await browser.permissions.contains(ALL_SITES))) await browser.permissions.request(ALL_SITES).catch(() => false);
  await send({ type: "preview-backlog" });
  loadPreviews();
};
$("preview-stop").onclick = async () => { await send({ type: "preview-stop" }); setTimeout(loadPreviews, 300); };

/* Every way in makes a group since 5.64; the links that were in no stash were grouped once. Settings
 * says so, and can take those groups back out. */
async function loadGrouping() {
  const g = await send({ type: "grouping-status" });
  $("grouping-set").hidden = !g || (!g.groups && !g.undone);
  if (!g) return;
  $("grouping-status").textContent = g.undone
    ? `The ${plural(g.links, "link")} that were in no stash were grouped on ${new Date(g.at).toLocaleDateString()}, and the grouping was undone on ${new Date(g.undone).toLocaleDateString()}.`
    : `Every link now sits in a group, in the order they came in. On ${new Date(g.at).toLocaleDateString()} the ${plural(g.links, "link")} that were in no stash became ${plural(g.groups, "group")}, one per day and source.`;
  $("grouping-undo").hidden = !!g.undone;
}
$("grouping-undo").onclick = async () => {
  if (!confirm("Take the groups made from the links that were in no stash back out? The links stay; they go back to being in no stash.")) return;
  const res = await send({ type: "undo-grouping" });
  $("grouping-msg").textContent = res?.ok ? `Removed ${plural(res.removed, "group")}.` : res?.error || "Unable to undo it";
  await loadGrouping();
  await load();
};

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
  if (!name) return;
  const cmp = await send({ type: "compare-backup", name });
  if (!cmp?.ok) return say(`Not restored: ${cmp?.error || "the backup could not be read"}`);
  const rows = Object.keys(cmp.now).map(k => `  ${k}: ${cmp.now[k]} → ${cmp.file[k]}${cmp.now[k] === cmp.file[k] ? "" : cmp.file[k] < cmp.now[k] ? `  (${cmp.now[k] - cmp.file[k]} fewer)` : `  (${cmp.file[k] - cmp.now[k]} more)`}`);
  if (!confirm(`Restore the backup of ${new Date(cmp.at).toLocaleString()}?\n\nNow → after restoring:\n${rows.join("\n")}\n\nWhat is here now is saved to a pre-restore file first, so this can be undone by restoring that file. Stashes stay as they are.`)) return;
  const res = await send({ type: "restore-backup", name });
  say(res.ok ? `Restored the backup of ${new Date(res.backup_at).toLocaleString()}${res.stashes ? `, and wrote ${plural(res.stashes, "stash")} again` : ""}` : `Not restored: ${res.error}`);
  loadBackups();
  load();
};

for (const r of document.querySelectorAll('input[name="after-stash"]')) r.onchange = () => act({ type: "set-stash-settings", afterStash: r.value });
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
  for (const id of ["settings-panel", "import-panel", "dups-panel", "trash-panel"]) $(id).hidden = id !== which || !$(id).hidden;
  $("settings").setAttribute("aria-expanded", String(!$("settings-panel").hidden));
  if (!$("settings-panel").hidden) { loadFilterRules(); loadBackups(); loadGrouping(); loadPreviews(); }
  if (!$("import-panel").hidden) watchRefresh();
  $("import").setAttribute("aria-expanded", String(!$("import-panel").hidden));
  $("dups").setAttribute("aria-expanded", String(!$("dups-panel").hidden));
  if (!$("import-panel").hidden) $("import-text").focus();
  $("trash").setAttribute("aria-expanded", String(!$("trash-panel").hidden));
  if (!$("dups-panel").hidden) { renderDuplicates(); $("dups-h").focus(); }
  if (!$("trash-panel").hidden) { renderTrash(); $("trash-h").focus(); }
  loadTrash();
}
// Closing hands the keyboard back to the button that opened the panel.
function closePanel(panel, button) {
  openPanel(panel);
  $(button).focus();
}
// Closing the duplicate tools also turns the Duplicates switch back off: they belong together.
function closeDups() {
  bar.dups = "any";
  closePanel("dups-panel", "f-dups");
  render();
}
for (const [panel, close] of [["dups-panel", closeDups], ["trash-panel", () => closePanel("trash-panel", "trash")]]) {
  $(panel).addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.target.matches("input[type=text], textarea")) return;
    e.stopPropagation();
    close();
  });
}
$("settings").onclick = () => openPanel("settings-panel");
$("dups").onclick = () => openPanel("dups-panel");
$("trash").onclick = () => openPanel("trash-panel");

/* --- duplicates -----------------------------------------------------------------------------
 * Every link held in more than one place among the sources on show — two stashes, or a stash and
 * the reading list — as a card with a checkbox per copy, newest first. Nothing starts ticked, and
 * only what is ticked moves to the Trash. Each card can tick all
 * but its newest or oldest copy, and so can the panel for every card at once. */

const picked = new Set();   // copy ids: "tab:<bookmark id>" or "list:<link key>"
let dupSets = [];
let dupSync = [];           // one function per card on show, to redraw its boxes from `picked`

/* Copies are grouped by the address as written, fragment included. A link's key ignores the
 * fragment, so every Gmail message (mail.google.com/mail/u/0/#inbox/<id>) shares one key and would
 * look like one link held dozens of times. */
const exactUrl = url => String(url).replace(/\/+$/, "");

/* Worked out once per data load: a filter or chip click cannot change which links are held twice, and
 * at 2000 links the scan took 300 ms. Lookup tables replace a search of every stash per copy. */
let dupCache = null;
function duplicateSets() {
  if (dupCache && dupCache.data === data) return dupCache.sets;
  const stashes = new Map(data.all.stashes.map(s => [s.id, s]));
  const shown = new Set(data.stashes.map(s => s.id));
  const tabAt = new Map(data.all.stashes.flatMap(s => s.tabs.map((t, i) => [t.id, i])));
  const out = [];
  for (const link of data.links) {
    const buckets = new Map();   // exact address -> its copies
    const add = (url, copy) => buckets.set(exactUrl(url), [...(buckets.get(exactUrl(url)) || []), { ...copy, url }]);
    for (const c of link.copies.filter(c => shown.has(c.stash))) {
      const stash = stashes.get(c.stash);
      const at = tabAt.get(c.tab) ?? -1;
      if (at === -1) continue;
      const label = stashName(stash);
      const kind = stash.source === "import" ? "imported" : "stashed";
      add(stash.tabs[at].url, { id: `tab:${c.tab}`, stash, tab: c.tab, at: Date.parse(stash.created_at) || 0,
        title: stash.tabs[at].title || null, when: whenOf(stash.created_at), label, hint: `tab ${at + 1} of ${stash.tabs.length}`,
        detail: label === whenOf(stash.created_at) ? kind : `${kind} ${whenOf(stash.created_at)}` });
    }
    if (link.list && !link.list.loose) {
      const added = Date.parse(link.list.added_at);
      // A list entry with no date is the one you still act on: it counts as the newest.
      add(link.url, { id: `list:${link.key}`, list: true, at: Number.isNaN(added) ? Number.MAX_SAFE_INTEGER : added,
        title: link.title, when: link.list.added_at ? whenOf(link.list.added_at) : "", label: "Not in a stash", hint: "",
        detail: "added on its own" });
    }
    for (const [, copies] of buckets) {
      if (copies.length < 2) continue;
      copies.sort((a, b) => b.at - a.at);
      const url = copies[0].url;
      const same = exactUrl(url) === exactUrl(link.url);
      out.push({ link: { ...link, url, title: copies.find(c => c.title)?.title || (same ? link.title : null), cap: same ? link.cap : null }, copies });
    }
  }
  const sets = out.sort((a, b) => b.copies.length - a.copies.length || (labelOf(a.link) || a.link.url).localeCompare(labelOf(b.link) || b.link.url));
  dupCache = { data, sets };
  return sets;
}

// Rows past COLLAPSE_AFTER show only the first SHOWN_WHEN_COLLAPSED until "more" is pressed.
const COLLAPSE_AFTER = 5, SHOWN_WHEN_COLLAPSED = 3;
function collapseRows(card, rows, ticked) {
  if (rows.length <= COLLAPSE_AFTER) return () => {};
  const rest = rows.slice(SHOWN_WHEN_COLLAPSED);
  const more = el("button", { className: "ghost small dup-more", type: "button" });
  let open = false;
  const paint = () => {
    for (const r of rest) r.el.hidden = !open;
    const n = rest.filter(r => ticked(r.id)).length;
    more.textContent = open ? "Show fewer" : `+${rest.length} more${n ? ` (${n} ticked)` : ""}`;
    more.setAttribute("aria-expanded", String(open));
  };
  more.onclick = () => { open = !open; paint(); };
  card.append(more);
  paint();
  return paint;
}

function tickCopies(copies, keep) {
  for (const c of copies) (c === keep ? picked.delete(c.id) : picked.add(c.id));
}
function tickEvery(keepOf) {
  for (const { copies } of dupSets) tickCopies(copies, keepOf(copies));
  for (const sync of dupSync) sync();
  paintDupCount();
}

function renderDuplicates() {
  const sets = dupSets = duplicateSets();
  // Opened by the Duplicates switch in the filter bar now; the old button stays hidden as the panel's anchor.
  $("dups").hidden = true;
  if ($("dups-panel").hidden) return;
  // What was ticked stays ticked across a reload, as long as the copy is still there.
  const ids = new Set(sets.flatMap(s => s.copies.map(c => c.id)));
  for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);

  const box = $("dups-list");
  box.textContent = "";
  dupSync = [];
  if (!sets.length) box.append(el("p", { className: "none", textContent: "No duplicates in the sources shown." }));
  sets.forEach(({ link, copies }, n) => {
    const title = labelOf(link);
    const name = title || link.url;
    const free = copies;
    const toggle = el("button", { className: "ghost small", type: "button" });
    const sync = () => {
      for (const b of boxes) b.checked = picked.has(b.dataset.id);
      toggle.textContent = free.every(c => picked.has(c.id)) ? "Untick all" : "Tick all";
      toggle.setAttribute("aria-label", `${toggle.textContent} copies of ${name}`);
      repaintMore();
    };
    const apply = fn => () => { fn(); sync(); paintDupCount(); };
    const keepBtn = (text, keep) => el("button", { className: "ghost small", type: "button", textContent: text,
      title: `Tick every other copy of this link`, onclick: apply(() => tickCopies(copies, keep)) });
    const newest = keepBtn("Keep newest", copies[0]);
    const oldest = keepBtn("Keep oldest", copies[copies.length - 1]);
    newest.setAttribute("aria-label", `Keep the newest copy of ${name}, tick the rest`);
    oldest.setAttribute("aria-label", `Keep the oldest copy of ${name}, tick the rest`);
    toggle.onclick = apply(() => {
      const on = !free.every(c => picked.has(c.id));
      for (const c of free) on ? picked.add(c.id) : picked.delete(c.id);
    });
    const hid = `dup-h-${n}`;
    const card = el("div", { className: "dup-card" },
      el("div", { className: "dup-head" }, srcIcon(link.url),
        el("div", {}, el("div", { className: `dup-title${title ? "" : " plain"}`, id: hid, title: link.url },
            name, el("span", { className: "dup-count", textContent: ` · ${copies.length} copies` })),
          title && el("div", { className: "dup-url", textContent: link.url })),
        el("div", { className: "dup-tools" }, newest, oldest, ...(free.length > 1 ? [toggle] : []))));
    card.setAttribute("role", "group");
    card.setAttribute("aria-labelledby", hid);
    const boxes = [], rows = [];
    for (const c of copies) {
      const box2 = el("input", { type: "checkbox", checked: picked.has(c.id) });
      box2.dataset.id = c.id;
      boxes.push(box2);
      box2.onchange = () => { box2.checked ? picked.add(c.id) : picked.delete(c.id); sync(); paintDupCount(); };
      const row = el("label", { className: "dup-row", title: c.hint },
        box2,
        ...(c.when ? [el("span", { className: "dup-when", textContent: c.when })] : []),
        el("span", { className: "dup-where", textContent: c.label }),
        el("span", { className: "dup-detail", textContent: c.detail }));
      card.append(row);
      rows.push({ el: row, id: c.id });
    }
    const repaintMore = collapseRows(card, rows, id => picked.has(id));
    sync();
    dupSync.push(sync);
    box.append(card);
  });
  paintDupCount();
}

function paintDupCount() {
  const n = picked.size;
  const touched = dupSets.filter(s => s.copies.some(c => picked.has(c.id))).length;
  const gone = dupSets.filter(s => s.copies.every(c => picked.has(c.id))).length;
  $("dups-remove").disabled = !n;
  $("dups-remove").textContent = n ? `Move ${copiesWord(n)} to Trash` : "Move to Trash";
  const sum = $("dups-sum");
  sum.textContent = n ? `${copiesWord(n)} ticked in ${touched} of ${dupSets.length} groups` : "Nothing ticked";
  if (gone) sum.append(" · ", el("b", { textContent: `${gone === 1 ? "1 link" : `${gone} links`} will be left only in the Trash` }));
}
// plural() would say "copys".
const copiesWord = n => (n === 1 ? "1 copy" : `${n} copies`);

$("dups-newest").onclick = () => tickEvery(copies => copies[0]);
$("dups-oldest").onclick = () => tickEvery(copies => copies[copies.length - 1]);
$("dups-none").onclick = () => { picked.clear(); for (const sync of dupSync) sync(); paintDupCount(); };

$("dups-remove").onclick = async () => {
  const sets = duplicateSets();
  const chosen = sets.flatMap(s => s.copies.filter(c => picked.has(c.id)).map(c => ({ ...c, link: s.link })));
  if (!chosen.length) return;
  // The Trash undoes a removal, so only the one that leaves a link with no live copy asks first.
  const gone = sets.filter(s => s.copies.every(c => picked.has(c.id))).length;
  if (gone && !confirm(`${gone === 1 ? "1 link" : `${gone} links`} would have no copy left outside the Trash. Move ${copiesWord(chosen.length)} to the Trash anyway?`)) return;
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
  say(`Moved ${copiesWord(removed)} to the Trash. Open Trash to restore them`);
  await load();
  $("dups-h").focus();
};
$("dups-close").onclick = closeDups;

/* --- trash ----------------------------------------------------------------------------------
 * What was removed, newest removal first, one card per removal and a checkbox per link. Restoring
 * puts a link back where it came from; deleting forever, or the 30 days running out, ends it. */

const trashPicked = new Set();
let trashEntries = [], trashDays = 30;

async function loadTrash() {
  const res = await send({ type: "trash-list" });
  trashEntries = res?.entries || [];
  trashDays = res?.days || 30;
  $("trash").textContent = `Trash (${trashEntries.length})`;
  if (!$("trash-panel").hidden) renderTrash();
}

const daysLeft = e => Math.max(0, Math.ceil((Date.parse(e.at) + trashDays * 86400000 - Date.now()) / 86400000));

function renderTrash() {
  const ids = new Set(trashEntries.map(e => e.id));
  for (const id of [...trashPicked]) if (!ids.has(id)) trashPicked.delete(id);
  const box = $("trash-list");
  box.textContent = "";
  if (!trashEntries.length) box.append(el("p", { className: "none", textContent: "The Trash is empty. Links you remove stay here for 30 days." }));
  const groups = new Map();
  for (const e of trashEntries) groups.set(e.at, [...(groups.get(e.at) || []), e]);
  [...groups].forEach(([at, entries], n) => {
    const free = entries.map(e => e.id);
    const toggle = el("button", { className: "ghost small", type: "button" });
    const sync = () => {
      for (const b of boxes) b.checked = trashPicked.has(b.dataset.id);
      toggle.textContent = free.every(id => trashPicked.has(id)) ? "Untick all" : "Tick all";
      toggle.setAttribute("aria-label", `${toggle.textContent} links removed ${whenOf(at)}`);
      repaintMore();
    };
    toggle.onclick = () => {
      const on = !free.every(id => trashPicked.has(id));
      for (const id of free) on ? trashPicked.add(id) : trashPicked.delete(id);
      sync(); paintTrashCount();
    };
    const hid = `trash-h-${n}`;
    const card = el("div", { className: "dup-card" },
      el("div", { className: "dup-head" }, el("span"),
        el("div", {}, el("div", { className: "dup-title", id: hid },
          `Removed ${whenOf(at)}`, el("span", { className: "dup-count", textContent: ` · ${plural(entries.length, "link")}` }))),
        el("div", { className: "dup-tools" }, toggle)));
    card.setAttribute("role", "group");
    card.setAttribute("aria-labelledby", hid);
    const boxes = [], rows = [];
    for (const e of entries) {
      const box2 = el("input", { type: "checkbox", checked: trashPicked.has(e.id) });
      box2.dataset.id = e.id;
      boxes.push(box2);
      box2.onchange = () => { box2.checked ? trashPicked.add(e.id) : trashPicked.delete(e.id); sync(); paintTrashCount(); };
      const left = daysLeft(e);
      const row = el("label", { className: "dup-row", title: e.url },
        box2,
        el("span", { className: "dup-where", textContent: e.title || e.url }),
        el("span", { className: "dup-detail", textContent: `${e.kind === "item" ? "Not in a stash" : e.kind === "capture" ? "Capture" : e.stash.name} · deleted forever in ${plural(left, "day")}` }),
        ...(e.title ? [el("span", { className: "dup-url dup-rowurl", textContent: e.url })] : []));
      card.append(row);
      rows.push({ el: row, id: e.id });
    }
    const repaintMore = collapseRows(card, rows, id => trashPicked.has(id));
    sync();
    box.append(card);
  });
  paintTrashCount();
}

function paintTrashCount() {
  const n = trashPicked.size;
  $("trash-restore").disabled = $("trash-delete").disabled = !n;
  $("trash-empty").disabled = !trashEntries.length;
  $("trash-restore").textContent = n ? `Restore ${plural(n, "link")}` : "Restore";
  $("trash-delete").textContent = n ? `Delete ${plural(n, "link")} forever` : "Delete forever";
  $("trash-sum").textContent = n ? `${plural(n, "link")} ticked of ${trashEntries.length}` : "Nothing ticked";
}

$("trash-restore").onclick = async () => {
  const ids = [...trashPicked];
  if (!ids.length) return;
  const res = await send({ type: "trash-restore", ids });
  trashPicked.clear();
  const left = ids.length - (res?.restored || 0);
  say(res?.ok === false ? res.error || "Not restored"
    : `Restored ${plural(res.restored, "link")} to ${res.where.join(", ") || "where they were"}${left ? `; ${left} could not be put back and stay in the Trash` : ""}`);
  await load();
  $("trash-h").focus();
};
$("trash-delete").onclick = async () => {
  const ids = [...trashPicked];
  if (!ids.length || !confirm(`Delete ${plural(ids.length, "link")} forever? They cannot be restored.`)) return;
  const res = await send({ type: "trash-delete", ids });
  trashPicked.clear();
  say(`Deleted ${plural(res?.removed || 0, "link")} forever`);
  await loadTrash();
  $("trash-h").focus();
};
$("trash-empty").onclick = async () => {
  if (!trashEntries.length || !confirm(`Delete all ${plural(trashEntries.length, "link")} in the Trash forever? They cannot be restored.`)) return;
  const res = await send({ type: "trash-delete", all: true });
  trashPicked.clear();
  say(`Deleted ${plural(res?.removed || 0, "link")} forever`);
  await loadTrash();
  $("trash-h").focus();
};
$("trash-close").onclick = () => closePanel("trash-panel", "trash");

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
    note.textContent = `Read as capture JSONL: ${plural(parsed.records.length, "record")}; their links join the pile, in no stash` +
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
    note.textContent = `Read as ${FORMAT_NAMES[parsed.format]}: ${plural(entries.length, "web link")}, each on its own, in no stash` +
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
  `; ${res.total} captures in all`;

/* Writing a few hundred bookmarks takes seconds, so the panel counts them as Firefox reports each
 * one, then stays open with the result instead of vanishing. */
$("import-go").onclick = async () => {
  if (parsed?.format === "captures") {
    const res = await send({ type: "import-captures", records: parsed.records, group: batchGroup("Imported captures") });
    importDone(captureSummary(res));
    return load();
  }
  if (!parsed?.stashes.length) return;
  if (importDest() === "list") {
    // Re-adding a link with a date fills the date in; one already dated is left as it is.
    const res = await send({ type: "add", urls: listEntries(), group: batchGroup("Pasted links") });
    importDone(`Added ${plural(res.added, "link")}` + (res.updated ? `, ${res.updated} dated` : "") +
      (res.skipped ? `, ${res.skipped} already here` : ""));
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
/* Refresh from exports: the helper runs tools/refresh.zsh; this page shows its last lines while it runs
 * and collects its hand-over when it serves one (takePendingRefresh, quiet when nothing waits). */
let refreshTimer = null;
async function watchRefresh() {
  clearTimeout(refreshTimer);
  const st = await send({ type: "refresh-status" });
  if (!st?.ok) { $("refresh-msg").textContent = `Refresh is not available: ${st?.error || "the helper did not answer"}.`; $("refresh-go").disabled = false; return; }
  const lines = (st.lines || []).filter(l => l.trim());
  $("refresh-log").hidden = !lines.length;
  $("refresh-log").textContent = lines.slice(-12).join("\n");
  $("refresh-log").scrollTop = $("refresh-log").scrollHeight;
  $("refresh-go").disabled = st.running;
  await takePendingRefresh();
  if (st.running) {
    $("refresh-msg").textContent = `Refreshing since ${new Date(st.started).toLocaleTimeString()}…`;
    refreshTimer = setTimeout(watchRefresh, 2000);
  } else if (lines.length) {
    $("refresh-msg").textContent = st.exit === 0 ? "The last refresh finished." : st.exit == null ? "The last refresh stopped without finishing." : `The last refresh failed (exit ${st.exit}); its last lines are below.`;
  }
}
$("refresh-go").onclick = async () => {
  $("refresh-go").disabled = true;
  const res = await send({ type: "refresh-start", offline: $("refresh-offline").checked });
  if (!res?.ok) { $("refresh-go").disabled = false; $("refresh-msg").textContent = res?.error || "The refresh did not start."; return; }
  $("refresh-msg").textContent = "Refreshing…";
  refreshTimer = setTimeout(watchRefresh, 800);
};

/* A batch brought in from this page is one group, named for what it is and the day: "Pasted links ·
 * Oct 15, 2026". Its key keeps one batch's several calls (a refresh's captures and queue) together. */
const batchGroup = label => ({ name: `${label} · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, key: `batch:${label}:${Date.now()}` });

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
  const handover = batchGroup("Refresh hand-over");
  const bits = [];
  if (records.length) {
    const out = await send({ type: "import-captures", records, group: handover });
    bits.push(`${records.length} read: ${out.added} new, ${out.enriched} filled in`);
  }
  if (queue.length) {
    const out = await send({ type: "add", urls: queue, group: handover });
    bits.push(`${queue.length} needing a browser: ${out.added} queued${out.skipped ? `, ${out.skipped} already there` : ""}`);
  }
  if ($("import-panel").hidden) openPanel("import-panel");   // opens it; a call on an open panel would close it
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
for (const k of Object.keys(BAR)) $(`f-${k}`).onclick = () => { cycleBar(k); render(); };

const stashed = r => `Stashed ${plural(r.stashed, "tab")}${r.why ? ` · left open: ${r.why}` : ""}`;
$("stash").onclick = () => act({ type: "stash" }, stashed);
{
  // The popup's other scopes, here too; "this one" is this page's tab, which is never stashed.
  const scopes = [
    ["window", "All tabs in this window"], ["left", "Tabs to the left"], ["right", "Tabs to the right"],
    ["others", "All except this one"], ["all-windows", "Every window, one stash each"],
  ];
  const [trigger, menu] = popoverMenu("▾", "Stash only some tabs",
    scopes.map(([scope, text]) => ({ text, run: () => act({ type: "stash", scope }, stashed) })), "primary arrow");
  // Each scope says how many tabs it would stash, counted when the menu opens; one with none is off.
  menu.addEventListener("beforetoggle", async e => {
    if (e.newState !== "open") return;
    const { counts } = await send({ type: "stash-counts" });
    [...menu.querySelectorAll("button")].forEach((b, i) => {
      const n = counts?.[scopes[i][0]] ?? 0;
      b.textContent = `${scopes[i][1]} · ${n}`;
      b.disabled = !n;
    });
  });
  $("stash-split").append(trigger, menu);
  const paintStash = async () => {
    const n = (await send({ type: "stash-counts" }))?.counts?.auto ?? 0;
    $("stash").textContent = n ? `Stash ${plural(n, "tab")}` : "Stash this window";
    $("stash").disabled = !n;
  };
  paintStash();
  for (const ev of ["onCreated", "onRemoved", "onUpdated", "onHighlighted"]) browser.tabs[ev]?.addListener(() => paintStash());
}


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
    { text: "Links in no stash (JSONL)", title: "Every link added on its own, with its dates and note", run: async () => {
      const { items } = await send({ type: "export-list" });
      if (!items.length) return say("No link is outside a stash");
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

$("t-select").onclick = () => setSelecting(!selecting);
$("sel-done").onclick = () => setSelecting(false);
$("sel-clear").onclick = () => { ticked.clear(); lastTick = null; paintTicks(); };
$("sel-all").onclick = () => { for (const r of rowsOnPage) ticked.add(r.target.link.key); paintTicks(); };
$("sel-tag").onclick = () => bulkTagPopover($("sel-tag"));
$("sel-capture").onclick = captureTicked;
$("t-cards").onclick = () => setCardMode(!cardMode);
$("t-cards").setAttribute("aria-pressed", String(cardMode));
$("t-compact").onclick = () => { setPref(pane ? COMPACT_PANE_KEY : COMPACT_KEY, !compactNow()); applyView(); };
applyView();

if (location.hash === "#import") { openPanel("import-panel"); previewImport(); }
takePendingRefresh();
reloadOnChanges(load, () => !!(renaming || dragging));
load();
loadQueue();
