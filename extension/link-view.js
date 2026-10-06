/* What List, Cards and Explore share about showing a link: DOM and text helpers, a link's label and
 * state, and loading the joined dataset (links.js, via the background) filtered to the sources
 * chosen in the top bar (nav.js). */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null && c !== false));
  return node;
};

const shortUrl = url => String(url).replace(/^https?:\/\/(www\.)?/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;
function whenOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* Mirrors reopenRoute in background.js: what reopening this URL will actually do. */
const isWeb = url => /^(https?|ftp):/.test(url);
function kindOf(url) {
  if (isWeb(url) || url.startsWith(browser.runtime.getURL(""))) return "web";
  return /^file:/.test(url) ? "file" : "other";
}

/* A stash is named after its time until renamed; only a real name is worth showing beside the time. */
const stashName = s => s.name || whenOf(s.created_at);
const renamed = s => s.name && s.name !== whenOf(s.created_at);

/* A plain tweet's title is only its handle, so its text is what identifies it. */
const isTextPost = cap => !!(cap?.text && (!cap.title || /^@?\S+ on X$|^X post$/.test(cap.title)));
function labelOf(link) {
  const cap = link.cap;
  if (!cap) return link.title || null;
  const body = (cap.text || "").replace(/\s+/g, " ").trim();
  if (isTextPost(cap)) return (cap.handle ? `${cap.handle}: ` : "") + body;
  if (cap.handle && cap.title && !cap.title.includes(cap.handle)) return `${cap.handle} — ${cap.title}`;
  return cap.title || cap.handle || link.title || null;
}

/* Whether its page was read in, shown the same on every page: a "read" badge with the date on a
 * row or card, a page icon beside the title in a sidebar. Only web pages can be read, so only they get "not
 * read". */
const readAt = link => link.cap?.captured_at || null;
const dayOf = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" }); };
function readBadge(link) {
  const at = readAt(link);
  if (at) return el("span", { className: "lk-read", textContent: "read", title: `Read ${whenOf(at)} — its text and images are stored` });
  if (link.cap) return el("span", { className: "lk-read", textContent: "read", title: "Its text and images are stored" });
  return isWeb(link.url) ? el("span", { className: "lk-unread", textContent: "not read", title: "Never read — Read (3) pulls its text and images in" }) : null;
}
function readMark(link) {
  const span = el("span", { className: `rd${link.cap ? " on" : ""}`, title: link.cap ? (readAt(link) ? `Read ${dayOf(readAt(link))}` : "Read") : "" });
  if (link.cap) span.setAttribute("aria-label", "read");
  return span;
}
/* A verdict as a badge, for pages whose rows have no mark of their own. */
const verdictBadge = link => (link.verdict === "keep" ? el("span", { className: "lk-verdict keep", textContent: "✓ kept" })
  : link.verdict === "drop" ? el("span", { className: "lk-verdict drop", textContent: "✕ dropped" }) : null);

/* One state per link, shown the same everywhere: a verdict if it has one, else whether it was seen. */
const stateOf = link => (link.verdict === "keep" ? "kept" : link.verdict === "drop" ? "dropped" : link.seen ? "seen" : "left");
const STATE_NAMES = { left: "Not looked at yet", seen: "Seen, undecided", kept: "Kept", dropped: "Dropped" };
const SOURCE_NAMES = { tabs: "Stashed", import: "Imported", list: "Reading list" };

/* The dataset, cut down to the chosen sources: a link shows if any source holding it is chosen, a
 * stash if its own source is. byKey finds a link from a stash tab's key. */
async function loadLinks() {
  const [data, chosen] = await Promise.all([send({ type: "links" }), window.LinkSources.ready]);
  const sources = window.LinkSources.get() || chosen;
  const counts = { tabs: 0, import: 0, list: 0 };
  for (const l of data.links) for (const s of l.sources) counts[s]++;
  window.LinkSources.setCounts(counts);
  const on = new Set(sources);
  const links = data.links.filter(l => l.sources.some(s => on.has(s)));
  const stashes = data.stashes.filter(s => on.has(s.source));
  setTagVocab(data.links);
  return { links, stashes, all: data, sources: on, byKey: new Map(data.links.map(l => [l.key, l])) };
}

/* Stashes are bookmarks, so a change can come from Firefox's own library as well as from here; a
 * stash of forty tabs is forty events, taken as one. busy() holds a reload back while it is true —
 * a rename would lose its input to a re-render, and a drag its row. */
function reloadOnChanges(load, busy = () => false) {
  let timer = null;
  // Typing tags saves as it goes; a reload then would take the field away mid-word.
  const editing = () => !!document.activeElement?.closest?.(".tagger, .tagpop");
  const soon = () => {
    clearTimeout(timer);
    // A verdict still being saved would be painted back to the old one by a reload now.
    timer = setTimeout(() => (busy() || editing() || window.LinkActions?.saving() ? soon() : load()), 150);
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["stashMeta", "stashSettings", "captures", "items", "current", "thumbs", "linkTags"].some(k => changes[k])) soon();
  });
  for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) browser.bookmarks?.[ev].addListener(soon);
  window.LinkSources.onChange(load);
}

