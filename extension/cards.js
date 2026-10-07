/* A shuffled deck of every undecided link in the sources chosen in the top bar.
 *
 * A card shows what is known: a page that was read carries its author, title, text, images and
 * screenshot; a stashed tab never read shows its tab title and address. Reading first (Read on the
 * List or Explore page) makes a card easier to judge.
 *
 * Keep and drop are one verdict per URL, written to every copy — capture, reading-list entry and
 * each stash. Neither deletes anything: a drop is a flag, so a change of mind costs one click.
 *
 * The actions under the card and their keys are every page's (link-actions.js, link-keys.js). The
 * deck and the sidebar move together: S (or 2) deals the next card without a verdict (Later), W
 * steps back, and A D deal the first link of the previous or next stash in the sidebar.
 */

const THRESHOLD = 105;

let deck = [];
let index = 0;
let tally = { keep: 0, drop: 0 };

function say(text) { $("msg").textContent = text; }

/* Stable hue per domain, so the same site always wears the same colour. */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/* A plain tweet's title is only its handle, so its text is what identifies it. */
function headline(card) {
  const body = (card.text || "").replace(/\s+/g, " ").trim();
  if (card.title && !/^@?\S+ on X$|^X post$/.test(card.title)) {
    return card.handle && !card.title.includes(card.handle)
      ? `${card.handle}: ${card.title}`
      : card.title;
  }
  if (body) {
    const clipped = body.length > 420 ? body.slice(0, 420) + "…" : body;
    return (card.handle ? `${card.handle}: ` : "") + clipped;
  }
  return card.handle || shortUrl(card.url);
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function toCard(link) {
  const cap = link.cap || {};
  return {
    url: link.url,
    kind: cap.kind || null,
    title: cap.title || link.title || null,
    handle: cap.handle || null,
    name: cap.name || null,
    text: cap.text || null,
    note: cap.note || link.list?.note || null,
    saved_at: link.date || null,
    images: cap.images || [],
    links: cap.links || [],
    reply_links: cap.reply_links || [],
    shotThumb: cap.shotThumb || null,
    code_blocks: cap.code_blocks || 0,
    link,
  };
}

/* Deal one tag at a time, as swipe-sort deals one source: similar links are quicker to judge
 * together. "" is every tag; UNTAGGED the links with none set by hand. */
const TAG_KEY = "cardsTag";
const UNTAGGED = "\u0000untagged";
let dealTag = "";
try { dealTag = localStorage.getItem(TAG_KEY) || ""; } catch (e) { /* storage blocked: every tag */ }
const inDeal = l => !dealTag || (dealTag === UNTAGGED ? !l.tags.length : shownTags(l).tags.includes(dealTag));

function renderTagPick(links) {
  const sel = $("deal-tag");
  const undecided = links.filter(l => !l.verdict);
  const counts = new Map();
  for (const l of undecided) for (const t of shownTags(l).tags) counts.set(t, (counts.get(t) || 0) + 1);
  sel.textContent = "";
  sel.append(el("option", { value: "", textContent: `Every tag (${undecided.length})` }));
  const untagged = undecided.filter(l => !l.tags.length).length;
  if (untagged) sel.append(el("option", { value: UNTAGGED, textContent: `Untagged (${untagged})` }));
  for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    sel.append(el("option", { value: t, textContent: `${t} (${n})` }));
  }
  if (dealTag && ![...sel.options].some(o => o.value === dealTag)) sel.append(el("option", { value: dealTag, textContent: `${dealTag === UNTAGGED ? "Untagged" : dealTag} (0)` }));
  sel.value = dealTag;
}

let known = 0;
let data = null;
let stashes = [], onShow = new Set(), sources = new Set(), allLinks = [], byKey = new Map();

function takeData(d) {
  data = d;
  known = d.links.length;
  stashes = d.all.stashes;
  allLinks = d.all.links;
  byKey = new Map(d.all.links.map(l => [l.key, l]));
  sources = d.sources;
  onShow = new Set(d.stashes.map(s => s.id));
  tally = { keep: d.links.filter(l => l.verdict === "keep").length, drop: d.links.filter(l => l.verdict === "drop").length };
  renderTagPick(d.links);
}

/* A new deal: every undecided link, shuffled. */
async function load() {
  takeData(await loadLinks());
  deck = shuffle(data.links.filter(l => !l.verdict && inDeal(l)).map(toCard));
  index = 0;
  buildSide();
  render();
}

