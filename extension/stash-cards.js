/* Explore: every link from the chosen sources in a sidebar, the chosen one in full beside it.
 *
 * The sidebar lists one stash, the reading list, or everything — stashes in the order they were
 * stashed, then the reading list's links; click any row to jump to it, or walk with ↑ ↓. The detail
 * pane shows what is known without touching the network — its capture if the page was ever read,
 * where else it is held — and
 * two things that do: Read (loads it in a background tab and extracts it) and the live preview.
 *
 * Keep and Drop are one verdict per URL, written to every copy; pressing one again clears it.
 * Nothing here can lose a tab: a drop is removed only by "Clear dropped" on the List page.
 */

const scope = new URLSearchParams(location.search).get("stash") || "all";
const PREVIEW_KEY = "stashPreview";
const ALL_SITES = { origins: ["*://*/*"] };
const DWELL_MS = 500;

let data = { links: [], stashes: [], all: { links: [], stashes: [] }, sources: new Set(), byKey: new Map() };
let deck = [];           // [{ link, stash?, tab?, pos? }] in sidebar order, for the chosen scope
let visible = [];        // deck after filter and verdict chips
let current = null;      // key of the card on show
let filter = "all";
let previewOn = false;
let previewTimer = null;

function say(text) { const m = $("msg"); if (m) m.textContent = text; }
const cardKey = c => c && (c.stash ? `${c.stash.id} ${c.tab.id}` : `list ${c.link.key}`);
const verdictOf = c => c.link.verdict || "open";

/* --- data ----------------------------------------------------------------------- */

async function load() {
  const [d, stored] = await Promise.all([loadLinks(), browser.storage.local.get(PREVIEW_KEY)]);
  data = d;
  previewOn = !!stored[PREVIEW_KEY];
  const shownStashes = new Set(data.stashes.map(s => s.id));
  const chosen = scope === "all" ? data.stashes : data.stashes.filter(s => s.id === scope);
  deck = chosen.flatMap(stash => stash.tabs.map((tab, pos) => ({ link: data.byKey.get(tab.key), stash, tab, pos })).filter(c => c.link));
  if ((scope === "all" || scope === "list") && data.sources.has("list")) {
    const listOnly = data.links.filter(l => l.list && !l.copies.some(c => shownStashes.has(c.stash)))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    deck.push(...listOnly.map(link => ({ link })));
  }
  applyFilter();
  if (!deck.some(c => cardKey(c) === current)) {
    // First load, or the card left (moved to the list): land on the first undecided one.
    const first = visible.find(c => !c.link.verdict) || visible[0];
    current = cardKey(first);
  }
  renderScope();
  renderSide();
  renderDetail();
}

const titleOf = c => labelOf(c.link) || (c.tab?.title) || null;

function applyFilter() {
  const term = $("q").value.trim().toLowerCase();
  visible = deck.filter(c => {
    const v = c.link.verdict;
    if (filter === "open" && v) return false;
    if ((filter === "keep" || filter === "drop") && v !== filter) return false;
    return !term || `${titleOf(c) || ""} ${c.link.url} ${c.link.cap?.text || ""} ${shownTags(c.link).tags.join(" ")}`.toLowerCase().includes(term);
  });
}