/* A native popover anchored to its trigger: Escape and outside clicks close it, and it lands on the
 * first item when opened from the keyboard. */
let menuSeq = 0;
let usingKeyboard = false;
addEventListener("keydown", () => { usingKeyboard = true; }, true);
addEventListener("pointerdown", () => { usingKeyboard = false; }, true);
function popoverMenu(label, ariaLabel, items, triggerClass = "small ghost more") {
  const id = `menu-${++menuSeq}`;
  const trigger = el("button", { className: triggerClass, textContent: label, title: ariaLabel });
  trigger.setAttribute("aria-label", ariaLabel.length > 90 ? `${ariaLabel.slice(0, 90)}…` : ariaLabel);
  trigger.setAttribute("popovertarget", id);
  const menu = el("div", { id, className: "menu" });
  menu.popover = "auto";
  for (const it of items.filter(Boolean)) {
    if (it === "-") { menu.append(el("hr")); continue; }
    const b = el("button", { textContent: it.text, className: it.className || "", disabled: !!it.disabled, title: it.title || "" });
    b.onclick = async () => { menu.hidePopover(); await it.run(); };
    menu.append(b);
  }
  menu.addEventListener("toggle", e => {
    if (e.newState !== "open") return;
    const r = trigger.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const below = r.bottom + 4 + h <= innerHeight;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    if (usingKeyboard) menu.querySelector("button:not(:disabled)")?.focus();
  });
  return [trigger, menu];
}
// A popover is placed once, when it opens; scrolling would leave it behind, so close it instead.
addEventListener("scroll", () => {
  for (const open of document.querySelectorAll(".menu:popover-open")) open.hidePopover();
}, { passive: true, capture: true });

/* What restoring said, in words. */
function restoredText(r) {
  const parts = [`Reopened ${plural(r.restored, "tab")}`];
  if (r.viaHelper) parts.push(`${r.viaHelper} local through the helper`);
  if (r.standins) parts.push(`${r.standins} as stand-ins`);
  if (r.removed) parts.push("taken out of the stash");
  const fix = /not installed/.test(r.helperError || "") ? "; run native/install.zsh in the link-keeper repo once" : "";
  return parts.join(" · ") + (r.helperError ? ` — local files came back as stand-ins: ${r.helperError}${fix}` : "");
}

/* Reads a web page in a background tab, asking for that site first — from the click, since a
 * permission prompt must come from one. */
async function readLink(url) {
  let origin;
  try { origin = new URL(url).origin + "/*"; } catch (e) { return { ok: false, error: "That URL cannot be opened" }; }
  const granted = await browser.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return { ok: false, error: `Reading it needs access to ${hostOf(url)}` };
  return send({ type: "capture-url", url });
}

/* --- tags ------------------------------------------------------------------------------
 * A link's tags are set by hand and shared by every copy of it. Until it has any, what kind of
 * site it is ("code", "video", …) shows in their place, dimmed. The editor is swipe-sort's: chips,
 * suggestions from the tags in use, and every change saved at once. */

