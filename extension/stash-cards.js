/* Explore: every link from the chosen sources in a sidebar, the chosen one in full beside it.
 *
 * The sidebar lists one stash, the reading list, or everything — stashes in the order they were
 * stashed, then the reading list's links; click any row to jump to it, or walk with W S, the detail
 * following; A D jump a stash, and Space scrolls the detail. The detail
 * pane shows what is known without touching the network — its capture if the page was ever read,
 * where else it is held — and
 * two things that do: Read (loads it in a background tab and extracts it) and the live preview.
 *
 * The actions and their keys are every page's (link-actions.js, link-keys.js): keep and drop are one
 * verdict per URL, written to every copy, and pressing one again clears it.
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

/* The message line sits in the detail pane, which every reload redraws: it keeps the last message
 * until another link is chosen. */
let said = "";
function say(text) { said = text; const m = $("msg"); if (m) m.textContent = text; }
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
    if (filter === "untagged" && c.link.tags.length) return false;
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
  sel.append(el("option", { value: "all", textContent: `Everything shown (${stashedN + listN})` }));
  for (const s of data.stashes) sel.append(el("option", { value: s.id, textContent: `${stashName(s)} (${s.tabs.length})` }));
  if (data.sources.has("list")) sel.append(el("option", { value: "list", textContent: `Reading list (${listN})` }));
  sel.value = [...sel.options].some(o => o.value === scope) ? scope : "all";

  const counts = { all: deck.length, open: 0, keep: 0, drop: 0, untagged: deck.filter(c => !c.link.tags.length).length };
  for (const c of deck) counts[verdictOf(c)]++;
  for (const chip of document.querySelectorAll(".chip")) {
    const label = { all: "All", open: "Undecided", keep: "Kept", drop: "Dropped", untagged: "Untagged" }[chip.dataset.f];
    chip.replaceChildren(`${label} `, el("span", { className: "n", textContent: counts[chip.dataset.f] }));
    chip.setAttribute("aria-pressed", String(chip.dataset.f === filter));
  }
}

/* --- sidebar -------------------------------------------------------------------- */

function renderSide() {
  const side = $("side");
  side.textContent = "";
  if (!visible.length) {
    side.append(el("p", { className: "side-empty", textContent: deck.length ? "Nothing matches." : "Nothing shown." }));
    return;
  }
  let list = null, lastGroup = null;
  for (const card of visible) {
    const groupId = card.stash ? card.stash.id : "list";
    if (groupId !== lastGroup) {
      lastGroup = groupId;
      const shown = visible.filter(c => (c.stash ? c.stash.id : "list") === groupId).length;
      const h2 = el("h2", {}, card.stash ? stashName(card.stash) : "Reading list", el("span", { className: "n", textContent: shown }));
      if (card.stash) h2.dataset.stash = card.stash.id;
      side.append(h2);
      list = el("ul");
      side.append(list);
    }
    const title = titleOf(card);
    const b = el("button", {},
      srcIcon(card.link.url),
      el("span", { className: `t${title ? "" : " plain"}`, textContent: title || shortUrl(card.link.url) }),
      readMark(card.link), el("span", { className: "m" }));
    b.dataset.key = cardKey(card);
    Peek.mark(b, "link", card.link.key);
    if (cardKey(card) === current) b.setAttribute("aria-current", "true");
    b.onclick = () => select(cardKey(card));
    list.append(el("li", { className: card.link.verdict || "" }, b));
  }
  side.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  markHeads();
}

/* A stash heading previews its stash, opened on the chosen link when it is one of its tabs. */
function markHeads() {
  const chosen = visible.find(c => cardKey(c) === current);
  for (const h2 of document.querySelectorAll("#side h2[data-stash]")) {
    const id = h2.dataset.stash;
    Peek.mark(h2, "stash", chosen?.stash?.id === id ? `${id}|${chosen.link.key}` : id);
  }
}

function select(key) {
  if (!key || key === current) return;
  current = key;
  said = "";
  for (const b of document.querySelectorAll("#side button[aria-current]")) b.removeAttribute("aria-current");
  const row = document.querySelector(`#side button[data-key="${CSS.escape(key)}"]`);
  row?.setAttribute("aria-current", "true");
  row?.scrollIntoView({ block: "nearest" });
  markHeads();
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
      el("div", { className: "when" }, `${when} `, readBadge(link))),
    el("div", { className: "pos", textContent: i === -1 ? "" : `${i + 1} / ${visible.length}` })));

  const title = titleOf(card);
  pane.append(title
    ? el("h2", { className: "dtitle", textContent: title })
    : el("h2", { className: "dtitle plain", textContent: shortUrl(url) }));
  pane.append(el("div", { className: "durl", textContent: url }));

  pane.append(LinkActions.bar(card));

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
  pane.append(el("p", { id: "msg", role: "status", textContent: said }));

  pane.append(knownBox(card), previewBox(card));
  pane.append(el("p", { className: "keys" }, ...LinkKeys.hint(["prev", "next", "group-next", "drop", "keep", "open", "read", "tags", "preview"])));
}