function renderScope() {
  const sel = $("scope");
  sel.textContent = "";
  // Counted as the sidebar lists them: a URL in two stashes is a row in each.
  const listN = data.sources.has("list") ? data.links.filter(l => l.list && !l.copies.some(c => data.stashes.some(s => s.id === c.stash))).length : 0;
  const stashedN = data.stashes.reduce((n, s) => n + s.tabs.length, 0);
  sel.append(el("option", { value: "all", textContent: `Everything on show (${stashedN + listN})` }));
  for (const s of data.stashes) sel.append(el("option", { value: s.id, textContent: `${stashName(s)} (${s.tabs.length})` }));
  if (data.sources.has("list")) sel.append(el("option", { value: "list", textContent: `Reading list (${listN})` }));
  sel.value = [...sel.options].some(o => o.value === scope) ? scope : "all";

  const counts = { all: deck.length, open: 0, keep: 0, drop: 0 };
  for (const c of deck) counts[verdictOf(c)]++;
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
    side.append(el("p", { className: "side-empty", textContent: deck.length ? "Nothing matches." : "Nothing on show." }));
    return;
  }
  let list = null, lastGroup = null;
  for (const card of visible) {
    const groupId = card.stash ? card.stash.id : "list";
    if (groupId !== lastGroup) {
      lastGroup = groupId;
      const shown = visible.filter(c => (c.stash ? c.stash.id : "list") === groupId).length;
      side.append(el("h2", {}, card.stash ? stashName(card.stash) : "Reading list", el("span", { className: "n", textContent: shown })));
      list = el("ul");
      side.append(list);
    }
    const title = titleOf(card);
    const tagLine = card.link.tags.length ? `\n${card.link.tags.join(", ")}` : "";
    const b = el("button", { title: (title ? `${title}\n${card.link.url}` : card.link.url) + tagLine },
      srcIcon(card.link.url),
      el("span", { className: `t${title ? "" : " plain"}`, textContent: title || shortUrl(card.link.url) }),
      el("span", { className: "m" }));
    b.dataset.key = cardKey(card);
    if (cardKey(card) === current) b.setAttribute("aria-current", "true");
    b.onclick = () => select(cardKey(card));
    list.append(el("li", { className: card.link.verdict || "" }, b));
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
  const i = visible.findIndex(c => cardKey(c) === current);
  const next = visible[i === -1 ? 0 : i + by];
  if (next) select(cardKey(next));
}

/* --- detail --------------------------------------------------------------------- */

const LIST_STATUS = { pending: "not opened yet", seen: "opened, undecided", kept: "kept", skipped: "skipped" };

function renderDetail() {
  const pane = $("detail");
  pane.textContent = "";
  clearTimeout(previewTimer);
  const card = deck.find(c => cardKey(c) === current);
  if (!card) {
    pane.append(el("div", { className: "empty" }, el("b", { textContent: "Nothing to show" }),
      deck.length ? "Nothing matches the filter." : "Choose a source with links in it in the bar at the top, or stash tabs with ⌃⇧S."));
    return;
  }
  const { link, stash, tab } = card;
  const url = link.url;
  const kind = kindOf(url);
  const i = visible.findIndex(c => cardKey(c) === current);
  const when = stash
    ? `stashed ${whenOf(stash.created_at)}${renamed(stash) ? ` · ${stash.name}` : ""}`
    : link.date ? `${link.list?.saved_at ? "saved" : "added"} ${whenOf(link.date)} · reading list` : "reading list";

  pane.append(el("div", { className: "dhead" }, srcIcon(url),
    el("div", {},
      el("div", { className: "where", textContent: kind === "web" ? hostOf(url) : kind === "file" ? "Local file" : "Browser page" }),
      el("div", { className: "when", textContent: when })),
    el("div", { className: "pos", textContent: i === -1 ? "" : `${i + 1} / ${visible.length}` })));

  const title = titleOf(card);
  pane.append(title
    ? el("h2", { className: "dtitle", textContent: title })
    : el("h2", { className: "dtitle plain", textContent: shortUrl(url) }));
  pane.append(el("div", { className: "durl", textContent: url }));

  const btn = (text, cls, hint, fn) => {
    const b = el("button", { className: cls, textContent: text, title: hint });
    b.onclick = fn;
    return b;
  };
  const keep = btn("Keep", "keep", "Keep it, wherever it is held (k)", () => judge(card, "keep"));
  const drop = btn("Drop", "drop", "Flag it dropped everywhere; Clear dropped on the List page removes stashed copies (d)", () => judge(card, "drop"));
  keep.setAttribute("aria-pressed", String(link.verdict === "keep"));
  drop.setAttribute("aria-pressed", String(link.verdict === "drop"));
  pane.append(el("div", { className: "acts" },
    btn("Open", "primary", stash ? "Reopen this tab now (o)" : "Open it in a new tab (o)", () => openNow(card)),
    keep, drop,
    canMoveToList(card) && btn("To list", "", "Move this web page to the reading list (l)", () => toList(card)),
    isWeb(url) && btn(link.cap ? "Re-read" : "Read", "", "Load it in a background tab and extract its text and images (r)", e => readNow(card, e.currentTarget))));

  const badges = el("div", { className: "badges" });
  if (link.verdict === "keep") badges.append(el("span", { className: "badge keep", textContent: "✓ Kept" }));
  if (link.verdict === "drop") badges.append(el("span", { className: "badge drop", textContent: "✕ Dropped" }));
  if (tab?.seen_at) badges.append(el("span", { className: "badge", textContent: `restored ${whenOf(tab.seen_at)}` }));
  if (tab?.container) badges.append(el("span", { className: "badge", textContent: "Container" }));
  if (stash?.source === "import") badges.append(el("span", { className: "badge", textContent: "Imported" }));
  if (kind === "other") badges.append(el("span", { className: "badge", textContent: "Opens as a stand-in" }));
  if (badges.childElementCount) pane.append(badges);
  // Tags edit in place here; t jumps into the field.
  const tagrow = el("div", { className: "tagrow" }, el("span", { className: "tagrow-label", textContent: "Tags" }), tagEditor(link, () => renderSide()));
  // Done with the field (Escape, or Enter on it empty): the arrow keys walk the sidebar again.
  tagrow.addEventListener("tagdone", () => document.activeElement?.blur());
  pane.append(tagrow);
  pane.append(el("p", { id: "msg", role: "status" }));

  pane.append(knownBox(card), previewBox(card));
  pane.append(el("p", { className: "keys" }, el("kbd", { textContent: "↑" }), " ", el("kbd", { textContent: "↓" }),
    " move · ", el("kbd", { textContent: "o" }), " open · ", el("kbd", { textContent: "k" }), " keep · ",
    el("kbd", { textContent: "d" }), " drop · ", el("kbd", { textContent: "l" }), " to list · ",
    el("kbd", { textContent: "r" }), " read · ", el("kbd", { textContent: "t" }), " tags · ", el("kbd", { textContent: "p" }), " preview on/off · ",
    el("kbd", { textContent: "/" }), " filter"));
}