/* What a link shows: its own tags, or the guesses, flagged as such. */
const shownTags = link => (link.tags?.length ? { tags: link.tags, guessed: false } : { tags: link.kinds || [], guessed: true });

/* The tags in use, most used first, then the kinds of site — the pool suggestions come from. */
const TAG_VOCAB = { names: [], counts: new Map() };
function setTagVocab(links) {
  const counts = new Map();
  for (const l of links) for (const t of l.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  TAG_VOCAB.counts = counts;
  const kinds = [...new Set(links.flatMap(l => l.kinds || []))].filter(k => !counts.has(k));
  TAG_VOCAB.names = [...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t), ...kinds];
}

/* One stable colour per tag, so the same tag always looks the same. */
function tagHue(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}
function tagChip(tag, guessed = false) {
  const chip = el("span", { className: `tag${guessed ? " guess" : ""}`, textContent: tag,
    title: guessed ? `Guessed from the kind of site; set a tag to replace it` : tag });
  if (!guessed) chip.style.setProperty("--h", tagHue(tag));
  return chip;
}
function tagChips(link) {
  const { tags, guessed } = shownTags(link);
  return tags.length ? el("span", { className: "tags" }, ...tags.map(t => tagChip(t, guessed))) : null;
}

/* Suggestions under a field, matched with spaces and punctuation ignored, so "gamejam" finds
 * "game jam". ↑↓ choose, Enter or Tab takes the highlighted one, Escape closes. Enter takes a
 * suggestion only when it begins with what was typed, so a new tag can still be typed. */
function suggestField(input, exclude = () => []) {
  const flat = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const list = el("div", { className: "suggestlist", hidden: true });
  let items = [], at = -1;
  const place = () => {
    const r = input.getBoundingClientRect();
    Object.assign(list.style, { top: `${r.bottom + 2}px`, left: `${r.left}px`, minWidth: `${r.width}px` });
  };
  const draw = () => {
    list.textContent = "";
    items.forEach((name, i) => {
      const row = el("div", { textContent: name, className: i === at ? "on" : "" });
      const n = TAG_VOCAB.counts.get(name);
      if (n) row.append(el("i", { textContent: n }));
      row.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); pick(i); });
      list.append(row);
    });
    list.hidden = !items.length;
    if (items.length) place();
  };
  const update = () => {
    const q = flat(input.value);
    if (!q) { items = []; draw(); return; }
    const skip = new Set(exclude());
    const hits = TAG_VOCAB.names.filter(n => !skip.has(n) && flat(n).includes(q));
    items = [...hits.filter(n => flat(n).startsWith(q)), ...hits.filter(n => !flat(n).startsWith(q))].slice(0, 8);
    at = items.length && flat(items[0]).startsWith(q) ? 0 : -1;
    draw();
  };
  // A click takes the name as Enter would.
  const pick = i => {
    input.value = items[i];
    items = [];
    draw();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  document.body.append(list);
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", update);
  input.addEventListener("blur", () => { items = []; draw(); });
  // Registered first, so a picked value is in the field before the field's own Enter handler reads it.
  input.addEventListener("keydown", e => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (Math.max(at, e.key === "ArrowDown" ? -1 : 0) + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      draw();
    } else if ((e.key === "Enter" || e.key === "Tab") && at >= 0) {
      if (e.key === "Tab") e.preventDefault();
      input.value = items[at];
      items = [];
      draw();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      items = [];
      draw();
    }
  });
  // The field can leave the page (a card thrown, a popover closed); its list goes with it.
  new MutationObserver((_, obs) => { if (!input.isConnected) { list.remove(); obs.disconnect(); } })
    .observe(document.body, { childList: true, subtree: true });
}

/* The editor for one link's tags. Guesses start as dimmed chips; the first change saves what is
 * shown, so a guess that is kept becomes a tag, and removing every tag brings the guesses back.
 * Enter on the empty field or Escape is "done": the box fires "tagdone", its detail saying which
 * ({ escape: true } for Escape). onSaved(tags) follows a
 * save; link.tags is updated in place. */