/* After an action: the data again, with the deck in hand kept — each card takes its link's state. */
async function refresh() {
  takeData(await loadLinks());
  deck = deck.map(c => (byKey.has(c.link.key) ? toCard(byKey.get(c.link.key)) : c));
  buildSide();
}

/* After a verdict, which the data already holds: the tally and the sidebar again, nothing reloaded. */
function recount() {
  tally = { keep: data.links.filter(l => l.verdict === "keep").length, drop: data.links.filter(l => l.verdict === "drop").length };
  buildSide();
}

function cardEl(card, top) {
  const el = document.createElement("article");
  el.className = "card" + (top ? " top" : "");
  const host = hostOf(card.url);

  const head = document.createElement("div");
  head.className = "head";
  const mono = document.createElement("div");
  mono.className = "mono";
  mono.style.background = `hsl(${hue(host)} 58% 45%)`;
  mono.textContent = (host.match(/[a-z0-9]/i) || ["?"])[0].toUpperCase();
  const names = document.createElement("div");
  names.append(Object.assign(document.createElement("div"), {
    className: "host",
    textContent: card.name ? `${card.name} · ${host}` : host,
  }));
  const bits = [];
  if (card.saved_at) bits.push(`saved ${String(card.saved_at).slice(0, 10)}`);
  if (card.kind && card.kind !== "page") bits.push(card.kind);
  if (card.code_blocks) bits.push(`${card.code_blocks} code block${card.code_blocks > 1 ? "s" : ""}`);
  const restored = card.link.copies.map(c => c.seen_at).filter(Boolean).sort().pop();
  if (restored) bits.push(`restored ${dayOf(restored)}`);
  const when = Object.assign(document.createElement("div"), { className: "when", textContent: `${bits.join(" · ")} ` });
  when.append(...[verdictBadge(card.link), readBadge(card.link)].filter(Boolean));
  names.append(when);
  head.append(mono, names);
  const chips = tagChips(card.link);
  if (chips) head.append(chips);
  el.append(head);

  el.append(Object.assign(document.createElement("div"), {
    className: "title", textContent: headline(card),
  }));

  const body = (card.text || "").replace(/\s+/g, " ").trim();
  if (body && !headline(card).includes(body.slice(0, 40))) {
    el.append(Object.assign(document.createElement("div"), { className: "body", textContent: body }));
  }

  if (card.note) {
    el.append(Object.assign(document.createElement("div"), { className: "note", textContent: card.note }));
  }

  if (card.links.length) {
    const inner = document.createElement("div");
    inner.className = "inner";
    for (const url of card.links.slice(0, 4)) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = shortUrl(url);
      inner.append(a);
    }
    el.append(inner);
  }

  if (card.reply_links?.length) {
    const box = document.createElement("div");
    box.className = "inner replies";
    for (const l of card.reply_links.slice(0, 5)) {
      const a = document.createElement("a");
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = l.self ? "from-author" : "";
      a.textContent = `↩ ${shortUrl(l.href)}`;
      a.title = l.self ? `from the author's own reply (${l.from || "?"})` : `from a reply by ${l.from || "?"}`;
      box.append(a);
    }
    el.append(box);
  }

  const pics = [...(card.shotThumb ? [card.shotThumb] : []), ...card.images.slice(0, 3)];
  if (pics.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    for (const src of pics) {
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.alt = "";
      thumbs.append(img);
    }
    el.append(thumbs);
  }

  const ctx = contextEl(card);
  if (ctx) el.append(ctx);

  const foot = document.createElement("div");
  foot.className = "foot";
  const open = document.createElement("a");
  open.className = "open";
  open.href = card.url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open ↗";
  open.addEventListener("click", e => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    LinkActions.run("open", { link: card.link });
  });
  foot.append(open, Object.assign(document.createElement("span"), {
    className: "siblings", textContent: shortUrl(card.url).slice(0, 60),
  }));
  el.append(foot);

  el.append(Object.assign(document.createElement("div"), { className: "stamp keep", textContent: "keep" }));
  el.append(Object.assign(document.createElement("div"), { className: "stamp skip", textContent: "drop" }));
  return el;
}

/* Where a card came from. The newest stash on show is its home, where the sidebar marks it; the card
 * names the other places the same URL is held. */
const LIST_STATUS = { pending: "not opened yet", seen: "opened, undecided", kept: "kept", skipped: "skipped" };