const canMoveToList = c => !!(c.stash && isWeb(c.link.url) && !c.link.list && !c.stash.locked);

function knownBox(card) {
  const { link, stash } = card;
  const box = el("section", { className: "box" }, el("h3", { textContent: "What is known" }));
  const c = link.cap;
  if (c) {
    if (c.text) {
      box.append(el("div", { className: "captext" }, c.handle && el("span", { className: "who", textContent: `${c.handle} ` }), c.text));
    } else if (c.title && c.title !== titleOf(card)) {
      box.append(el("p", { className: "muted", textContent: c.title }));
    }
    if (c.images.length) {
      box.append(el("div", { className: "thumbs" }, ...c.images.slice(0, 8).map(src => {
        const img = el("img", { src, loading: "lazy", alt: "" });
        img.addEventListener("error", () => img.remove());
        return el("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, img);
      })));
    }
    if (c.links.length) {
      box.append(el("div", { className: "inner" }, ...c.links.slice(0, 8).map(href =>
        el("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: shortUrl(href), title: href }))));
    }
  }

  const facts = el("ul", { className: "facts" });
  if (c?.captured_at) facts.append(el("li", { textContent: `Read ${whenOf(c.captured_at)}` }));
  else if (isWeb(link.url)) facts.append(el("li", { textContent: "Never read — Read pulls its text and images in." }));
  if (link.list) facts.append(el("li", { textContent: `On the reading list — ${LIST_STATUS[link.list.status] || link.list.status}` }));
  for (const copy of link.copies) {
    if (stash && copy.stash === stash.id) continue;
    const s = data.all.stashes.find(x => x.id === copy.stash);
    if (!s) continue;
    const key = `${s.id} ${copy.tab}`;
    if (deck.some(d => cardKey(d) === key)) {
      const b = el("button", { className: "link", textContent: stashName(s) });
      b.onclick = () => { ensureVisible(); select(key); };
      facts.append(el("li", {}, stash ? "Also stashed in " : "Stashed in ", b));
    } else {
      facts.append(el("li", { textContent: `${stash ? "Also stashed" : "Stashed"} in ${stashName(s)}${data.stashes.some(x => x.id === s.id) ? "" : " (not on show)"}` }));
    }
  }
  if (kindOf(link.url) === "web") {
    const host = hostOf(link.url);
    const same = deck.filter(d => d.link.key !== link.key && isWeb(d.link.url) && hostOf(d.link.url) === host).length;
    if (same) {
      const b = el("button", { className: "link", textContent: `Show all ${same + 1}` });
      b.onclick = () => { $("q").value = host; refilter(); };
      facts.append(el("li", {}, `${plural(same, "other link")} from ${host} `, b));
    }
  }
  box.append(facts);
  return box;
}

/* A row the detail pane links to may be hidden by the filter; jumping to it clears the filter first. */
function ensureVisible() {
  if ($("q").value || filter !== "all") {
    $("q").value = "";
    filter = "all";
    applyFilter();
    renderScope();
    renderSide();
  }
}

function previewBox({ link }) {
  const url = link.url;
  const box = el("section", { className: "box" }, el("h3", { textContent: "Live preview" }));
  const toggle = el("input", { type: "checkbox", checked: previewOn });
  toggle.onchange = () => setPreview(toggle.checked);
  box.append(el("div", { className: "pvbar" }, el("label", {}, toggle, "Show the page here")));
  if (!previewOn) {
    box.append(el("p", { className: "pvnote", textContent: "Off. Each preview is a real page load, logged out; turn it on to load the page after half a second on a link." }));
    return box;
  }
  if (!isWeb(url)) {
    box.append(el("p", { className: "pvnote", textContent: kindOf(url) === "file"
      ? "Local files cannot be shown inside an extension page. Open reopens it through the helper."
      : "Browser and extension pages cannot be shown here. Open brings it back as a stand-in." }));
    return box;
  }
  const frame = el("iframe", { id: "pv-frame", title: `Preview of ${labelOf(link) || url}`, referrerPolicy: "no-referrer" });
  // No allow-top-navigation: a framed page cannot navigate this one away.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  box.append(frame, el("p", { className: "pvnote", textContent: "Logged out — Firefox keeps a framed page's cookies apart. Blank? The site refused anyway; Open it instead." }));
  previewTimer = setTimeout(() => { frame.src = url; }, DWELL_MS);
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
  const clearing = card.link.verdict === verdict;
  const res = await send({ type: "judge-link", url: card.link.url, verdict: clearing ? null : verdict });
  if (!res?.ok) return say(res?.error || "That did not work");
  if (!clearing) step(1);
  await load();
  say(clearing ? "Cleared" : verdict === "keep" ? "Kept" : "Dropped — Clear dropped on the List page removes stashed copies");
}

async function openNow(card) {
  if (!card.stash) {
    await send({ type: "set-current", url: card.link.url });
    await browser.tabs.create({ url: card.link.url });
    return say("Opened in a new tab");
  }
  const res = await send({ type: "restore-stash", id: card.stash.id, ids: [card.tab.id] });
  if (!res?.ok) return say(res?.error || "Unable to open it");
  say(res.viaHelper ? "Opened through the helper" : res.standins ? `Opened as a stand-in${res.helperError ? `: ${res.helperError}` : ""}` : "Opened in a new tab");
}

async function toList(card) {
  if (!canMoveToList(card)) return;
  step(1);
  const res = await send({ type: "move-stash", id: card.stash.id, ids: [card.tab.id] });
  if (!res?.ok) return say(res?.error || "Unable to move it");
  await load();
  say(res.added ? "Moved to the reading list" : "Already on the reading list; taken out of the stash");
}

async function readNow(card, button) {
  if (!isWeb(card.link.url)) return;
  if (button) { button.disabled = true; button.textContent = "Reading…"; }
  const res = await readLink(card.link.url);
  await load();
  say(res?.ok ? `Read ${res.record.title || hostOf(card.link.url)}` : res?.error || "Unable to read it");
}

/* --- wiring --------------------------------------------------------------------- */

function refilter() {
  applyFilter();
  renderScope();
  renderSide();
  if (!visible.some(c => cardKey(c) === current) && visible[0]) current = cardKey(visible[0]);
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
  const card = deck.find(c => cardKey(c) === current);
  const acts = {
    ArrowDown: () => step(1), ArrowUp: () => step(-1), k: () => card && judge(card, "keep"),
    d: () => card && judge(card, "drop"), o: () => card && openNow(card), l: () => card && toList(card),
    r: () => card && readNow(card, null), p: () => setPreview(!previewOn), "/": () => $("q").focus(),
    t: () => document.querySelector("#detail .tagger input")?.focus(),
  };
  const run = acts[e.key];
  if (run) { e.preventDefault(); run(); }
});

reloadOnChanges(load);
load();
