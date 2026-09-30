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
async function load() {
  const { links } = await loadLinks();
  known = links.length;
  tally = { keep: links.filter(l => l.verdict === "keep").length, drop: links.filter(l => l.verdict === "drop").length };
  renderTagPick(links);
  deck = shuffle(links.filter(l => !l.verdict && inDeal(l)).map(toCard));
  index = 0;
  undo.length = 0;
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
  if (e.target.matches("input, textarea, select")) return;
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
