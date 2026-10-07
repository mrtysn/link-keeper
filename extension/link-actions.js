/* What can be done to a link, the same on every page: tag it, capture it, remove it, or skip it —
 * and open it, move it to a stash or the reading list — with undo of any of them. Keep and drop stay
 * for the marks stored before 5.38, but no page offers them. List, Cards, Explore and Tags call these
 * and draw them with bar(); the keys for them are in link-keys.js.
 *
 * A target is a link and, where the page shows it inside a stash, that copy: { link, stash, tab }.
 * Without a copy, an action that needs one takes the link's first stash on show (the newest).
 *
 * Every change pushes its inverse, so ⌘Z takes back a verdict, a move, a removal, a move to the
 * reading list, and an open that took the tab out of its stash. A removed tab comes back where it
 * was, with its marks; a stash it emptied is written again.
 *
 * A page calls setup() once with:
 *   data()                 — what loadLinks() last gave it
 *   say(text)              — show a message
 *   after(cmd, target, r)  — reload and move on after an action; cmd is "undo" after an undo, and
 *                            "revert" when a verdict failed to save. r.local: the page's data
 *                            already holds the change, so redraw it rather than reload
 *   tags(target, anchor)   — optional: open the page's own tag editor instead of a popover
 *   tagNext()              — optional: Enter on an empty tag field moves to the next link and opens
 *                            its editor, so links are tagged one after another on any page
 */