function heldIn(link) {
  return link.copies
    .map(c => ({ copy: c, stash: stashes.find(s => s.id === c.stash) }))
    .filter(h => h.stash)
    .sort((a, b) => onShow.has(b.stash.id) - onShow.has(a.stash.id) || String(b.stash.created_at).localeCompare(String(a.stash.created_at)));
}

function contextEl(card) {
  const link = card.link;
  const held = heldIn(link);
  const facts = [];
  // The other stashes holding it, previewed on hover.
  if (held.length > 1) facts.push(Peek.mark(el("span", { className: "peekable", textContent: `Also in ${plural(held.length - 1, "other stash")}: ${held.slice(1, 3).map(h => stashName(h.stash)).join(", ")}${held.length > 3 ? ", …" : ""}` }), "held", link.key));
  if (link.list && held.length) facts.push(`on the reading list: ${LIST_STATUS[link.list.status] || link.list.status}`);
  if (isWeb(link.url)) {
    const host = hostOf(link.url);
    const same = deck.slice(index).filter(c => c.link.key !== link.key && isWeb(c.url) && hostOf(c.url) === host).length;
    if (same) facts.push(`${same} more from ${host} in this deck`);
  }
  return facts.length ? el("div", { className: "ctx" }, ...facts.flatMap((f, i) => (i ? [" · ", f] : [f]))) : null;
}

/* The sidebar: every stash on show and then the reading list, as Explore lists them, with the top
 * card marked in its home stash. Built once per deal; each new card only moves the marks. Any row
 * deals its link next, decided or not. */
let sideRows = [];
function buildSide() {
  const side = $("side");
  side.textContent = "";
  sideRows = [];
  const group = (id, name, sub, rows) => {
    if (!rows.length) return;
    const ul = el("ul");
    for (const r of rows) {
      const title = r.title || shortUrl(r.url);
      const b = el("button", {}, srcIcon(r.url),
        el("span", { className: `t${r.title ? "" : " plain"}`, textContent: title }), readMark(byKey.get(r.key) || { url: r.url }), el("span", { className: "m" }));
      b.onclick = () => dealNext(r.key);
      Peek.mark(b, "link", r.key);
      sideRows.push({ group: id, key: r.key, b });
      ul.append(el("li", {}, b));
    }
    const h2 = el("h2", { title: sub }, el("span", { className: "t", textContent: name }), el("span", { className: "n", textContent: rows.length }));
    if (id !== "list") Peek.mark(h2, "stash", id);
    side.append(el("section", { className: "grp" }, h2, ul));
  };
  const inShown = new Set();
  for (const s of stashes.filter(s => onShow.has(s.id))) {
    for (const t of s.tabs) inShown.add(t.key);
    group(s.id, stashName(s), `${s.source === "import" ? "Imported" : "Stashed"} ${whenOf(s.created_at)}`,
      s.tabs.map(t => ({ key: t.key, url: t.url, title: labelOf(byKey.get(t.key) || {}) || t.title })));
  }
  if (sources.has("list")) {
    group("list", "Reading list", "Links you queued to read, and pages you kept",
      allLinks.filter(l => l.list && !inShown.has(l.key)).sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map(l => ({ key: l.key, url: l.url, title: labelOf(l) })));
  }
}

function renderSide() {
  const card = deck[index];
  const home = card ? (heldIn(card.link).find(h => onShow.has(h.stash.id))?.stash.id || "list") : null;
  let mark = null;
  for (const r of sideRows) {
    const link = byKey.get(r.key);
    r.b.parentElement.className = link?.verdict || "";
    const here = !!card && r.key === card.link.key && r.group === home;
    r.b.toggleAttribute("aria-current", here);
    if (here) mark = r.b;
  }
  // Scroll the sidebar alone: scrollIntoView would move the page too.
  if (mark) {
    const side = $("side"), r = mark.getBoundingClientRect(), box = side.getBoundingClientRect();
    const head = mark.closest(".grp").querySelector("h2").offsetHeight;
    if (r.top < box.top + head) side.scrollTop -= box.top + head - r.top;
    else if (r.bottom > box.bottom) side.scrollTop += r.bottom - box.bottom;
  }
}

/* Deal any link next from a sidebar click: the card already in the deck if it is still to come,
 * else a fresh card for it — so a decided link can be judged again. */
function dealNext(key) {
  if (deck[index]?.link.key === key) return;
  const link = byKey.get(key);
  if (!link) return;
  const i = deck.findIndex((c, j) => j > index && c.link.key === key);
  const card = i === -1 ? toCard(link) : deck.splice(i, 1)[0];
  deck.splice(index, 0, card);
  render();
}

