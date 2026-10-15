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

/* Every tag with its links on show, in three layers as the Links page's chips count them: the links
 * you gave it, and, among links with no tags of yours, those the tag model suggests it for and those
 * whose site suggests it. The library's order, then any in use it does not hold yet. */
const LAYERS = { own: "yours", suggested: "suggested by the tag model", site: "guessed from the site" };
function tagsOnShow() {
  const empty = () => ({ own: [], suggested: [], site: [] });
  const by = new Map(tagPool().map(t => [t, empty()]));
  for (const l of data.links) {
    const s = shownTags(l);
    for (const t of s.tags) (by.get(t) || by.set(t, empty()).get(t))[s.from].push(l);
  }
  return by;
}
const layerTitle = (t, g) => `${t}: ${g.own.length} yours · ${g.suggested.length} suggested · ${g.site.length} guessed from the site`;

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
  for (const [t, g] of by) {
    const more = g.suggested.length + g.site.length;
    const b = el("button", { type: "button", className: g.own.length || more ? "" : "empty-tag", title: layerTitle(t, g) },
      el("span", { className: "dot" }), el("span", { className: "t", textContent: t }),
      el("span", { className: "n" }, String(g.own.length), more ? el("span", { className: "more", textContent: ` +${more}` }) : ""));
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
  const newest = list => list.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const layers = by.get(chosen);
  const links = newest(layers.own);
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
      const res = await renameTagUndoably(chosen, to, merging, links.length);
      if (!res) return render();
      if (!res.ok) return say(res.error || "Unable to rename it");
      say(`${merging ? "Merged" : "Renamed"} ${chosen} → ${to} on ${plural(res.links, "link")} · ⌘Z undoes it`);
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
    const res = await renameTagUndoably(chosen, to, true, links.length);
    if (!res) { merge.value = ""; return; }
    if (!res.ok) return say(res.error || "Unable to merge it");
    say(`Merged ${chosen} into ${to} on ${plural(res.links, "link")} · ⌘Z undoes it`);
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
    if (res.before) LinkActions.push({ label: "Delete tag", cmd: "delete-tag", run: () => send({ type: "put-tags-back", before: res.before }) });
    say(`Deleted ${gone}${res.links ? ` from ${plural(res.links, "link")}; the links stay` : ""} · ⌘Z puts it back`);
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
    el("span", { className: "count", textContent: plural(links.length, "link"), title: layerTitle(chosen, layers) }),
    el("div", { className: "tools" }, rename, merge, del),
    colours));

  if (links.length) coll.append(el("ul", { className: "rows" }, ...links.map(rowEl)));
  else coll.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No links of yours yet" }),
    el("p", { textContent: data.all.links.some(l => l.tags?.includes(chosen)) ? "Its links are in sources that are hidden."
      : layers.suggested.length + layers.site.length ? "Below are the links it is suggested for; tag them all, or press T on one." : "Press T on any link and pick this tag." })));

  // The other two layers: untagged links this tag is suggested for, each with a way to take it on.
  const SHOW = 100;
  for (const from of ["suggested", "site"]) {
    const list = newest(layers[from]);
    if (!list.length) continue;
    const all = el("button", { type: "button", className: "small", textContent: `Tag all ${list.length} ${chosen}`,
      title: `Give these links the tag ${chosen} as yours; their other suggestions no longer show once they have a tag of yours` });
    all.onclick = async () => {
      const res = await send({ type: "tag-links", urls: list.map(l => l.url), tags: [chosen] });
      say(res?.ok ? `Tagged ${plural(res.tagged, "link")} ${chosen}` : res?.error || "Unable to tag them");
      await load();
    };
    coll.append(el("div", { className: "layer-head" },
      el("h3", { textContent: `${from === "suggested" ? "Suggested by the tag model" : "Guessed from the site"} · ${list.length}` }), all));
    coll.append(el("ul", { className: "rows layer" }, ...list.slice(0, SHOW).map(rowEl)));
    if (list.length > SHOW) coll.append(el("p", { className: "hint", textContent: `and ${list.length - SHOW} more; tag them all, or narrow the sources in the bar` }));
  }
}

function rowEl(link) {
  const label = labelOf(link);
  const a = el("a", { className: `ttl${label ? "" : " plain"}`, href: link.url, textContent: label || shortUrl(link.url), title: link.url });
  a.addEventListener("click", e => { e.preventDefault(); LinkActions.run("open", { link }); });
  Peek.mark(a, "link", link.key);
  const meta = el("div", { className: "meta" },
    el("span", { textContent: kindOf(link.url) === "web" ? hostOf(link.url) : kindOf(link.url) === "file" ? "Local file" : "Browser page" }));
  if (link.date) meta.append(el("time", { dateTime: link.date, textContent: link.date.slice(0, 10) }));
  meta.append(...[readBadge(link)].filter(Boolean));
  const others = (link.tags || []).filter(t => t !== chosen);
  if (others.length) meta.append(el("span", { className: "tags" }, ...others.map(t => tagChip(t))));
  const li = el("li", {}, srcIcon(link.url), el("div", { className: "main" }, a, meta, agentRow(link)), LinkActions.bar({ link }, { compact: true }));
  li.dataset.key = link.key;
  if (link.key === cursor) li.classList.add("lk-cursor");
  li.addEventListener("pointerdown", () => setCursor(link.key, false));
  return li;
}

function render() {
  const by = tagsOnShow();
  if (chosen && !by.has(chosen)) chosen = null;
  const size = g => g.own.length + g.suggested.length + g.site.length;
  if (!chosen) chosen = [...by].find(([, g]) => g.own.length)?.[0] || [...by].find(([, g]) => size(g))?.[0] || [...by.keys()][0] || null;
  const used = [...by.values()].filter(g => g.own.length).length;
  const hinted = [...by.values()].filter(g => !g.own.length && size(g)).length;
  $("sub").textContent = `${plural(by.size, "tag")}, ${used} on links of yours shown${hinted ? `, ${hinted} more only suggested (the +N)` : ""} · pick a tag to see its links`;
  renderLib(by);
  renderColl(by);
  if (!rowLis().some(li => li.dataset.key === cursor)) setCursor(rowLis()[0]?.dataset.key || null, false);
}

async function load() {
  data = await loadLinks({ keepFiltered: true });
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
    const leaves = ["list", "move", "remove"].includes(cmd);
    if (leaves && target?.link.key === cursor) walk(1);
    if (res.local) render();
    else await load();
  },
});

LinkKeys.listen({
  prev: () => walk(-1), next: () => walk(1),
  "group-prev": () => jumpTag(-1), "group-next": () => jumpTag(1),
  read: onRow("read"), open: onRow("open"),
  tags: onRow("tags"), accept: onRow("accept"), list: onRow("list"), move: onRow("move"), remove: onRow("remove"),
  undo: () => LinkActions.undo(), filter: () => $("new-name").focus(),
  escape: () => document.querySelector(".tagpop")?.remove(),
}, { labels: { "group-prev": "◂ tag", "group-next": "tag ▸" } });
$("keys-line").append(...LinkKeys.hint(["prev", "next", "group-next", "tags", "read", "remove", "open"]));

drawMaker();
reloadOnChanges(load);
load();