const LinkActions = (() => {
  const page = { data: () => null, say: () => {}, after: async () => {}, tags: null };
  const undos = [];

  const setup = p => Object.assign(page, p);
  // Enter on an empty tag field: the next link, its editor open — after the closing popover has gone.
  addEventListener("tagdone", e => { if (e.detail?.next && page.tagNext) setTimeout(() => page.tagNext(), 0); });

  /* The copy acted on: the one the page shows, else the first stash on show holding it, else any. */
  function copyOf(t) {
    if (t.stash && t.tab) return { stash: t.stash, tab: t.tab, index: t.stash.tabs.findIndex(x => x.id === t.tab.id) };
    const d = page.data();
    if (!d) return null;
    const order = [...d.stashes, ...d.all.stashes.filter(s => !d.stashes.includes(s))];
    for (const s of order) {
      const c = t.link.copies.find(c => c.stash === s.id);
      const index = c ? s.tabs.findIndex(x => x.id === c.tab) : -1;
      if (index !== -1) return { stash: s, tab: s.tabs[index], index };
    }
    return null;
  }

  /* Every copy, for menus that name each place. */
  function copiesOf(link) {
    const d = page.data();
    return d ? link.copies.map(c => {
      const stash = d.all.stashes.find(s => s.id === c.stash);
      const index = stash ? stash.tabs.findIndex(x => x.id === c.tab) : -1;
      return index === -1 ? null : { stash, tab: stash.tabs[index], index };
    }).filter(Boolean) : [];
  }

  const stashRecord = s => ({ id: s.id, name: s.name, created_at: s.created_at, source: s.source, format: s.format, locked: s.locked, starred: s.starred });
  const tabRecord = c => ({ url: c.tab.url, title: c.tab.title, index: c.index, container: c.tab.container, seen_at: c.tab.seen_at, verdict: c.tab.verdict });
  const putBack = c => send({ type: "put-back", stash: stashRecord(c.stash), tabs: [tabRecord(c)] });
  const fail = (res, fallback) => ({ ok: false, say: res?.error ? res.error[0].toUpperCase() + res.error.slice(1) : fallback });

  const canList = t => { const c = copyOf(t); return !!(c && isWeb(t.link.url) && !c.stash.locked); };
  const canMove = t => { const c = copyOf(t); return !!(c && !c.stash.locked); };
  const canRemove = t => { const c = copyOf(t); return !!((c && !c.stash.locked) || (t.link.list && !t.link.list.loose)); };

  const ACTIONS = {
    async open(t, { other = false } = {}) {
      const copy = copyOf(t);
      if (copy) {
        const res = await send({ type: "restore-stash", id: copy.stash.id, ids: [copy.tab.id], flip: other });
        if (!res?.ok) return fail(res, "Unable to open it");
        return { ok: true, say: restoredText(res), undo: res.removed && { label: "Open", run: () => putBack(copy) } };
      }
      await send({ type: "set-current", url: t.link.url });
      await browser.tabs.create({ url: t.link.url });
      return { ok: true, say: "Opened in a new tab" };
    },

    async keep(t) { return judge(t, "keep"); },
    async drop(t) { return judge(t, "drop"); },

    async read(t) {
      if (!isWeb(t.link.url)) return { ok: false, say: "Only web pages can be captured" };
      const res = await readLink(t.link.url);
      if (!res?.ok) return fail(res, "Unable to capture it");
      const r = res.record;
      const extra = [r.links?.length ? plural(r.links.length, "link") : null,
        r.reply_links?.length ? `${r.reply_links.length} from replies` : null].filter(Boolean).join(", ");
      return { ok: true, say: `Captured ${r.title || hostOf(t.link.url)}${extra ? ` (${extra})` : ""}` };
    },

    async list(t) {
      const copy = copyOf(t);
      if (!copy) return { ok: false, say: t.link.list ? "Already on the reading list" : "Only a stashed link moves to the reading list" };
      if (copy.stash.locked) return { ok: false, say: "That stash is locked" };
      if (!isWeb(t.link.url)) return { ok: false, say: "Only web pages can go to the reading list" };
      const res = await send({ type: "move-stash", id: copy.stash.id, ids: [copy.tab.id] });
      if (!res?.ok) return fail(res, "Unable to move it");
      return {
        ok: true, say: res.added ? "Moved to the reading list" : "Already on the reading list; taken out of the stash",
        undo: { label: "To the reading list", run: async () => {
          if (res.added) await send({ type: "remove", urls: [t.link.url] });
          return putBack(copy);
        } },
      };
    },

    async move(t, { to } = {}) {
      const copy = copyOf(t);
      if (!copy) return { ok: false, say: "Only a stashed link moves between stashes" };
      if (copy.stash.locked) return { ok: false, say: "That stash is locked" };
      if (!to || to === copy.stash.id) return { ok: false, say: "" };
      const res = await send({ type: "move-stashed", ids: [copy.tab.id], to });
      if (!res?.ok) return fail(res, "Unable to move it");
      const before = copy.stash.tabs[copy.index + 1]?.id || null;
      const name = stashName(page.data().all.stashes.find(s => s.id === to) || { name: "the stash" });
      return {
        ok: true, say: `Moved to ${name}`,
        undo: { label: "Move", run: async () => {
          const back = await send({ type: "move-stashed", ids: [copy.tab.id], to: copy.stash.id, before });
          if (back?.ok) return back;
          // The stash it left went with its last tab: write it again, then take this copy out.
          const res2 = await putBack(copy);
          if (res2?.ok) await send({ type: "delete-stash", id: to, ids: [copy.tab.id] });
          return res2;
        } },
      };
    },

    async remove(t, { fromList = false } = {}) {
      const copy = fromList ? null : copyOf(t);
      if (copy) {
        if (copy.stash.locked) return { ok: false, say: "That stash is locked" };
        const res = await send({ type: "delete-stash", id: copy.stash.id, ids: [copy.tab.id] });
        if (!res?.ok) return fail(res, "Unable to remove it");
        return { ok: true, say: `Removed from ${stashName(copy.stash)}`, undo: { label: "Remove", run: () => putBack(copy) } };
      }
      if (!t.link.list || t.link.list.loose) return { ok: false, say: "Nothing to remove it from" };
      const res = await send({ type: "remove", urls: [t.link.url] });
      if (!res?.ok) return fail(res, "Unable to remove it");
      return { ok: true, say: "Removed from the reading list", undo: { label: "Remove", run: () => send({ type: "restore-items", items: res.items || [] }) } };
    },
  };

  /* A verdict lands on the page at once and is saved behind it: the link and its stashed copies
   * take it here, the page redraws from that, and the write follows. Reloads wait for it (pending),
   * so a reload cannot paint the old verdict back; a write that fails puts the old one back. */
  let pending = 0;
  function setVerdict(link, verdict) {
    link.verdict = verdict || undefined;
    const d = page.data();
    for (const c of link.copies || []) {
      const tab = d?.all.stashes.find(s => s.id === c.stash)?.tabs.find(x => x.id === c.tab);
      if (tab) tab.verdict = verdict || undefined;
    }
  }
  function saveVerdict(t, verdict, prev) {
    setVerdict(t.link, verdict);
    pending++;
    return send({ type: "judge-link", url: t.link.url, verdict })
      .then(res => {
        if (res?.ok) return res;
        setVerdict(t.link, prev);
        page.say(`Not saved: ${res?.error || "no answer"}`);
        page.after("revert", t, {});
        return res;
      })
      .finally(() => { pending--; });
  }

  function judge(t, verdict) {
    const prev = t.link.verdict || null;
    const next = prev === verdict ? null : verdict;
    saveVerdict(t, next, prev);
    return {
      ok: true, local: true, cleared: !next, say: next === "keep" ? "Kept" : next === "drop" ? "Dropped" : "Cleared",
      undo: { label: next ? (next === "keep" ? "Keep" : "Drop") : "Clear", local: true, run: () => saveVerdict(t, prev, next) },
    };
  }

  let busy = false;
  /* Carry out cmd on target; opts.mark rides along on its undo entry for the page to read back. */
  async function run(cmd, t, opts = {}) {
    if (!t?.link || busy) return null;
    busy = true;
    try {
      const res = await ACTIONS[cmd](t, opts);
      if (res?.undo) undos.push({ ...res.undo, cmd, target: t, mark: opts.mark });
      if (res?.say) page.say(res.say);
      await page.after(cmd, t, res || {});
      return res;
    } finally {
      busy = false;
    }
  }

  /* A step that changed nothing stored, such as Cards' Later, can still be taken back. */
  const push = entry => undos.push(entry);

  async function undo() {
    const entry = undos.pop();
    if (!entry) { page.say("Nothing to undo"); return null; }
    // A verdict's undo shows at once; its write goes on behind it.
    const res = entry.local ? (entry.run(), null) : await entry.run();
    page.say(res && res.ok === false ? `Could not undo ${entry.label.toLowerCase()}: ${res.error || "no answer"}` : `Undone: ${entry.label.toLowerCase()}`);
    await page.after("undo", entry.target, entry);
    return entry;
  }
  const canUndo = () => undos.length > 0;
  const saving = () => pending > 0;

  /* --- pickers ------------------------------------------------------------------- */

  function tags(t, anchor) {
    if (page.tags) return page.tags(t, anchor);
    anchoredPopover(anchor, tagEditor(t.link, () => page.after("tags", t, {})));
  }

  /* Every other stash, filtered as you type; Enter takes the first. */
  function moveMenu(t, anchor) {
    const copy = copyOf(t);
    if (!copy) return page.say("Only a stashed link moves between stashes");
    if (copy.stash.locked) return page.say("That stash is locked");
    const input = el("input", { type: "text", placeholder: "move to stash…" });
    input.setAttribute("aria-label", "Stash to move it to");
    const list = el("div", { className: "stashpick" });
    const box = el("div", { className: "tagger mover" }, input, list);
    const others = page.data().all.stashes.filter(s => s.id !== copy.stash.id);
    let shown = [];
    const draw = () => {
      const term = input.value.trim().toLowerCase();
      shown = others.filter(s => !term || stashName(s).toLowerCase().includes(term));
      list.textContent = "";
      for (const s of shown.slice(0, 40)) {
        const b = el("button", { type: "button" }, el("span", { textContent: stashName(s) }), el("span", { className: "n", textContent: s.tabs.length }));
        b.onclick = () => pick(s);
        list.append(b);
      }
      if (!shown.length) list.append(el("p", { className: "tagstatus", textContent: "No stash by that name" }));
    };
    const pick = s => {
      box.dispatchEvent(new CustomEvent("tagdone", { bubbles: true }));
      run("move", t, { to: s.id });
    };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", e => { if (e.key === "Enter" && shown[0]) { e.preventDefault(); pick(shown[0]); } });
    draw();
    anchoredPopover(anchor, box);
  }

  /* --- the bar ------------------------------------------------------------------- */

  const keyed = (text, cmd) => [text, el("kbd", { textContent: LinkKeys.showOf(cmd) })];

  /* The actions for one link. Full, as under the one link Cards and Explore show: Open, Tags,
   * Capture and Remove, each a button with its key, the rest under ⋯. Compact, as on a row of List or
   * Tags: Tags, Capture and Remove, with Open under ⋯ (the title opens it too).
   * extra: further menu items, { text, run, title?, className?, disabled? }. */
  function bar(t, { compact = false, extra = [] } = {}) {
    const { link } = t;
    const web = isWeb(link.url);
    const btn = (cmd, text, cls, title, onClick) => {
      const b = el("button", { type: "button", className: `${cls}${compact ? " small" : ""}`, title: `${title} (${LinkKeys.showOf(cmd)})` },
        ...(compact ? [text] : keyed(text, cmd)));
      b.dataset.cmd = cmd;
      b.onclick = e => { e.stopPropagation(); onClick ? onClick(b) : run(cmd, t); };
      b.addEventListener("pointerdown", e => e.stopPropagation());   // not the start of a drag
      return b;
    };
    // The four things done to a link — tag it, capture it, remove it, or skip it (the walking keys) —
    // and Open. Remove takes out only the copy on show; every other copy is a separate ⋯ item.
    const copy = copyOf(t);
    const open = btn("open", "Open", "primary", copy ? `Reopen this tab; ${LinkKeys.showOf("open-other")} uses the other restore option` : "Open it in a new tab");
    const tagsB = btn("tags", "Tags", "", "Edit its tags", a => tags(t, a));
    const capture = web && btn("read", link.cap ? "Capture again" : "Capture", "", "Load it in a background tab and save its text, images and links");
    const where = copy ? stashName(copy.stash) : "the reading list";
    const others = copiesOf(link).length + (link.list && !link.list.loose ? 1 : 0) - 1;
    const remove = canRemove(t) && btn("remove", "Remove", "danger",
      `Take it out of ${where}${others === 1 ? "; its other copy stays" : others > 1 ? `; its ${others} other copies stay` : ""}`);
    const more = [
      compact && { text: `Open  ${LinkKeys.showOf("open")}`, run: () => run("open", t) },
      canMove(t) && { text: `Move…  ${LinkKeys.showOf("move")}`, title: "Move it to another stash", run: () => moveMenu(t, out.querySelector(".more") || out) },
      canList(t) && { text: `To list  ${LinkKeys.showOf("list")}`, title: "Move it out of its stash onto the reading list", run: () => run("list", t) },
    ].filter(Boolean);
    const removals = menuItems(t, extra, true);
    const items = [...more, ...(more.length && removals.length ? ["-"] : []), ...removals];
    const out = el("div", { className: `lk-bar${compact ? " compact" : ""}` }, ...[compact ? null : open, tagsB, capture, remove].filter(Boolean));
    if (items.length) out.append(...popoverMenu("⋯", `More for ${labelOf(link) || shortUrl(link.url)}`, items));
    return out;
  }

  /* The removals, one per place the link is held, then the page's own items. In the full bar the
   * Remove button covers the copy on show, so only the other places are listed. */
  function menuItems(t, extra, othersOnly) {
    const shown = copyOf(t);
    const removals = [];
    for (const c of copiesOf(t.link)) {
      if (othersOnly && shown && c.tab.id === shown.tab.id) continue;
      removals.push({ text: `Remove from ${stashName(c.stash)}`, className: "danger", disabled: c.stash.locked,
        title: c.stash.locked ? "The stash is locked" : "", run: () => run("remove", { link: t.link, stash: c.stash, tab: c.tab }) });
    }
    if (t.link.list && !t.link.list.loose && !(othersOnly && !shown)) {
      removals.push({ text: "Remove from the reading list", className: "danger", run: () => run("remove", t, { fromList: true }) });
    }
    const out = [];
    if (extra.length) out.push(...extra);
    if (removals.length) out.push(...(out.length ? ["-"] : []), ...removals);
    return out;
  }

  /* What a key does to the link a page has selected; pages route commands here. */
  function key(cmd, t, anchor) {
    if (!t?.link) return;
    if (cmd === "tags") return tags(t, anchor);
    if (cmd === "move") return moveMenu(t, anchor);
    if (cmd === "open-other") return run("open", t, { other: true });
    return run(cmd, t);
  }

  return { setup, run, push, undo, canUndo, saving, data: () => page.data(), bar, key, copyOf, moveMenu, tags };
})();
