/* Tags: every tag there is — the presets, the ones made here, the ones typed on a link — each with
 * its colour and how many links on show carry it, and, beside them, the links of the chosen one: a
 * tag is a collection. A tag is made, renamed, merged into another, recoloured or deleted here; it
 * is put on a link with the tag editor's palette (T on any page).
 *
 * The keys are every page's (link-keys.js): W S walk the chosen tag's links, A D choose the previous
 * or next tag, and on a link the rest act as they do anywhere.
 */

const HUES = [0, 25, 45, 90, 140, 170, 195, 215, 250, 280, 310, 335];

let data = { links: [], all: { links: [] }, sources: new Set() };
let chosen = new URLSearchParams(location.search).get("tag") || null;
let cursor = null;   // the key of the link the keys act on

function say(text) { $("msg").textContent = text; }

/* Every tag with its links on show: the library's order, then any in use it does not hold yet. */
function tagsOnShow() {
  const by = new Map(tagPool().map(t => [t, []]));
  for (const l of data.links) for (const t of l.tags || []) (by.get(t) || by.set(t, []).get(t)).push(l);
  return by;
}

/* Colour swatches; null is "from its name". */
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

/* --- the new-tag form --- */

let newHue = null;
function drawMaker() {
  $("new-hues").replaceWith(Object.assign(hueRow(newHue, h => { newHue = h; drawMaker(); }), { id: "new-hues" }));
}
$("maker").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("new-name").value;
  const res = await send({ type: "create-tag", name, hue: newHue });
  if (!res?.ok) return say(res?.error ? res.error[0].toUpperCase() + res.error.slice(1) : "Unable to make it");
  $("new-name").value = "";
  newHue = null;
  drawMaker();
  chosen = res.tag;
  say(`Made ${res.tag}. Press T on a link to add it.`);
  await load();
});
// Keys typed into the form are text.
$("maker").addEventListener("keydown", e => { if (e.key !== "Escape") e.stopPropagation(); });

/* --- the tags --- */

function renderLib(by) {
  const lib = $("lib");
  lib.textContent = "";
  lib.append(el("h2", { textContent: `${by.size} tags` }));
  const ul = el("ul");
  for (const [t, links] of by) {
    const b = el("button", { type: "button", className: links.length ? "" : "empty-tag", title: `${t}: ${plural(links.length, "link")} shown` },
      el("span", { className: "dot" }), el("span", { className: "t", textContent: t }), el("span", { className: "n", textContent: links.length }));
    b.style.setProperty("--h", tagHue(t));
    if (t === chosen) b.setAttribute("aria-current", "true");
    b.onclick = () => choose(t);
    ul.append(el("li", {}, b));
  }
  lib.append(ul);
}

function choose(t) {
  chosen = t;
  cursor = null;
  history.replaceState(null, "", `?tag=${encodeURIComponent(t)}`);
  render();
  document.querySelector("#lib [aria-current]")?.scrollIntoView({ block: "nearest" });
}

/* --- the chosen tag: its tools and its links --- */

function renderColl(by) {
  const coll = $("coll");
  coll.textContent = "";
  if (!chosen || !by.has(chosen)) {
    coll.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "Pick a tag" }),
      el("p", { textContent: "Its links appear here. You can also make a new tag above." })));
    return;
  }
  const links = by.get(chosen).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const hue = TAG_LIB.hue.has(chosen) ? TAG_LIB.hue.get(chosen) : null;
  const others = [...by.keys()].filter(t => t !== chosen);

  const rename = el("button", { type: "button", className: "small", textContent: "Rename" });
  rename.onclick = () => {
    const input = el("input", { type: "text", value: chosen });
    input.setAttribute("aria-label", `Rename ${chosen}`);
    const done = async keep => {
      if (!input.isConnected) return;
      const to = input.value.toLowerCase().replace(/\s+/g, " ").trim();
      if (!keep || !to || to === chosen) return render();
      const merging = by.has(to);
      const res = await send({ type: "rename-tag", from: chosen, to });
      if (!res?.ok) return say(res?.error || "Unable to rename it");
      say(`${merging ? "Merged" : "Renamed"} ${chosen} → ${to} on ${plural(res.links, "link")}`);
      chosen = to;
      await load();
    };
    input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
    rename.replaceWith(input);
    input.focus();
    input.select();
  };

  const merge = el("select", { title: "Move all links with this tag to another tag and delete this one" },
    el("option", { value: "", textContent: "Merge into…" }), ...others.map(t => el("option", { value: t, textContent: t })));
  merge.setAttribute("aria-label", `Merge ${chosen} into another tag`);
  merge.onchange = async () => {
    const to = merge.value;
    if (!to) return;
    const res = await send({ type: "rename-tag", from: chosen, to });
    if (!res?.ok) return say(res?.error || "Unable to merge it");
    say(`Merged ${chosen} into ${to} on ${plural(res.links, "link")}`);
    chosen = to;
    await load();
  };

  // Two clicks: the first asks, the second deletes; the links themselves stay.
  const del = el("button", { type: "button", className: "small danger", textContent: "Delete" });
  let armed = null;
  del.onclick = async () => {
    if (!armed) {
      del.textContent = links.length ? `Delete from ${plural(links.length, "link")}?` : "Delete it?";
      armed = setTimeout(() => { armed = null; del.textContent = "Delete"; }, 4000);
      return;
    }
    clearTimeout(armed);
    const gone = chosen;
    const res = await send({ type: "delete-tag", tag: gone });
    if (!res?.ok) return say(res?.error || "Unable to delete it");
    say(`Deleted ${gone}${res.links ? ` from ${plural(res.links, "link")}; the links stay` : ""}`);
    chosen = null;
    await load();
  };

  const colours = hueRow(hue, async h => {
    const res = await send({ type: "recolor-tag", tag: chosen, hue: h });
    if (!res?.ok) say(res?.error || "Unable to recolour it");
    await load();
  });

  const chip = tagChip(chosen);
  coll.append(el("div", { className: "coll-head" },
    el("h2", {}, chip),
    el("span", { className: "count", textContent: plural(links.length, "link") }),
    el("div", { className: "tools" }, rename, merge, del),
    colours));

  if (!links.length) {
    coll.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No links yet" }),
      el("p", { textContent: data.all.links.some(l => l.tags?.includes(chosen)) ? "Its links are in sources that are hidden." : "Press T on any link and pick this tag." })));
    return;
  }
  coll.append(el("ul", { className: "rows" }, ...links.map(rowEl)));
}