function render() {
  const total = deck.length;
  const left = total - index;
  $("bar").style.width = total ? `${index / total * 100}%` : "100%";
  $("pos").textContent = total ? `${index} of ${total} this session` : "nothing to judge";
  $("t-kept").textContent = tally.keep;
  $("t-skipped").textContent = tally.drop;
  $("t-left").textContent = left;
  renderActions();

  renderSide();
  const stage = $("stage");
  stage.textContent = "";

  if (left <= 0) {
    const [head, rest] = total
      ? ["Deck finished.", "All undecided links in the chosen sources have been shown. "]
      : known
        ? ["Nothing undecided.", "Every link in the chosen sources already has a verdict. "]
        : ["Nothing to judge.", "Choose a source with links in it in the bar at the top, or stash some tabs. "];
    stage.append(el("div", { className: "done" }, el("b", { textContent: head }), rest,
      el("a", { href: "list.html", textContent: "The whole list →" })));
    return;
  }

  deck.slice(index, index + 3).reverse().forEach((card, i, arr) => {
    const depth = arr.length - 1 - i;
    const el = cardEl(card, depth === 0);
    el.style.transform = `translateY(${depth * 9}px) scale(${1 - depth * 0.035})`;
    el.style.opacity = depth > 1 ? ".55" : "1";
    el.style.zIndex = String(10 - depth);
    stage.append(el);
  });

  arm(stage.querySelector(".card.top"), deck[index]);
}

/* --- verdicts --- */

/* The top card leaves: right for keep, left for drop, up for Later. */
let flying = false;
function fly(xdir, ydir = 0) {
  const top = $("stage").querySelector(".card.top");
  if (!top) return;
  flying = true;
  top.style.transition = "transform .28s ease-out, opacity .28s ease-out";
  top.style.transform = `translate(${xdir * 620}px, ${ydir * 620 + (ydir ? 0 : 40)}px) rotate(${xdir * 22}deg)`;
  top.style.opacity = "0";
}

/* Keep or drop the top card, from a key, a button or a drag. On a card already judged that way it
 * clears the verdict instead, and the card stays. */
function decide(verdict) {
  const card = deck[index];
  if (!card) return;
  if (card.link.verdict !== verdict) fly(verdict === "keep" ? 1 : -1);
  LinkActions.run(verdict, { link: card.link }, { mark: { index } });
}

/* Later: the next card, no verdict recorded; it comes back next session. Undo brings it back. */
function later() {
  const card = deck[index];
  if (!card) return;
  fly(0, -1);
  LinkActions.push({ label: "Later", cmd: "later", target: { link: card.link }, mark: { index }, run: async () => ({ ok: true }) });
  index++;
  setTimeout(() => { flying = false; render(); }, 190);
}

function back() {
  if (index > 0) { index--; render(); }
}

LinkActions.setup({
  data: () => data,
  say,
  tags: () => openTags(),
  tagNext: () => { later(); setTimeout(openTags, 260); },
  async after(cmd, target, res) {
    const wait = flying ? new Promise(ok => setTimeout(ok, 190)) : null;
    flying = false;
    if (res.ok === false) { await wait; render(); return; }
    const onTop = deck[index]?.link.key === target?.link.key;
    const leaves = ["list", "move", "remove"].includes(cmd) || (cmd === "open" && /taken out/.test(res.say || ""));
    if (cmd !== "undo" && onTop && (((cmd === "keep" || cmd === "drop") && !res.cleared) || leaves)) index++;
    await Promise.all([res.local ? recount() : refresh(), wait]);
    if (cmd === "undo" && res.mark && target) {
      // Back on top, where it was dealt.
      index = Math.min(res.mark.index, deck.length);
      if (deck[index]?.link.key !== target.link.key) {
        const at = deck.findIndex((c, j) => j > index && c.link.key === target.link.key);
        deck.splice(index, 0, at === -1 ? toCard(byKey.get(target.link.key) || target.link) : deck.splice(at, 1)[0]);
      }
    }
    render();
  },
});

function openTags() {
  const top = $("stage").querySelector(".card.top");
  if (!deck[index] || !top) return;
  const pop = anchoredPopover(top.querySelector(".head"), tagEditor(deck[index].link, () => {
    // Redraw the card under the popover with its new tags; the popover stays.
    const head = $("stage").querySelector(".card.top .head");
    head?.querySelector(".tags")?.remove();
    const chips = tagChips(deck[index].link);
    if (chips && head) head.append(chips);
  }));
  pop.classList.add("cards-tagpop");
}

