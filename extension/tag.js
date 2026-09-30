/* Tag: the links from the chosen sources that have no tag of their own, newest first, each with its
 * editor open — for tagging many in one sitting, as swipe-sort's Tag page does for videos.
 *
 * A link tagged here keeps its place, marked ✓, until the filter changes, so the list does not
 * jump under the cursor. Enter on an empty field moves to the next link's field.
 */

const PAGE = 40;
const FILTERS = {
  untagged: l => !l.tags.length,
  guessed: l => !l.tags.length && (l.kinds || []).length > 0,
  blank: l => !l.tags.length && !(l.kinds || []).length,
  all: () => true,
};

let data = { links: [], sources: new Set() };
let filter = "untagged";
let shown = PAGE;
let rows = [];        // the links on screen, fixed until the filter or the search changes
const done = new Set();

function say(text) { $("msg").textContent = text; }

const byNewest = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));

async function load() {
  data = await loadLinks();
  pick();
  render();
}

/* Choose the rows. Called when the filter or the search changes — not after a tag is saved. */
function pick() {
  const term = $("q").value.trim().toLowerCase();
  rows = data.links.filter(FILTERS[filter]).filter(l => !term ||
    `${labelOf(l) || ""} ${l.url} ${l.cap?.text || ""}`.toLowerCase().includes(term)).sort(byNewest);
  done.clear();
}

function rowEl(link) {
  const li = el("li", { className: done.has(link.key) ? "done" : "" });
  const label = labelOf(link);
  const a = el("a", { className: `ttl${label ? "" : " plain"}`, href: link.url, textContent: label || shortUrl(link.url), title: link.url });
  if (isWeb(link.url)) Object.assign(a, { target: "_blank", rel: "noopener noreferrer" });
  else a.addEventListener("click", e => e.preventDefault());
  const main = el("div", { className: "main" }, a);
  const text = (link.cap?.text || "").replace(/\s+/g, " ").trim();
  if (text && !String(label).includes(text.slice(0, 50))) main.append(el("div", { className: "body", textContent: text }));
  const meta = el("div", { className: "meta" }, el("span", { textContent: kindOf(link.url) === "web" ? hostOf(link.url) : kindOf(link.url) === "file" ? "Local file" : "Browser page" }));
  if (link.date) meta.append(el("time", { dateTime: link.date, textContent: link.date.slice(0, 10) }));
  for (const s of link.sources) meta.append(el("span", { className: "badge", textContent: SOURCE_NAMES[s] }));
  main.append(meta);

  const editor = tagEditor(link, tags => {
    if (tags.length) done.add(link.key); else done.delete(link.key);
    li.classList.toggle("done", tags.length > 0);
    paintCounts();
  });
  // Enter on an empty field: on to the next link, as swipe-sort's deck moves on after a verdict.
  editor.addEventListener("tagdone", () => {
    const next = li.nextElementSibling?.querySelector(".tagger input");
    if (next) { next.focus(); next.scrollIntoView({ block: "nearest" }); } else document.activeElement?.blur();
  });
  li.append(srcIcon(link.url), main, editor);
  return li;
}

function paintCounts() {
  const n = f => data.links.filter(FILTERS[f]).length;
  const names = { untagged: "Untagged", guessed: "With a guess", blank: "No guess", all: "All" };
  for (const chip of document.querySelectorAll(".chip[data-f]")) {
    chip.replaceChildren(`${names[chip.dataset.f]} `, el("span", { className: "n", textContent: n(chip.dataset.f) }));
    chip.setAttribute("aria-pressed", String(chip.dataset.f === filter));
  }
  const untagged = n("untagged");
  $("sub").textContent = `${plural(untagged, "link")} without a tag of their own, of ${data.links.length} on show` +
    (done.size ? ` · ${done.size} tagged here` : "");
}

function render() {
  paintCounts();
  const out = $("out");
  out.textContent = "";
  if (!data.sources.size) {
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: "No source chosen" }),
      el("p", { textContent: "Pick Stashed tabs, Imports or Reading list in the bar at the top." })));
    return;
  }
  if (!rows.length) {
    out.append(el("div", { className: "empty" }, el("p", { className: "title", textContent: filter === "untagged" ? "Everything is tagged" : "Nothing here" }),
      el("p", { textContent: filter === "untagged" ? "Every link on show has a tag of its own." : "No link on show matches." })));
    return;
  }
  out.append(el("ul", { className: "tagrows" }, ...rows.slice(0, shown).map(rowEl)));
  if (rows.length > shown) {
    const more = el("button", { textContent: `Show ${Math.min(PAGE, rows.length - shown)} more of ${rows.length - shown}` });
    more.onclick = () => { shown += PAGE; render(); };
    out.append(el("div", { className: "more-row" }, more));
  }
}

for (const chip of document.querySelectorAll(".chip[data-f]")) {
  chip.onclick = () => { filter = chip.dataset.f; shown = PAGE; pick(); render(); };
}
$("q").addEventListener("input", () => { shown = PAGE; pick(); render(); });

/* A change elsewhere (a stash, a capture, another page's tags) reloads, but never while a field
 * here has the focus — reloadOnChanges holds off until typing stops. A reload keeps the rows. */
reloadOnChanges(async () => {
  const keep = new Set(rows.map(l => l.key));
  const before = [...data.sources || []].join();
  data = await loadLinks();
  // A different choice of sources is a different list; anything else keeps the rows in place.
  if ([...data.sources].join() !== before) pick();
  else rows = data.links.filter(l => keep.has(l.key)).sort(byNewest);
  render();
});
load();