function knownBox(card) {
  const { link, stash } = card;
  const box = el("section", { className: "box" }, el("h3", { textContent: "Page content" }));
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
  if (c?.captured_at) facts.append(el("li", { textContent: `Captured ${whenOf(c.captured_at)}` }));
  else if (isWeb(link.url)) facts.append(el("li", { textContent: "Not captured yet. Capture saves its text and images." }));
  if (link.list) facts.append(el("li", { textContent: `On the reading list: ${LIST_STATUS[link.list.status] || link.list.status}` }));
  for (const copy of link.copies) {
    if (stash && copy.stash === stash.id) continue;
    const s = data.all.stashes.find(x => x.id === copy.stash);
    if (!s) continue;
    const key = `${s.id} ${copy.tab}`;
    if (deck.some(d => cardKey(d) === key)) {
      const b = el("button", { className: "link", textContent: stashName(s) });
      b.onclick = () => { ensureVisible(); select(key); };
      Peek.mark(b, "stash", `${s.id}|${link.key}`);
      facts.append(el("li", {}, stash ? "Also stashed in " : "Stashed in ", b));
    } else {
      facts.append(el("li", {}, `${stash ? "Also stashed" : "Stashed"} in `, Peek.mark(el("span", { className: "peekable", textContent: stashName(s) }), "stash", `${s.id}|${link.key}`),
        data.stashes.some(x => x.id === s.id) ? "" : " (not shown)"));
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
    box.append(el("p", { className: "pvnote", textContent: "Off. Each preview loads the real page, logged out. Turn it on to load a page half a second after you select its link." }));
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
  box.append(frame, el("p", { className: "pvnote", textContent: "You are logged out here, because Firefox keeps cookies for framed pages separate. If the preview is blank, the site refused to be shown; use Open instead." }));
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

/* After an action: a verdict moves on to the next link, as does anything that takes the link out of
 * the row it had (to the list, a move, a removal); then everything reloads — or, for a verdict, which
 * the data already holds, redraws. */
LinkActions.setup({
  data: () => data,
  say,
  async after(cmd, target, res) {
    if (res.ok === false) return;
    const leaves = ["list", "move", "remove"].includes(cmd) || (cmd === "open" && /taken out/.test(res.say || ""));
    if (((cmd === "keep" || cmd === "drop") && !res.cleared) || leaves) {
      const i = visible.findIndex(c => cardKey(c) === current);
      const next = visible[i + 1] || visible[i - 1];
      if (next) current = cardKey(next);
    }
    if (res.local) refilter();
    else await load();
  },
  tags: () => document.querySelector("#detail .tagger input")?.focus(),
  tagNext: () => { step(1); document.querySelector("#detail .tagger input")?.focus(); },
});

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

/* The sidebar and the detail move together: W S walk the links, A D jump to the first link of the
 * previous or next stash (the reading list counts as one), Space and ⇧Space scroll a long detail. */
const groupOf = c => c.stash?.id || "list";
function jumpGroup(by) {
  const i = Math.max(0, visible.findIndex(c => cardKey(c) === current));
  const here = visible[i] && groupOf(visible[i]);
  let j = i;
  if (by > 0) { while (j < visible.length && groupOf(visible[j]) === here) j++; }
  else {
    // Back to this stash's start, or, from its start, to the previous stash's.
    while (j > 0 && groupOf(visible[j - 1]) === here) j--;
    if (j === i && j > 0) { const prev = groupOf(visible[j - 1]); j--; while (j > 0 && groupOf(visible[j - 1]) === prev) j--; }
  }
  if (visible[j] && j !== i) select(cardKey(visible[j]));
}
addEventListener("keydown", e => {
  if (e.key !== " " || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
  e.preventDefault();
  $("detail").scrollBy({ top: (e.shiftKey ? -1 : 1) * $("detail").clientHeight * 0.8, behavior: "smooth" });
});
const onCard = cmd => () => {
  const card = deck.find(c => cardKey(c) === current);
  LinkActions.key(cmd, card, document.querySelector(`#detail .lk-bar [data-cmd="${cmd === "open-other" ? "open" : cmd}"]`) || $("detail"));
};
LinkKeys.listen({
  prev: () => step(-1), next: () => step(1),
  "group-prev": () => jumpGroup(-1), "group-next": () => jumpGroup(1),
  drop: onCard("drop"), keep: onCard("keep"), read: onCard("read"), open: onCard("open"), "open-other": onCard("open-other"),
  tags: onCard("tags"), list: onCard("list"), move: onCard("move"), remove: onCard("remove"),
  undo: () => LinkActions.undo(), filter: () => $("q").focus(), preview: () => setPreview(!previewOn),
  escape: () => document.querySelector(".tagpop")?.remove(),
}, { labels: { "group-prev": "◂ stash", "group-next": "stash ▸" } });

reloadOnChanges(load);
load();