/* Under the card: the shared actions, its keep and drop flying the card as a key does, then the
 * deck's own two — Later and Undo. */
function renderActions() {
  const box = $("actions");
  box.textContent = "";
  const card = deck[index];
  const laterB = el("button", { type: "button", title: `Next card, no verdict; it comes back next session (${LinkKeys.showOf("next")})`, disabled: !card }, "Later", el("kbd", { textContent: LinkKeys.showOf("next") }));
  laterB.onclick = later;
  const undoB = el("button", { type: "button", title: `Undo the last action (${LinkKeys.showOf("undo")})`, disabled: !LinkActions.canUndo() }, "Undo", el("kbd", { textContent: LinkKeys.showOf("undo") }));
  undoB.onclick = () => LinkActions.undo();
  if (!card) { box.append(el("div", { className: "lk-bar" }, undoB)); return; }
  // Two rows: the deck's moves — open, keep, drop, later, undo — then the rest.
  const bar = LinkActions.bar({ link: card.link });
  for (const v of ["keep", "drop"]) {
    const b = bar.querySelector(`[data-cmd="${v}"]`);
    b.onclick = e => { e.stopPropagation(); decide(v); };
  }
  bar.querySelector('[data-cmd="drop"]').after(laterB, undoB, el("span", { className: "brk" }));
  box.append(bar);
}

/* --- keys --- */

/* A D: the first link of the previous or next stash in the sidebar is dealt next. */
function jumpGroup(by) {
  const at = sideRows.findIndex(r => r.b.hasAttribute("aria-current"));
  const here = sideRows[at]?.group;
  const groups = [...new Set(sideRows.map(r => r.group))];
  const g = groups[at === -1 ? (by > 0 ? 0 : groups.length - 1) : groups.indexOf(here) + by];
  const first = g && sideRows.find(r => r.group === g && r.key !== deck[index]?.link.key);
  if (first) dealNext(first.key);
}

const onTop = cmd => () => {
  const card = deck[index];
  if (!card) return;
  LinkActions.key(cmd, { link: card.link }, $("actions").querySelector(`[data-cmd="${cmd === "open-other" ? "open" : cmd}"]`) || $("stage"));
};

LinkKeys.listen({
  prev: () => back(),
  next: () => later(),
  "group-prev": () => jumpGroup(-1), "group-next": () => jumpGroup(1),
  drop: () => decide("drop"), keep: () => decide("keep"),
  read: onTop("read"), open: onTop("open"), "open-other": onTop("open-other"),
  tags: () => openTags(), list: onTop("list"), move: onTop("move"), remove: onTop("remove"),
  undo: () => LinkActions.undo(),
  escape: () => document.querySelector(".tagpop")?.remove(),
}, { labels: { prev: "back", next: "later", "group-prev": "◂ stash", "group-next": "stash ▸" } });
$("keys-line").append("Drag the card, or ", ...LinkKeys.hint(["drop", "keep", "next", "prev", "group-next", "open", "tags"]));

/* --- drag --- */

function arm(el, card) {
  if (!el) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  el.addEventListener("pointerdown", e => {
    if (e.target.closest("a")) return;   // let links through
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.style.transition = "none";
  });

  el.addEventListener("pointermove", e => {
    if (!dragging) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const p = Math.min(Math.abs(dx) / THRESHOLD, 1);
    el.querySelector(".stamp.keep").style.opacity = dx > 0 ? p : 0;
    el.querySelector(".stamp.skip").style.opacity = dx < 0 ? p : 0;
  });

  el.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = "transform .28s ease-out, opacity .28s ease-out";
    if (Math.abs(dx) >= THRESHOLD) {
      decide(dx > 0 ? "keep" : "drop");
    } else if (dy < -THRESHOLD) {
      later();
    } else {
      el.style.transform = "";
      el.querySelectorAll(".stamp").forEach(s => (s.style.opacity = 0));
    }
  });

  el.addEventListener("pointercancel", () => {
    dragging = false;
    el.style.transform = "";
  });
}

$("deal-tag").onchange = () => {
  dealTag = $("deal-tag").value;
  try { localStorage.setItem(TAG_KEY, dealTag); } catch (e) { /* not remembered */ }
  load();
};

// A change of sources deals a new deck; other changes leave the one in hand alone.
window.LinkSources.onChange(load);
load();
