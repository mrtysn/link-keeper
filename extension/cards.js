/* A shuffled deck of every undecided link in the sources chosen in the top bar.
 *
 * A card shows what is known: a page that was read carries its author, title, text, images and
 * screenshot; a stashed tab never read shows its tab title and address. Reading first (Read on the
 * List or Explore page) makes a card easier to judge.
 *
 * Keep and drop are one verdict per URL, written to every copy — capture, reading-list entry and
 * each stash. Neither deletes anything: a drop is a flag, so a change of mind costs one click.
 */

const THRESHOLD = 105;

let deck = [];
let index = 0;
let tally = { keep: 0, drop: 0 };
const undo = [];

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
      ? `${card.handle} — ${card.title}`
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
let stashes = [], onShow = new Set(), sources = new Set(), allLinks = [], byKey = new Map();
const judged = new Map();
async function load() {
  const { links, all, stashes: shown, sources: on } = await loadLinks();
  known = links.length;
  stashes = all.stashes;
  allLinks = all.links;
  byKey = new Map(all.links.map(l => [l.key, l]));
  sources = on;
  judged.clear();
  onShow = new Set(shown.map(s => s.id));
  tally = { keep: links.filter(l => l.verdict === "keep").length, drop: links.filter(l => l.verdict === "drop").length };
  renderTagPick(links);
  deck = shuffle(links.filter(l => !l.verdict && inDeal(l)).map(toCard));
  index = 0;
  undo.length = 0;
  buildSide();
  render();
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
  names.append(Object.assign(document.createElement("div"), {
    className: "when", textContent: bits.join(" · "),
  }));
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
  if (held.length > 1) facts.push(`Also in ${plural(held.length - 1, "other stash")}: ${held.slice(1, 3).map(h => stashName(h.stash)).join(", ")}${held.length > 3 ? ", …" : ""}`);
  if (link.list && held.length) facts.push(`on the reading list — ${LIST_STATUS[link.list.status] || link.list.status}`);
  if (isWeb(link.url)) {
    const host = hostOf(link.url);
    const same = deck.slice(index).filter(c => c.link.key !== link.key && isWeb(c.url) && hostOf(c.url) === host).length;
    if (same) facts.push(`${same} more from ${host} in this deck`);
  }
  return facts.length ? el("div", { className: "ctx", textContent: facts.join(" · ") }) : null;
}

/* What a link stands at now: this session's verdicts first, as the dataset is not reloaded. */
const verdictNow = link => (judged.has(link.url) ? judged.get(link.url) : link.verdict);

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
      const b = el("button", { title: `${title}\n${r.url}` }, srcIcon(r.url),
        el("span", { className: `t${r.title ? "" : " plain"}`, textContent: title }), el("span", { className: "m" }));
      b.onclick = () => dealNext(r.key);
      sideRows.push({ group: id, key: r.key, b });
      ul.append(el("li", {}, b));
    }
    side.append(el("section", { className: "grp" },
      el("h2", { title: sub }, el("span", { className: "t", textContent: name }), el("span", { className: "n", textContent: rows.length })), ul));
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
    r.b.parentElement.className = (link && verdictNow(link)) || "";
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
  $("undo").disabled = undo.length === 0;
  for (const id of ["skip", "later", "keep"]) $(id).disabled = left === 0;

  renderSide();
  const stage = $("stage");
  stage.textContent = "";

  if (left <= 0) {
    const [head, rest] = total
      ? ["Deck finished.", "Everything undecided in the chosen sources has been through the deck. "]
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

async function commit(card, verdict, el, xdir = 0, ydir = 0) {
  undo.push({ url: card.url, verdict });
  if (verdict) {
    tally[verdict]++;
    judged.set(card.url, verdict);
    await send({ type: "judge-link", url: card.url, verdict });
  }
  index++;
  if (el) {
    el.style.transition = "transform .28s ease-out, opacity .28s ease-out";
    el.style.transform =
      `translate(${xdir * 620}px, ${ydir * 620 + (ydir ? 0 : 40)}px) rotate(${xdir * 22}deg)`;
    el.style.opacity = "0";
    setTimeout(render, 190);
  } else {
    render();
  }
}

function decide(verdict) {
  const card = deck[index];
  if (!card) return;
  const dir = verdict === "keep" ? 1 : verdict === "drop" ? -1 : 0;
  commit(card, verdict, $("stage").querySelector(".card.top"), dir, verdict ? 0 : -1);
}

async function undoLast() {
  const last = undo.pop();
  if (!last) return;
  index = Math.max(0, index - 1);
  if (last.verdict) {
    tally[last.verdict] = Math.max(0, tally[last.verdict] - 1);
    judged.set(last.url, null);
    await send({ type: "judge-link", url: last.url, verdict: null });
  }
  render();
}

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
      commit(card, dx > 0 ? "keep" : "drop", el, dx > 0 ? 1 : -1);
    } else if (dy < -THRESHOLD) {
      commit(card, null, el, 0, -1);   // later: no verdict recorded, comes back next session
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

$("keep").onclick = () => decide("keep");
$("skip").onclick = () => decide("drop");
$("later").onclick = () => decide(null);
$("undo").onclick = undoLast;

document.addEventListener("keydown", e => {
  if (e.target.matches?.("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (e.key === "ArrowRight" || k === "k") { e.preventDefault(); decide("keep"); }
  else if (e.key === "ArrowLeft" || k === "d") { e.preventDefault(); decide("drop"); }
  else if (e.key === "ArrowUp" || k === "s") { e.preventDefault(); decide(null); }
  else if (k === "u" || (k === "z" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undoLast(); }
  else if (k === "t") {
    const top = $("stage").querySelector(".card.top");
    if (!deck[index] || !top) return;
    e.preventDefault();
    const pop = anchoredPopover(top.querySelector(".head"), tagEditor(deck[index].link, () => {
      // Redraw the card under the popover with its new tags; the popover stays.
      const card = $("stage").querySelector(".card.top .head");
      card?.querySelector(".tags")?.remove();
      const chips = tagChips(deck[index].link);
      if (chips && card) card.append(chips);
    }));
    pop.classList.add("cards-tagpop");
  }
  else if (k === "o") {
    const card = deck[index];
    if (card) window.open(card.url, "_blank", "noopener");
  }
});

$("deal-tag").onchange = () => {
  dealTag = $("deal-tag").value;
  try { localStorage.setItem(TAG_KEY, dealTag); } catch (e) { /* not remembered */ }
  load();
};

// A change of sources deals a new deck; other changes leave the one in hand alone.
window.LinkSources.onChange(load);
load();
