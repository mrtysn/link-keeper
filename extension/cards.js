/* A shuffled deck of the links still waiting for a verdict.
 *
 * Cards judge URLs, they do not read pages: reading a page's DOM needs that page open in your tab,
 * which is what Keep in the popup is for. So right means "worth keeping", left means "no", up means
 * "not now" — and Open loads it in a tab for the ones you cannot judge from the URL alone.
 *
 * The deck is shuffled once per visit and held in memory. Verdicts go straight to storage through
 * the background, so closing this tab mid-deck loses nothing but the shuffle order.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

const THRESHOLD = 105;

let deck = [];        // pending rows, shuffled
let index = 0;        // how far into the deck
let counts = {};
const undo = [];      // {url, prev} — one entry per verdict, newest last

function say(text) { $("msg").textContent = text; }

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch (e) { return "(unparseable)"; }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/$/, "") + u.search) || "/";
  } catch (e) { return String(url); }
}

/* Stable hue per domain, so the same site always wears the same colour. */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function labelOf(row) {
  const cap = row.cap;
  if (!cap) return null;
  const body = (cap.text || "").replace(/\s+/g, " ").trim();
  if (body && (!cap.title || /^@?\S+ on X$|^X post$/.test(cap.title))) {
    return (cap.handle ? `${cap.handle}: ` : "") + (body.length > 100 ? body.slice(0, 100) + "…" : body);
  }
  if (cap.handle && cap.title && !cap.title.includes(cap.handle)) return `${cap.handle} — ${cap.title}`;
  return cap.title || cap.handle || null;
}

/* Fisher-Yates. Shuffled rather than ordered because a deck of 133 x.com cards in a row is a
 * chore; mixing the domains keeps each card a fresh decision. */
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function load() {
  const { items } = await send({ type: "dump" });
  counts = { kept: 0, skipped: 0, seen: 0, pending: 0 };
  for (const row of items) counts[row.status] = (counts[row.status] || 0) + 1;
  deck = shuffle(items.filter(r => r.status === "pending"));
  index = 0;
  render();
}

function cardEl(row, top) {
  const el = document.createElement("article");
  el.className = "card" + (top ? " top" : "");
  const host = hostOf(row.url);
  const initial = (host.match(/[a-z0-9]/i) || ["?"])[0].toUpperCase();

  const head = document.createElement("div");
  head.className = "head";
  const mono = document.createElement("div");
  mono.className = "mono";
  mono.style.background = `hsl(${hue(host)} 58% 45%)`;
  mono.textContent = initial;
  const names = document.createElement("div");
  names.append(Object.assign(document.createElement("div"), { className: "host", textContent: host }));
  const when = row.saved_at || row.added_at;
  names.append(Object.assign(document.createElement("div"), {
    className: "when",
    textContent: when ? `saved ${String(when).slice(0, 10)}` : "date unknown",
  }));
  head.append(mono, names);
  el.append(head);

  const label = labelOf(row);
  if (label) {
    el.append(Object.assign(document.createElement("div"), { className: "title", textContent: label }));
  }
  if (row.cap?.text && label !== row.cap.text) {
    el.append(Object.assign(document.createElement("div"), {
      className: "body", textContent: row.cap.text,
    }));
  }
  el.append(Object.assign(document.createElement("div"), { className: "path", textContent: pathOf(row.url) }));

  if (row.note) {
    el.append(Object.assign(document.createElement("div"), { className: "note", textContent: row.note }));
  }

  const pics = [...(row.cap?.images || [])].slice(0, 3);
  if (row.cap?.shotThumb) pics.unshift(row.cap.shotThumb);
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
  open.href = row.url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open ↗";
  open.addEventListener("click", () => send({ type: "set-current", url: row.url }));
  const same = deck.filter(r => hostOf(r.url) === host).length - 1;
  foot.append(open, Object.assign(document.createElement("span"), {
    className: "siblings",
    textContent: same > 0 ? `${same} more from ${host} in the deck` : `only one from ${host}`,
  }));
  el.append(foot);

  el.append(Object.assign(document.createElement("div"), { className: "stamp keep", textContent: "keep" }));
  el.append(Object.assign(document.createElement("div"), { className: "stamp skip", textContent: "skip" }));
  return el;
}

