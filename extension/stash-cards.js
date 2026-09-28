/* Stashed tabs as a stack of cards, one stash or all of them, in the order they were stashed.
 *
 * No swiping: each card carries buttons. Open reopens the tab now; Keep and Drop set a verdict and
 * advance, and pressing the same one again clears it; To list hands a web page to the reading list
 * and takes it out of the stash. A drop is only a flag — "Clear dropped" on the list page is what
 * removes dropped tabs — so nothing here can lose a tab.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

const scope = new URLSearchParams(location.search).get("stash") || "all";
let sessions = [];
let deck = [];        // [{ session, tab }]
let index = 0;
let placed = false;   // the first load lands on the first undecided card; later loads keep place

function say(text) { $("msg").textContent = text; }

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function shortUrl(url) { return String(url).replace(/^https?:\/\/(www\.)?/, ""); }

function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const isWeb = url => /^(https?|ftp):/.test(url);
function kindOf(url) {
  if (isWeb(url) || url.startsWith(browser.runtime.getURL(""))) return "web";
  return /^file:/.test(url) ? "file" : "other";
}

const keyOf = card => card && `${card.session.id} ${card.tab.url}`;

async function load() {
  const keep = keyOf(deck[index]);
  ({ sessions } = await send({ type: "sessions" }));
  const chosen = scope === "all" ? sessions : sessions.filter(s => s.id === scope);
  deck = chosen.flatMap(session => session.tabs.map(tab => ({ session, tab })));

  if (!placed) {
    const first = deck.findIndex(c => !c.tab.verdict);
    index = first === -1 ? 0 : first;
    placed = true;
  } else if (keep) {
    // Stay on the same card if it is still here; if it left (moved to the list), the next one
    // has slid into its place, so the index already points at it.
    const same = deck.findIndex(c => keyOf(c) === keep);
    if (same !== -1) index = same;
  }
  index = Math.max(0, Math.min(index, deck.length - 1));
  renderScope();
  render();
}

function renderScope() {
  const sel = $("scope");
  sel.textContent = "";
  const total = sessions.reduce((n, s) => n + s.tabs.length, 0);
  sel.append(el("option", { value: "all", textContent: `All stashes (${total})` }));
  for (const s of sessions) {
    sel.append(el("option", { value: s.id, textContent: `${s.name || whenOf(s.created_at)} (${s.tabs.length})` }));
  }
  sel.value = sessions.some(s => s.id === scope) ? scope : "all";
}

$("scope").onchange = () => {
  const v = $("scope").value;
  location.search = v === "all" ? "" : `?stash=${encodeURIComponent(v)}`;
};

function cardEl(card, depth) {
  const { session, tab } = card;
  const kind = kindOf(tab.url);
  const node = el("article", { className: `card ${depth ? `behind behind-${depth}` : "top"}` });
  node.style.zIndex = String(10 - depth);
  if (depth) {
    node.setAttribute("aria-hidden", "true");
    return node;   // cards behind are only the edge of the stack
  }
  if (tab.verdict === "drop") node.classList.add("dropped");

  const where = kind === "web" ? hostOf(tab.url) : kind === "file" ? "Local file" : "Browser page";
  node.append(el("div", { className: "head" }, srcIcon(tab.url),
    el("div", {}, el("div", { className: "host", textContent: where }),
      el("div", { className: "when", textContent: `stashed ${whenOf(session.created_at)}${session.name ? ` · ${session.name}` : ""}` }))));

  node.append(tab.title
    ? el("div", { className: "title", textContent: tab.title })
    : el("div", { className: "title plain", textContent: shortUrl(tab.url) }));
  if (tab.title) node.append(el("div", { className: "path", textContent: shortUrl(tab.url) }));

  const badges = el("div", { className: "badges" });
  if (tab.verdict === "keep") badges.append(el("span", { className: "badge keep", textContent: "✓ Kept" }));
  if (tab.verdict === "drop") badges.append(el("span", { className: "badge drop", textContent: "✕ Dropped" }));
  if (tab.seen_at) badges.append(el("span", { className: "badge", textContent: `restored ${whenOf(tab.seen_at)}` }));
  if (tab.container) badges.append(el("span", { className: "badge", textContent: "Container" }));
  if (kind === "other") badges.append(el("span", { className: "badge", textContent: "Opens as a stand-in" }));
  if (badges.childElementCount) node.append(badges);
  return node;
}

function render() {
  const stage = $("stage");
  stage.textContent = "";
  const counts = { keep: 0, drop: 0 };
  for (const c of deck) if (c.tab.verdict) counts[c.tab.verdict]++;
  $("t-kept").textContent = counts.keep;
  $("t-dropped").textContent = counts.drop;
  $("t-left").textContent = deck.length - counts.keep - counts.drop;
  $("bar").style.width = deck.length ? `${(counts.keep + counts.drop) / deck.length * 100}%` : "0";

  const card = deck[index];
  for (const id of ["prev", "next", "open", "keep", "drop", "tolist"]) $(id).disabled = !card;
  if (!card) {
    $("pos").textContent = "—";
    stage.append(el("div", { className: "done" }, el("b", { textContent: "Nothing stashed here" }),
      "Stash tabs with ", el("kbd", { textContent: "⌃⇧S" }), " and they will show up as cards."));
    return;
  }

  $("pos").textContent = `${index + 1} / ${deck.length}`;
  // Drawn back to front so the top card lands last.
  for (let depth = 2; depth >= 0; depth--) {
    if (deck[index + depth]) stage.append(cardEl(deck[index + depth], depth));
  }
  $("prev").disabled = index === 0;
  $("next").disabled = index >= deck.length - 1;
  $("keep").setAttribute("aria-pressed", String(card.tab.verdict === "keep"));
  $("drop").setAttribute("aria-pressed", String(card.tab.verdict === "drop"));
  $("tolist").hidden = !isWeb(card.tab.url);
}

function step(by) {
  const to = index + by;
  if (to < 0 || to >= deck.length) return;
  index = to;
  render();
}

async function judge(verdict) {
  const card = deck[index];
  if (!card) return;
  const clearing = card.tab.verdict === verdict;
  const res = await send({ type: "judge-stashed", id: card.session.id, url: card.tab.url, verdict: clearing ? null : verdict });
  if (!res?.ok) return say(res?.error || "That did not work");
  say(clearing ? "Cleared" : verdict === "keep" ? "Kept" : "Dropped — Clear dropped on the list removes it");
  if (!clearing && index < deck.length - 1) index++;
  await load();
}

async function openNow() {
  const card = deck[index];
  if (!card) return;
  const res = await send({ type: "restore-stash", id: card.session.id, urls: [card.tab.url] });
  if (!res?.ok) return say(res?.error || "Unable to open it");
  say(res.viaHelper ? "Opened through the helper" : res.standins ? `Opened as a stand-in${res.helperError ? `: ${res.helperError}` : ""}` : "Opened in a new tab");
  await load();
}

async function toList() {
  const card = deck[index];
  if (!card || !isWeb(card.tab.url)) return;
  const res = await send({ type: "move-stash", id: card.session.id, urls: [card.tab.url] });
  if (!res?.ok) return say(res?.error || "Unable to move it");
  say(res.added ? "Moved to the reading list" : "Already on the reading list; taken out of the stash");
  await load();
}

$("prev").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("open").onclick = openNow;
$("keep").onclick = () => judge("keep");
$("drop").onclick = () => judge("drop");
$("tolist").onclick = toList;

addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("select, input, textarea")) return;
  const act = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), o: openNow,
    k: () => judge("keep"), d: () => judge("drop"), l: toList }[e.key];
  if (act) { e.preventDefault(); act(); }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sessions) load();
});

load();
