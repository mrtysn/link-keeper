/* Explore stashed tabs: every tab in a sidebar, the chosen one in full beside it.
 *
 * The sidebar lists one stash or all of them in the order they were stashed; click any row to jump
 * to it, or walk with ↑ ↓. The detail pane shows what is known without touching the network — the
 * tabs that sat beside it in the tab strip, its capture if the page was ever read, whether it is on
 * the reading list or in another stash — and two things that do: Read (loads it in a background
 * tab and extracts it, as the list page does) and the live preview.
 *
 * Keep and Drop are flags; pressing one again clears it. Nothing here can lose a tab: a drop is
 * removed only by "Clear dropped" on the Stashed tabs page.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

const scope = new URLSearchParams(location.search).get("stash") || "all";
const PREVIEW_KEY = "stashPreview";
const ALL_SITES = { origins: ["*://*/*"] };
const DWELL_MS = 500;

let sessions = [];
let known = {};
let deck = [];           // [{ session, tab, pos }] in stash order, for the chosen scope
let visible = [];        // deck after filter and verdict chips
let current = null;      // key of the card on show
let filter = "all";
let previewOn = false;
let previewTimer = null;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
};

function say(text) { const m = $("msg"); if (m) m.textContent = text; }
function shortUrl(url) { return String(url).replace(/^https?:\/\/(www\.)?/, ""); }
function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const isWeb = url => /^(https?|ftp):/.test(url);
function kindOf(url) {
  if (isWeb(url) || url.startsWith(browser.runtime.getURL(""))) return "web";
  return /^file:/.test(url) ? "file" : "other";
}
const keyOf = c => c && `${c.session.id} ${c.tab.url}`;
const stashName = s => s.name || whenOf(s.created_at);

/* --- data ----------------------------------------------------------------------- */

async function load() {
  const [{ sessions: all }, k, stored] = await Promise.all([
    send({ type: "sessions" }), send({ type: "stash-known" }), browser.storage.local.get(PREVIEW_KEY),
  ]);
  sessions = all;
  known = k.known || {};
  previewOn = !!stored[PREVIEW_KEY];
  const chosen = scope === "all" ? sessions : sessions.filter(s => s.id === scope);
  deck = chosen.flatMap(session => session.tabs.map((tab, pos) => ({ session, tab, pos })));
  applyFilter();
  if (!deck.some(c => keyOf(c) === current)) {
    // First load, or the card left (moved to the list): land on the first undecided one.
    const first = visible.find(c => !c.tab.verdict) || visible[0];
    current = keyOf(first);
  }
  renderScope();
  renderSide();
  renderDetail();
}

function applyFilter() {
  const term = $("q").value.trim().toLowerCase();
  visible = deck.filter(({ tab }) => {
    if (filter === "open" && tab.verdict) return false;
    if ((filter === "keep" || filter === "drop") && tab.verdict !== filter) return false;
    return !term || `${tab.title || ""} ${tab.url}`.toLowerCase().includes(term);
  });
}

function renderScope() {
  const sel = $("scope");
  sel.textContent = "";
  const total = sessions.reduce((n, s) => n + s.tabs.length, 0);
  sel.append(el("option", { value: "all", textContent: `All stashes (${total})` }));
  for (const s of sessions) sel.append(el("option", { value: s.id, textContent: `${stashName(s)} (${s.tabs.length})` }));
  sel.value = sessions.some(s => s.id === scope) ? scope : "all";

  const counts = { all: deck.length, open: 0, keep: 0, drop: 0 };
  for (const { tab } of deck) counts[tab.verdict || "open"]++;
  for (const chip of document.querySelectorAll(".chip")) {
    const label = { all: "All", open: "Undecided", keep: "Kept", drop: "Dropped" }[chip.dataset.f];
    chip.replaceChildren(`${label} `, el("span", { className: "n", textContent: counts[chip.dataset.f] }));
    chip.setAttribute("aria-pressed", String(chip.dataset.f === filter));
  }
}

/* --- sidebar -------------------------------------------------------------------- */

