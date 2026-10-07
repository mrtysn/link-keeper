/* Hover previews: anything on a page that names something held elsewhere — a stash, a tag, a link, a
 * site, a place in a source — can show it in a card without leaving the page.
 *
 * A page marks the element, Peek.mark(node, kind, id), and that is all: one listener here opens the
 * card after a short hover (or on keyboard focus), keeps it while the pointer moves into it so what
 * is inside can be clicked, and closes it on leaving, Escape, a click elsewhere or a scroll. Each kind
 * draws itself from the page's data (what loadLinks gave it, read through LinkActions):
 *
 *   stash   "<stash id>" or "<stash id>|<link key>" — its name, when it was stashed, its tabs
 *   held    "<link key>" — every stash holding the link, with where it sits in each
 *   tag     "<tag>" — its colour, its count, its newest links
 *   link    "<link key>" — what is known of it: text, picture, state, where it is held, tags
 *   site    "<host>" — its links on show, and how many are captured
 *   source  "<tabs|import|list>|<link key>" — where the link sits in that source
 *
 * A new kind is one Peek.kind(name, (id, data) => node) call; a renderer returning null shows nothing.
 */

const Peek = (() => {
  const kinds = new Map();
  // A list in a card scrolls; past ROWS it stops drawing, so a site of thousands stays quick.
  const OPEN_AFTER = 350, CLOSE_AFTER = 160, ROWS = 500;
  let card = null, anchor = null, openTimer = null, closeTimer = null;

  const kind = (name, render) => kinds.set(name, render);

  /* Mark a node as a preview of kind:id. Its tooltip goes: the card says more. */
  function mark(node, k, id) {
    if (!node || id == null || id === "") return node;
    node.dataset.peek = `${k}:${id}`;
    node.removeAttribute("title");
    return node;
  }

  function close() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    card?.remove();
    card = null;
    anchor = null;
  }

  function open(a) {
    const spec = a.dataset.peek;
    const at = spec.indexOf(":");
    const render = kinds.get(spec.slice(0, at));
    const data = LinkActions.data();
    const body = render && data ? render(spec.slice(at + 1), data) : null;
    close();
    if (!body || !a.isConnected) return;
    anchor = a;
    card = el("div", { className: "peek", role: "dialog" }, body);
    card.setAttribute("aria-label", "Preview");
    card.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    card.addEventListener("pointerleave", soonClose);
    document.body.append(card);
    place(a.getBoundingClientRect());
    // A list opens on the link it was asked about, in the middle of what shows.
    const list = card.querySelector(".pk-rows"), here = list?.querySelector("li.here");
    if (here) list.scrollTop = here.offsetTop - (list.clientHeight - here.offsetHeight) / 2;
  }

  /* Beside a narrow thing on the left (a sidebar row), else under it, or over it if there is no room. */
  function place(r) {
    const w = card.offsetWidth, h = card.offsetHeight, gap = 8, pad = 8;
    let left, top;
    if (r.right < innerWidth * 0.45 && innerWidth - r.right - gap >= w + pad) {
      left = r.right + gap;
      top = Math.min(Math.max(pad, r.top - 8), innerHeight - h - pad);
    } else {
      left = Math.min(Math.max(pad, r.left), innerWidth - w - pad);
      top = r.bottom + gap + h <= innerHeight - pad ? r.bottom + gap : Math.max(pad, r.top - gap - h);
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
  }

  function soonOpen(a) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (a === anchor) return;
    openTimer = setTimeout(() => open(a), card ? 120 : OPEN_AFTER);
  }
  function soonClose() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, CLOSE_AFTER);
  }

  // A tag being edited, or anything inside a card, does not open another.
  const target = node => {
    const a = node?.closest?.("[data-peek]");
    return a && !a.closest(".tagger, .peek") ? a : null;
  };
  addEventListener("pointerover", e => {
    const a = target(e.target);
    if (a) soonOpen(a);
    else if (!e.target.closest?.(".peek") && (card || openTimer)) soonClose();
  });
  addEventListener("pointerout", e => {
    if (target(e.target) && !target(e.relatedTarget) && !e.relatedTarget?.closest?.(".peek")) soonClose();
  });
  addEventListener("focusin", e => {
    const a = target(e.target);
    if (a && a.matches(":focus-visible")) soonOpen(a);
  });
  addEventListener("focusout", e => { if (target(e.target) && !card?.contains(e.relatedTarget)) soonClose(); });
  addEventListener("keydown", e => { if (e.key === "Escape" && card) close(); }, true);
  addEventListener("pointerdown", e => { if (card && !card.contains(e.target)) close(); }, true);
  addEventListener("scroll", e => { if (card && !card.contains(e.target)) close(); }, true);
  addEventListener("resize", close);

  /* --- pieces the kinds share --- */

  const head = (title, sub) => el("div", { className: "pk-head" }, el("strong", { textContent: title }), sub ? el("span", { textContent: sub }) : null);
  const linkTitle = link => labelOf(link) || shortUrl(link.url);
  function linkRows(links, here) {
    const shown = links.slice(0, ROWS);
    const box = el("ol", { className: "pk-rows" }, ...shown.map(l => el("li", { className: l.key === here ? "here" : "" },
      srcIcon(l.url), el("span", { className: "t", textContent: linkTitle(l) }),
      l.cap ? el("span", { className: "rd on", title: "Captured" }) : null)));
    if (links.length > ROWS) box.append(el("li", { className: "pk-more", textContent: `and ${links.length - ROWS} more` }));
    return box;
  }
  const go = (href, text) => el("a", { className: "pk-go", href, textContent: text });
  const stashOf = (d, id) => d.all.stashes.find(s => s.id === id);
  const SOURCE = { tabs: "Stashed tabs", import: "Imported", list: "Reading list" };
  const byNewest = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));

  /* --- the kinds --- */

  kind("stash", (id, d) => {
    const [sid, here] = id.split("|");
    const s = stashOf(d, sid);
    if (!s) return null;
    const flags = [s.source === "import" ? "imported" : null, s.locked ? "locked" : null, s.starred ? "starred" : null].filter(Boolean);
    const links = s.tabs.map(t => d.byKey.get(t.key)).filter(Boolean);
    const pos = here ? s.tabs.findIndex(t => t.key === here) : -1;
    return el("div", {},
      head(stashName(s), [`${plural(s.tabs.length, "tab")}`, renamed(s) ? `stashed ${whenOf(s.created_at)}` : null, ...flags].filter(Boolean).join(" · ")),
      pos !== -1 ? el("p", { className: "pk-note", textContent: `This link is tab ${pos + 1} of ${s.tabs.length}` }) : null,
      linkRows(links, here),
      go(`list.html?pane=1&stash=${encodeURIComponent(s.id)}`, "Open this stash →"));
  });

  kind("held", (key, d) => {
    const link = d.byKey.get(key);
    if (!link) return null;
    const held = link.copies.map(c => ({ c, s: stashOf(d, c.stash) })).filter(h => h.s)
      .sort((a, b) => String(b.s.created_at).localeCompare(String(a.s.created_at)));
    if (!held.length) return null;
    return el("div", {},
      head(`In ${plural(held.length, "stash")}`, linkTitle(link)),
      el("ul", { className: "pk-places" }, ...held.map(({ c, s }) => {
        const i = s.tabs.findIndex(t => t.id === c.tab);
        return el("li", {}, el("a", { href: `list.html?pane=1&stash=${encodeURIComponent(s.id)}`, textContent: stashName(s) }),
          el("span", { textContent: `tab ${i + 1} of ${s.tabs.length}${renamed(s) ? ` · ${whenOf(s.created_at)}` : ""}` }));
      })));
  });

  kind("tag", (tag, d) => {
    const links = d.links.filter(l => l.tags?.includes(tag)).sort(byNewest);
    const chip = el("span", { className: "tag", textContent: tag });
    chip.style.setProperty("--h", tagHue(tag));
    return el("div", {},
      el("div", { className: "pk-head" }, chip, el("span", { textContent: `${plural(links.length, "link")} shown` })),
      links.length ? linkRows(links) : el("p", { className: "pk-note", textContent: "No link shown has this tag." }),
      go(`tags.html?tag=${encodeURIComponent(tag)}`, "Open in Tags →"));
  });

  kind("link", (key, d) => {
    const link = d.byKey.get(key);
    if (!link) return null;
    const cap = link.cap;
    const text = (cap?.text || "").replace(/\s+/g, " ").trim();
    const where = [link.list ? "Reading list" : null,
      ...link.copies.map(c => stashOf(d, c.stash)).filter(Boolean).map(stashName)].filter(Boolean);
    const state = el("div", { className: "pk-badges" }, ...[verdictBadge(link), readBadge(link)].filter(Boolean),
      ...(link.tags || []).map(t => tagChip(t)));
    return el("div", {},
      head(linkTitle(link), kindOf(link.url) === "web" ? hostOf(link.url) : shortUrl(link.url)),
      cap?.shotThumb ? el("img", { className: "pk-shot", src: cap.shotThumb, alt: "" }) : null,
      // A post's title is its text already; say it once.
      text && !linkTitle(link).replace(/\s+/g, " ").includes(text.slice(0, 40)) ? el("p", { className: "pk-text", textContent: text.length > 320 ? `${text.slice(0, 320)}…` : text }) : null,
      state.childElementCount ? state : null,
      where.length ? el("p", { className: "pk-note", textContent: `In ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}` }) : null);
  });

  kind("site", (host, d) => {
    const siteOf = url => (kindOf(url) === "web" ? hostOf(url) : kindOf(url) === "file" ? "Local files" : "Browser pages");
    const links = d.links.filter(l => siteOf(l.url) === host).sort(byNewest);
    if (!links.length) return null;
    const captured = links.filter(l => l.cap).length;
    return el("div", {},
      head(host, `${plural(links.length, "link")} shown · ${captured} captured`),
      linkRows(links));
  });

  kind("source", (id, d) => {
    const [src, key] = id.split("|");
    const link = d.byKey.get(key);
    if (!link) return null;
    if (src === "list") {
      const l = link.list;
      if (!l) return null;
      const rows = [["Status", { pending: "not opened yet", seen: "opened, undecided", kept: "kept", skipped: "skipped" }[l.status] || l.status],
        ["Added", l.added_at && whenOf(l.added_at)], ["Saved", l.saved_at && whenOf(l.saved_at)],
        ["Note", l.note], ["Kept from", l.loose ? "a page you were on, not the list itself" : null]].filter(r => r[1]);
      return el("div", {}, head(SOURCE.list, linkTitle(link)),
        el("dl", { className: "pk-facts" }, ...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])),
        go("list.html", "Open the List →"));
    }
    const held = link.copies.map(c => ({ c, s: stashOf(d, c.stash) })).filter(h => h.s?.source === src);
    if (!held.length) return null;
    return el("div", {}, head(SOURCE[src] || src, linkTitle(link)),
      el("ul", { className: "pk-places" }, ...held.map(({ c, s }) => {
        const i = s.tabs.findIndex(t => t.id === c.tab);
        return el("li", {}, el("a", { href: `list.html?pane=1&stash=${encodeURIComponent(s.id)}`, textContent: stashName(s) }),
          el("span", { textContent: `tab ${i + 1} of ${s.tabs.length}` }));
      })));
  });

  return { mark, kind, close };
})();
