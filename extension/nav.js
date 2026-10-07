/* The bar across the top of every Link Keeper page: a link to each viewer, the current one marked,
 * and the sources those viewers load — stashed tabs, imports, the reading list, any mix of them.
 * Loaded as the first thing in <body>, without defer, so the bar is in place before the page paints
 * and every page gets the same one. Styles are in nav.css.
 *
 * The choice of sources is shared by every page and kept in storage.local, so it holds as you
 * switch viewers and between visits. Pages read it through window.LinkSources:
 *   LinkSources.ready        — a promise of the chosen sources, e.g. ["tabs", "import", "list"]
 *   LinkSources.get()        — the chosen sources, once ready
 *   LinkSources.onChange(fn) — fn(sources) whenever they change, here or on another page
 *   LinkSources.setCounts({ tabs, import, list }) — how many links each holds, shown on its chip */

(() => {
  const PAGES = [
    ["list.html", "List", "Every link, grouped as you like"],
    ["cards.html", "Cards", "Judge what is undecided as a shuffled card deck"],
    ["stash-cards.html", "Explore", "Every link in a sidebar, the chosen one in full with a live preview"],
    ["tags.html", "Tags", "Every tag, each a collection: make, rename, merge and recolour them, and see their links"],
  ];
  const SOURCES = [
    ["tabs", "Stashed tabs", "Stashes made from your open tabs"],
    ["import", "Imports", "Stashes brought in from OneTab, TidyTab, a file or pasted text"],
    ["list", "Reading list", "Links you queued to read, and pages you kept"],
  ];
  const KEY = "viewSources";
  const here = location.pathname.split("/").pop() || "list.html";

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  nav.setAttribute("aria-label", "Link Keeper");

  const brand = document.createElement("span");
  brand.className = "app-brand";
  const logo = document.createElement("img");
  logo.src = "icon.svg";
  logo.alt = "";
  brand.append(logo, "Link Keeper");
  // The installed build, read from the manifest so it cannot go stale.
  const version = browser.runtime.getManifest?.()?.version;
  if (version) {
    const v = document.createElement("span");
    v.className = "app-version";
    v.textContent = `v${version}`;
    v.title = `Link Keeper ${version}`;
    brand.append(v);
  }

  const pages = document.createElement("div");
  pages.className = "app-pages";
  for (const [href, label, title] of PAGES) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.title = title;
    if (href === here) a.setAttribute("aria-current", "page");
    pages.append(a);
  }

  const picker = document.createElement("div");
  picker.className = "app-sources";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Sources to show");
  const chips = new Map();
  for (const [id, label, title] of SOURCES) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-pressed", "true");
    const n = document.createElement("span");
    n.className = "n";
    b.append(label, n);
    b.onclick = () => set(chosen.includes(id) ? chosen.filter(s => s !== id) : [...chosen, id]);
    chips.set(id, b);
    picker.append(b);
  }

  nav.append(brand, pages, picker);
  document.currentScript.replaceWith(nav);

  let chosen = SOURCES.map(([id]) => id);
  const listeners = new Set();
  const paint = () => { for (const [id, b] of chips) b.setAttribute("aria-pressed", String(chosen.includes(id))); };
  const clean = v => (Array.isArray(v) ? SOURCES.map(([id]) => id).filter(id => v.includes(id)) : null);

  async function set(next) {
    chosen = clean(next);
    paint();
    try { await browser.storage.local.set({ [KEY]: chosen }); } catch (e) { for (const fn of listeners) fn(chosen); }
  }

  const ready = (async () => {
    try {
      const got = clean((await browser.storage.local.get(KEY))[KEY]);
      if (got) chosen = got;
    } catch (e) { /* storage unavailable: every source */ }
    paint();
    return chosen;
  })();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    chosen = clean(changes[KEY].newValue) || SOURCES.map(([id]) => id);
    paint();
    for (const fn of listeners) fn(chosen);
  });

  window.LinkSources = {
    ready,
    get: () => chosen,
    onChange: fn => listeners.add(fn),
    setCounts(counts) {
      for (const [id, b] of chips) b.querySelector(".n").textContent = counts[id] == null ? "" : String(counts[id]);
    },
  };
})();