function renderSide() {
  const side = $("side");
  side.textContent = "";
  if (!visible.length) {
    side.append(el("p", { className: "side-empty", textContent: deck.length ? "No tab matches." : "Nothing stashed." }));
    return;
  }
  let list = null, lastId = null;
  for (const card of visible) {
    if (card.session.id !== lastId) {
      lastId = card.session.id;
      const shown = visible.filter(c => c.session.id === lastId).length;
      side.append(el("h2", {}, stashName(card.session), el("span", { className: "n", textContent: shown })));
      list = el("ul");
      side.append(list);
    }
    const { tab } = card;
    const b = el("button", { title: tab.title ? `${tab.title}\n${tab.url}` : tab.url },
      srcIcon(tab.url),
      el("span", { className: `t${tab.title ? "" : " plain"}`, textContent: tab.title || shortUrl(tab.url) }),
      el("span", { className: "m" }));
    b.dataset.key = keyOf(card);
    if (keyOf(card) === current) b.setAttribute("aria-current", "true");
    b.onclick = () => select(keyOf(card));
    list.append(el("li", { className: tab.verdict || "" }, b));
  }
  side.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

function select(key) {
  if (!key || key === current) return;
  current = key;
  for (const b of document.querySelectorAll("#side button[aria-current]")) b.removeAttribute("aria-current");
  const row = document.querySelector(`#side button[data-key="${CSS.escape(key)}"]`);
  row?.setAttribute("aria-current", "true");
  row?.scrollIntoView({ block: "nearest" });
  renderDetail();
}

function step(by) {
  const i = visible.findIndex(c => keyOf(c) === current);
  const next = visible[i === -1 ? 0 : i + by];
  if (next) select(keyOf(next));
}

/* --- detail --------------------------------------------------------------------- */

function renderDetail() {
  const pane = $("detail");
  pane.textContent = "";
  clearTimeout(previewTimer);
  const card = deck.find(c => keyOf(c) === current);
  if (!card) {
    pane.append(el("div", { className: "empty" }, el("b", { textContent: "Nothing to show" }),
      deck.length ? "No tab matches the filter." : "Stash tabs with ⌃⇧S and explore them here."));
    return;
  }
  const { session, tab } = card;
  const kind = kindOf(tab.url);
  const info = known[tab.url] || {};
  const i = visible.findIndex(c => keyOf(c) === current);

  pane.append(el("div", { className: "dhead" }, srcIcon(tab.url),
    el("div", {},
      el("div", { className: "where", textContent: kind === "web" ? hostOf(tab.url) : kind === "file" ? "Local file" : "Browser page" }),
      el("div", { className: "when", textContent: `stashed ${whenOf(session.created_at)}${session.name ? ` · ${session.name}` : ""}` })),
    el("div", { className: "pos", textContent: i === -1 ? "" : `${i + 1} / ${visible.length}` })));

  pane.append(tab.title
    ? el("h2", { className: "dtitle", textContent: tab.title })
    : el("h2", { className: "dtitle plain", textContent: shortUrl(tab.url) }));
  pane.append(el("div", { className: "durl", textContent: tab.url }));

  const btn = (text, cls, title, fn) => {
    const b = el("button", { className: cls, textContent: text, title });
    b.onclick = fn;
    return b;
  };
  const keep = btn("Keep", "keep", "Keep it in the stash (k)", () => judge(card, "keep"));
  const drop = btn("Drop", "drop", "Flag it dropped; Clear dropped removes it (d)", () => judge(card, "drop"));
  keep.setAttribute("aria-pressed", String(tab.verdict === "keep"));
  drop.setAttribute("aria-pressed", String(tab.verdict === "drop"));
  pane.append(el("div", { className: "acts" },
    btn("Open", "primary", "Reopen this tab now (o)", () => openNow(card)),
    keep, drop,
    isWeb(tab.url) && btn("To list", "", "Move this web page to the reading list (l)", () => toList(card)),
    isWeb(tab.url) && btn(info.cap ? "Re-read" : "Read", "", "Load it in a background tab and extract its text and images (r)", e => readNow(card, e.currentTarget))));

  const badges = el("div", { className: "badges" });
  if (tab.verdict === "keep") badges.append(el("span", { className: "badge keep", textContent: "✓ Kept" }));
  if (tab.verdict === "drop") badges.append(el("span", { className: "badge drop", textContent: "✕ Dropped" }));
  if (tab.seen_at) badges.append(el("span", { className: "badge", textContent: `restored ${whenOf(tab.seen_at)}` }));
  if (tab.container) badges.append(el("span", { className: "badge", textContent: "Container" }));
  if (kind === "other") badges.append(el("span", { className: "badge", textContent: "Opens as a stand-in" }));
  if (badges.childElementCount) pane.append(badges);
  pane.append(el("p", { id: "msg", role: "status" }));

  pane.append(knownBox(card, info), neighboursBox(card), previewBox(card));
  pane.append(el("p", { className: "keys" }, el("kbd", { textContent: "↑" }), " ", el("kbd", { textContent: "↓" }),
    " move · ", el("kbd", { textContent: "o" }), " open · ", el("kbd", { textContent: "k" }), " keep · ",
    el("kbd", { textContent: "d" }), " drop · ", el("kbd", { textContent: "l" }), " to list · ",
    el("kbd", { textContent: "r" }), " read · ", el("kbd", { textContent: "p" }), " preview on/off · ",
    el("kbd", { textContent: "/" }), " filter"));
}

function knownBox({ session, tab }, info) {
  const box = el("section", { className: "box" }, el("h3", { textContent: "What is known" }));
  if (info.cap) {
    const c = info.cap;
    if (c.text) {
      box.append(el("div", { className: "captext" }, c.handle && el("span", { className: "who", textContent: `${c.handle} ` }), c.text));
    } else if (c.title && c.title !== tab.title) {
      box.append(el("p", { className: "muted", textContent: c.title }));
    }
    if (c.images.length) {
      box.append(el("div", { className: "thumbs" }, ...c.images.map(src => {
        const img = el("img", { src, loading: "lazy", alt: "" });
        img.addEventListener("error", () => img.remove());
        return el("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, img);
      })));
    }
    if (c.links.length) {
      box.append(el("div", { className: "inner" }, ...c.links.map(href =>
        el("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: shortUrl(href), title: href }))));
    }
  }

  const facts = el("ul", { className: "facts" });
  if (info.cap?.captured_at) facts.append(el("li", { textContent: `Read ${whenOf(info.cap.captured_at)}` }));
  else if (isWeb(tab.url)) facts.append(el("li", { textContent: "Never read — Read pulls its text and images in." }));
  if (info.list) {
    const names = { pending: "not opened yet", seen: "opened, undecided", kept: "kept", skipped: "skipped" };
    facts.append(el("li", { textContent: `On the reading list — ${names[info.list] || info.list}` }));
  }
  const elsewhere = sessions.filter(s => s.id !== session.id && s.tabs.some(t => known[t.url]?.key === info.key));
  for (const s of elsewhere) {
    const b = el("button", { className: "link", textContent: stashName(s) });
    b.onclick = () => select(`${s.id} ${s.tabs.find(t => known[t.url]?.key === info.key).url}`);
    facts.append(el("li", {}, "Also stashed in ", b));
  }
  if (kindOf(tab.url) === "web") {
    const host = hostOf(tab.url);
    const same = sessions.flatMap(s => s.tabs).filter(t => t.url !== tab.url && isWeb(t.url) && hostOf(t.url) === host).length;
    if (same) {
      const b = el("button", { className: "link", textContent: `Show all ${same + 1}` });
      b.onclick = () => { $("q").value = host; refilter(); };
      facts.append(el("li", {}, `${plural(same, "other stashed tab")} from ${host} `, b));
    }
  }
  box.append(facts);
  return box;
}

/* The tabs on either side of it when it was stashed — often the best clue to why it was open. */
function neighboursBox({ session, pos }) {
  const box = el("section", { className: "box" }, el("h3", { textContent: "Next to it in the tab strip" }));
  const ol = el("ol", { className: "neigh" });
  for (let off = -4; off <= 4; off++) {
    const t = session.tabs[pos + off];
    if (!t) continue;
    const b = el("button", { title: t.url },
      el("span", { className: "off", textContent: off === 0 ? "" : off > 0 ? `+${off}` : String(off) }),
      srcIcon(t.url),
      el("span", { className: "t", textContent: t.title || shortUrl(t.url) }));
    if (off) b.onclick = () => { ensureVisible(); select(`${session.id} ${t.url}`); };
    else b.setAttribute("aria-current", "true");
    ol.append(el("li", { className: off ? "" : "self" }, b));
  }
  box.append(ol);
  return box;
}

/* A neighbour may be hidden by the filter; jumping to it clears the filter first. */
function ensureVisible() {
  if ($("q").value || filter !== "all") {
    $("q").value = "";
    filter = "all";
    applyFilter();
    renderScope();
    renderSide();
  }
}

function previewBox({ tab }) {
  const box = el("section", { className: "box" }, el("h3", { textContent: "Live preview" }));
  const toggle = el("input", { type: "checkbox", checked: previewOn });
  toggle.onchange = () => setPreview(toggle.checked);
  const bar = el("div", { className: "pvbar" }, el("label", {}, toggle, "Show the page here"));
  box.append(bar);
  if (!previewOn) {
    box.append(el("p", { className: "pvnote", textContent: "Off. Each preview is a real page load, logged out; turn it on to load the page after half a second on a tab." }));
    return box;
  }
  if (!isWeb(tab.url)) {
    box.append(el("p", { className: "pvnote", textContent: kindOf(tab.url) === "file"
      ? "Local files cannot be shown inside an extension page. Open reopens it through the helper."
      : "Browser and extension pages cannot be shown here. Open brings it back as a stand-in." }));
    return box;
  }
  const frame = el("iframe", { id: "pv-frame", title: `Preview of ${tab.title || tab.url}`, referrerPolicy: "no-referrer" });
  // No allow-top-navigation: a framed page cannot navigate this one away.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  box.append(frame, el("p", { className: "pvnote", textContent: "Logged out — Firefox keeps a framed page's cookies apart. Blank? The site refused anyway; Open it instead." }));
  previewTimer = setTimeout(() => { frame.src = tab.url; }, DWELL_MS);
  return box;
}

async function setPreview(on) {
  if (on && !(await browser.permissions.contains(ALL_SITES))) {
    // Asked here, from the click: a permission prompt must come from a user gesture.
    const granted = await browser.permissions.request(ALL_SITES).catch(() => false);
    if (!granted) { say("Previews need access to all sites; nothing changed"); on = false; }
  }
  previewOn = on;
  await browser.storage.local.set({ [PREVIEW_KEY]: on });
  renderDetail();
}

/* --- actions -------------------------------------------------------------------- */

async function judge(card, verdict) {
  const clearing = card.tab.verdict === verdict;
  const res = await send({ type: "judge-stashed", id: card.session.id, url: card.tab.url, verdict: clearing ? null : verdict });
  if (!res?.ok) return say(res?.error || "That did not work");
  if (!clearing) step(1);
  await load();
  say(clearing ? "Cleared" : verdict === "keep" ? "Kept" : "Dropped — Clear dropped on the Stashed tabs page removes it");
}

async function openNow(card) {
  const res = await send({ type: "restore-stash", id: card.session.id, urls: [card.tab.url] });
  if (!res?.ok) return say(res?.error || "Unable to open it");
  say(res.viaHelper ? "Opened through the helper" : res.standins ? `Opened as a stand-in${res.helperError ? `: ${res.helperError}` : ""}` : "Opened in a new tab");
}

async function toList(card) {
  if (!isWeb(card.tab.url)) return;
  step(1);
  const res = await send({ type: "move-stash", id: card.session.id, urls: [card.tab.url] });
  if (!res?.ok) return say(res?.error || "Unable to move it");
  await load();
  say(res.added ? "Moved to the reading list" : "Already on the reading list; taken out of the stash");
}

async function readNow(card, button) {
  if (!isWeb(card.tab.url)) return;
  let origin;
  try { origin = new URL(card.tab.url).origin + "/*"; } catch (e) { return say("That URL cannot be opened"); }
  const granted = await browser.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return say(`Reading it needs access to ${hostOf(card.tab.url)}`);
  if (button) { button.disabled = true; button.textContent = "Reading…"; }
  const res = await send({ type: "capture-url", url: card.tab.url });
  await load();
  say(res?.ok ? `Read ${res.record.title || hostOf(card.tab.url)}` : res?.error || "Unable to read it");
}

/* --- wiring --------------------------------------------------------------------- */

function refilter() {
  applyFilter();
  renderScope();
  renderSide();
  if (!visible.some(c => keyOf(c) === current) && visible[0]) current = keyOf(visible[0]);
  renderDetail();
}

$("q").addEventListener("input", refilter);
for (const chip of document.querySelectorAll(".chip")) chip.onclick = () => { filter = chip.dataset.f; refilter(); };
$("scope").onchange = () => {
  const v = $("scope").value;
  location.search = v === "all" ? "" : `?stash=${encodeURIComponent(v)}`;
};

addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("input, select, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const card = deck.find(c => keyOf(c) === current);
  const acts = {
    ArrowDown: () => step(1), ArrowUp: () => step(-1), k: () => card && judge(card, "keep"),
    d: () => card && judge(card, "drop"), o: () => card && openNow(card), l: () => card && toList(card),
    r: () => card && readNow(card, null), p: () => setPreview(!previewOn), "/": () => $("q").focus(),
  };
  const act = acts[e.key];
  if (act) { e.preventDefault(); act(); }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.sessions || changes.captures || changes.items)) load();
});

load();