function tagEditor(link, onSaved) {
  const start = shownTags(link);
  let tags = start.tags.slice();
  let guessed = start.guessed && tags.length > 0;
  const chips = el("span", { className: "chips" });
  const input = el("input", { type: "text", placeholder: tags.length ? "add a tag" : "add a tag, Enter" });
  input.setAttribute("aria-label", "Add a tag");
  suggestField(input, () => tags);
  const status = el("span", { className: "tagstatus" });
  const box = el("div", { className: "tagger" }, chips, input, status);

  const mark = () => {
    status.textContent = guessed ? "guessed from the site — any change makes them yours" : "";
    status.classList.remove("bad");
  };
  const draw = () => {
    chips.textContent = "";
    for (const t of tags) {
      const chip = tagChip(t, guessed);
      const x = el("button", { type: "button", textContent: "×", title: `Remove ${t}` });
      x.onclick = () => { tags = tags.filter(m => m !== t); save(); };
      chip.append(x);
      chips.append(chip);
    }
    mark();
  };
  async function save() {
    const res = await send({ type: "set-tags", url: link.url, tags });
    if (!res?.ok) {
      status.textContent = `not saved — ${res?.error || "no answer"}`;
      status.classList.add("bad");
      return;
    }
    link.tags = res.tags;
    link.guessed = res.tags.length ? [] : link.kinds || [];
    const now = shownTags(link);
    tags = now.tags.slice();
    guessed = now.guessed && tags.length > 0;
    draw();
    onSaved?.(res.tags);
  }
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const t = input.value.toLowerCase().replace(/\s+/g, " ").trim();
      input.value = "";
      if (!t) { box.dispatchEvent(new CustomEvent("tagdone", { bubbles: true })); return; }
      if (!tags.includes(t) || guessed) { if (!tags.includes(t)) tags.push(t); save(); }
    } else if (e.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      save();
    } else if (e.key === "Escape") {
      box.dispatchEvent(new CustomEvent("tagdone", { bubbles: true, detail: { escape: true } }));
    }
  });
  // Keys typed here are text, not the page's shortcuts.
  box.addEventListener("keydown", e => e.stopPropagation());
  draw();
  return box;
}

/* A popover anchored under `anchor` holding `content`; closes on Escape, a click outside, or a
 * "tagdone" from inside, and hands the keyboard back to the page. */
function anchoredPopover(anchor, content) {
  document.querySelector(".tagpop")?.remove();
  const pop = el("div", { className: "tagpop" }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.activeElement?.blur?.();
  };
  const outside = ev => { if (!pop.contains(ev.target) && !ev.target.closest?.(".suggestlist")) close(); };
  pop.addEventListener("tagdone", close);
  pop.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  document.addEventListener("pointerdown", outside, true);
  pop.querySelector("input")?.focus();
  return pop;
}

/* The ✎ that opens a link's editor in a popover. */
function tagButton(link, onSaved) {
  const btn = el("button", { type: "button", className: "small ghost tagedit", textContent: "✎", title: "Tags" });
  btn.setAttribute("aria-label", `Tags for ${labelOf(link) || shortUrl(link.url)}`.slice(0, 120));
  btn.onclick = e => { e.stopPropagation(); anchoredPopover(btn, tagEditor(link, onSaved)); };
  btn.addEventListener("pointerdown", e => e.stopPropagation());   // not the start of a drag
  return btn;
}

/* One field that adds a tag to many links at once (a whole stash): onAdd(tag) on Enter. */
function tagAdder(anchor, label, onAdd) {
  const input = el("input", { type: "text", placeholder: "tag to add, Enter" });
  input.setAttribute("aria-label", label);
  suggestField(input);
  const box = el("div", { className: "tagger adder" }, el("span", { className: "tagstatus", textContent: label }), input);
  input.addEventListener("keydown", async e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const t = input.value.toLowerCase().replace(/\s+/g, " ").trim();
    if (t) await onAdd(t);
    box.dispatchEvent(new CustomEvent("tagdone", { bubbles: true }));
  });
  box.addEventListener("keydown", e => e.stopPropagation());
  anchoredPopover(anchor, box);
}