function render() {
  const total = deck.length;
  const left = total - index;
  $("bar").style.width = total ? `${index / total * 100}%` : "100%";
  $("pos").textContent = total ? `${index} of ${total} this session` : "nothing pending";
  $("t-kept").textContent = counts.kept || 0;
  $("t-skipped").textContent = counts.skipped || 0;
  $("t-left").textContent = left;
  $("undo").disabled = undo.length === 0;
  for (const id of ["skip", "later", "keep"]) $(id).disabled = left === 0;

  const stage = $("stage");
  stage.textContent = "";

  if (left <= 0) {
    const box = document.createElement("div");
    box.className = "done";
    box.innerHTML = total
      ? '<b>Deck finished.</b>Reload for another pass, or see <a href="list.html">the whole list</a>.'
      : '<b>Nothing pending.</b>Every link has a verdict — <a href="list.html">the whole list</a>.';
    stage.append(box);
    return;
  }

  // Two ghosts behind the live card give the stack depth without animating them.
  deck.slice(index, index + 3).reverse().forEach((row, i, arr) => {
    const depth = arr.length - 1 - i;
    const el = cardEl(row, depth === 0);
    el.style.transform = `translateY(${depth * 9}px) scale(${1 - depth * 0.035})`;
    el.style.opacity = depth > 1 ? ".55" : "1";
    el.style.zIndex = String(10 - depth);
    stage.append(el);
  });

  arm(stage.querySelector(".card.top"), deck[index]);
}

/* --- verdicts --- */

async function commit(row, status, card, xdir = 0, ydir = 0) {
  undo.push({ url: row.url, prev: row.status });
  if (status !== "pending") {
    row.status = status;
    counts[status] = (counts[status] || 0) + 1;
    await send({ type: "mark", url: row.url, status });
  }
  index++;
  if (card) {
    card.style.transition = "transform .28s ease-out, opacity .28s ease-out";
    card.style.transform =
      `translate(${xdir * 620}px, ${ydir * 620 + (ydir ? 0 : 40)}px) rotate(${xdir * 22}deg)`;
    card.style.opacity = "0";
    setTimeout(render, 190);
  } else {
    render();
  }
}

function decide(status) {
  const row = deck[index];
  if (!row) return;
  const dir = status === "kept" ? 1 : status === "skipped" ? -1 : 0;
  commit(row, status, $("stage").querySelector(".card.top"), dir, status === "pending" ? -1 : 0);
}

async function undoLast() {
  const last = undo.pop();
  if (!last) return;
  index = Math.max(0, index - 1);
  const row = deck[index];
  if (row && row.status !== last.prev) {
    counts[row.status] = Math.max(0, (counts[row.status] || 0) - 1);
    row.status = last.prev;
    await send({ type: "mark", url: last.url, status: last.prev });
  }
  render();
}

/* --- drag --- */

function arm(card, row) {
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  card.addEventListener("pointerdown", e => {
    if (e.target.closest(".open")) return;   // let the link through
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    card.setPointerCapture(e.pointerId);
    card.style.transition = "none";
  });

  card.addEventListener("pointermove", e => {
    if (!dragging) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const p = Math.min(Math.abs(dx) / THRESHOLD, 1);
    card.querySelector(".stamp.keep").style.opacity = dx > 0 ? p : 0;
    card.querySelector(".stamp.skip").style.opacity = dx < 0 ? p : 0;
  });

  card.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform .28s ease-out, opacity .28s ease-out";
    if (Math.abs(dx) >= THRESHOLD) {
      commit(row, dx > 0 ? "kept" : "skipped", card, dx > 0 ? 1 : -1);
    } else if (dy < -THRESHOLD) {
      commit(row, "pending", card, 0, -1);   // later: no verdict recorded
    } else {
      card.style.transform = "";
      card.querySelectorAll(".stamp").forEach(s => (s.style.opacity = 0));
    }
  });

  card.addEventListener("pointercancel", () => {
    dragging = false;
    card.style.transform = "";
  });
}

$("keep").onclick = () => decide("kept");
$("skip").onclick = () => decide("skipped");
$("later").onclick = () => decide("pending");
$("undo").onclick = undoLast;

document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) return;
  const k = e.key.toLowerCase();
  if (e.key === "ArrowRight" || k === "k") { e.preventDefault(); decide("kept"); }
  else if (e.key === "ArrowLeft" || k === "d") { e.preventDefault(); decide("skipped"); }
  else if (e.key === "ArrowUp" || k === "s") { e.preventDefault(); decide("pending"); }
  else if (k === "u" || (k === "z" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undoLast(); }
  else if (k === "o") {
    const row = deck[index];
    if (row) {
      send({ type: "set-current", url: row.url });
      window.open(row.url, "_blank", "noopener");
    }
  }
});

load();