function rowEl(link) {
  const label = labelOf(link);
  const a = el("a", { className: `ttl${label ? "" : " plain"}`, href: link.url, textContent: label || shortUrl(link.url), title: link.url });
  a.addEventListener("click", e => { e.preventDefault(); LinkActions.run("open", { link }); });
  Peek.mark(a, "link", link.key);
  const meta = el("div", { className: "meta" },
    el("span", { textContent: kindOf(link.url) === "web" ? hostOf(link.url) : kindOf(link.url) === "file" ? "Local file" : "Browser page" }));
  if (link.date) meta.append(el("time", { dateTime: link.date, textContent: link.date.slice(0, 10) }));
  meta.append(...[verdictBadge(link), readBadge(link)].filter(Boolean));
  const others = (link.tags || []).filter(t => t !== chosen);
  if (others.length) meta.append(el("span", { className: "tags" }, ...others.map(t => tagChip(t))));
  const li = el("li", {}, srcIcon(link.url), el("div", { className: "main" }, a, meta), LinkActions.bar({ link }, { compact: true }));
  li.dataset.key = link.key;
  if (link.key === cursor) li.classList.add("lk-cursor");
  li.addEventListener("pointerdown", () => setCursor(link.key, false));
  return li;
}

function render() {
  const by = tagsOnShow();
  if (chosen && !by.has(chosen)) chosen = null;
  if (!chosen) chosen = [...by].find(([, l]) => l.length)?.[0] || [...by.keys()][0] || null;
  const used = [...by.values()].filter(l => l.length).length;
  $("sub").textContent = `${plural(by.size, "tag")}, ${used} used on links shown · pick a tag to see its links`;
  renderLib(by);
  renderColl(by);
  if (!rowLis().some(li => li.dataset.key === cursor)) setCursor(rowLis()[0]?.dataset.key || null, false);
}

async function load() {
  data = await loadLinks();
  render();
}

/* --- keys --- */

const rowLis = () => [...document.querySelectorAll("#coll ul.rows > li")];
function setCursor(key, scroll = true) {
  cursor = key;
  for (const li of rowLis()) li.classList.toggle("lk-cursor", li.dataset.key === key);
  if (scroll) rowLis().find(li => li.dataset.key === key)?.scrollIntoView({ block: "nearest" });
}
function jumpTag(by) {
  const names = [...tagsOnShow().keys()];
  const to = names[Math.max(0, Math.min(names.length - 1, names.indexOf(chosen) + by))];
  if (to && to !== chosen) choose(to);
}
function walk(by) {
  const lis = rowLis();
  if (!lis.length) return;
  const i = lis.findIndex(li => li.dataset.key === cursor);
  const to = i === -1 ? 0 : Math.max(0, Math.min(lis.length - 1, i + by));
  setCursor(lis[to].dataset.key);
}
function onRow(cmd) {
  return () => {
    const link = data.links.find(l => l.key === cursor);
    if (!link) return;
    const li = rowLis().find(x => x.dataset.key === cursor);
    LinkActions.key(cmd, { link }, li?.querySelector(cmd === "tags" ? ".ttl" : ".lk-bar .more") || li);
  };
}

LinkActions.setup({
  data: () => data,
  say,
  tagNext: () => { walk(1); onRow("tags")(); },
  async after(cmd, target, res) {
    if (res.ok === false) return;
    const leaves = (((cmd === "keep" || cmd === "drop") && !res.cleared) || ["list", "move", "remove"].includes(cmd));
    if (leaves && target?.link.key === cursor) walk(1);
    if (res.local) render();
    else await load();
  },
});

LinkKeys.listen({
  prev: () => walk(-1), next: () => walk(1),
  "group-prev": () => jumpTag(-1), "group-next": () => jumpTag(1),
  drop: onRow("drop"), keep: onRow("keep"), read: onRow("read"), open: onRow("open"), "open-other": onRow("open-other"),
  tags: onRow("tags"), list: onRow("list"), move: onRow("move"), remove: onRow("remove"),
  undo: () => LinkActions.undo(), filter: () => $("new-name").focus(),
  escape: () => document.querySelector(".tagpop")?.remove(),
}, { labels: { "group-prev": "◂ tag", "group-next": "tag ▸" } });
$("keys-line").append(...LinkKeys.hint(["prev", "next", "group-next", "tags", "open"]));

drawMaker();
reloadOnChanges(load);
load();
