/* The slice of the WebExtension API the pages call, answered from window.MOCK. "links" is joined by
 * the real joinLinks (links.js, loaded ahead of this). Query flags pick the state to render;
 * preview.zsh --help lists them. */
(() => {
  const M = window.MOCK;
  const params = new URLSearchParams(location.search);

  const storageListeners = new Set();
  // Tags set by hand, keyed like the link; a few to start with so the chips and filters show.
  const mockTags = params.has("notags") ? {} : {};
  let tagsSeeded = params.has("notags");
  const PRESETS = ["to-read", "to-watch", "to-try", "reference", "inspiration", "work", "personal", "buy",
    "dev", "ai", "design", "news", "video", "shopping", "music", "games"];
  const library = () => (store.tagDefs ||= { seeded: true, list: PRESETS.map(name => ({ name, hue: null })) }).list;
  // As the background does: every tag in use joins the library, and a change is a storage change.
  const saveTags = async () => {
    const lib = library();
    for (const tags of Object.values(mockTags)) for (const t of tags) if (!lib.some(d => d.name === t)) lib.push({ name: t, hue: null });
    await window.browser.storage.local.set({ tagDefs: { seeded: true, list: lib } });
  };
  const store = {
    ...(params.has("sources") && { viewSources: params.get("sources").split(",").filter(Boolean) }),
    popupUi: params.has("msg")
      ? {
        note: "",
        noting: params.has("note"),
        msg: M.msg,
        msgClass: "ok",
      }
      : undefined,
  };

  if (!params.has("notags")) library();
  // One site with its own icon saved, as a stash leaves them (background.js, favicons).
  store.favicons = { "gamejams.example": { icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#2a9d8f"/></svg>')}`, src: "https://gamejams.example/favicon.ico" } };

  // The background hands the list ISO dates; mirror that for records that only carry X's format.
  const toIso = value => {
    const t = Date.parse(value || "");
    return Number.isNaN(t) ? value : new Date(t).toISOString();
  };

  if (params.has("light")) {
    addEventListener("DOMContentLoaded", () => {
      for (const sheet of document.styleSheets) {
        for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
          if (/prefers-color-scheme/.test(sheet.cssRules[i].media?.mediaText || "")) sheet.deleteRule(i);
        }
      }
    });
  }

  const bookmarkListeners = {};
  // Panels and views of the Stashed tabs page, opened as a click or a pick would.
  // import-run pastes 300 OneTab lines and presses Import.
  if (params.has("import-run")) {
    addEventListener("load", () => setTimeout(() => {
      document.getElementById("import").click();
      const box = document.getElementById("import-text");
      box.value = Array.from({ length: 300 }, (_, i) => `https://site-${i}.example/ | Page ${i}${i % 100 === 99 ? "\n" : ""}`).join("\n");
      box.dispatchEvent(new Event("input"));
      document.getElementById("import-go").click();
    }, 200));
  }
  if (params.has("group")) try { localStorage.setItem("listGroup", params.get("group")); } catch (e) { /* no storage */ }
  for (const panel of ["settings", "import", "dups"]) {
    if (params.has(panel)) addEventListener("load", () => setTimeout(() => document.getElementById(panel)?.click(), 200));
  }

  /* Three stashes cut from the mock rows: a named, starred one with a restored tab and a container
   * tab; a locked one named after its time; and an older OneTab import that shares a URL with the
   * first, for the "also in" badge. */
  function mockSessions() {
    if (params.has("empty")) return [];
    const whenOf = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    let n = 0;
    const tabs = M.dump.items.map((r, i) => ({
      id: `bm${++n}`,
      url: r.url,
      title: i % 4 === 3 ? undefined : (r.cap?.title || r.cap?.text?.slice(0, 120) || undefined),
    }));
    tabs.splice(3, 0,
      { id: `bm${++n}`, url: "file:///Users/someone/dev/notes/out/2026-09-27-report.html", title: "Companion Link Report" },
      { id: `bm${++n}`, url: "moz-extension://4b1c/bookmarks.html", title: "Visual bookmarks" });
    const first = tabs.slice(0, 7).map((t, i) => ({
      ...t, ...(i === 1 && { seen_at: "2026-09-28T09:12:00Z", verdict: "keep" }), ...(i === 2 && { container: "firefox-container-7" }),
      ...(i === 5 && { verdict: "drop" }),
    }));
    const second = tabs.slice(7, 13);
    const third = [{ ...tabs[0], id: `bm${++n}` }, ...tabs.slice(13),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `bm${++n}`, url: `https://gamejams.example/jam-${i}`, title: `Jam page ${i}` }))];
    return [
      { id: "a", name: "Research for the jam", created_at: "2026-09-28T08:40:00Z", starred: true, locked: false, source: "tabs", tabs: first },
      { id: "b", name: whenOf("2026-09-21T19:05:00Z"), created_at: "2026-09-21T19:05:00Z", starred: false, locked: true, source: "tabs", tabs: second },
      { id: "c", name: whenOf("2026-08-30T11:20:00Z"), created_at: "2026-08-30T11:20:00Z", starred: false, locked: false, source: "import", format: "onetab", tabs: third },
    ];
  }

  /* The stored state the actions change — stashes, reading-list items and captures — built once from
   * the mock rows, then edited as the background would, so an action and its undo can be watched. */
  let state = null;
  let nextId = 1000;
  function stored() {
    if (state) return state;
    const rows = [...M.dump.items, ...M.dump.loose];
    state = {
      sessions: mockSessions(),
      items: M.dump.items.map(r => ({ url: r.url, status: r.status, added_at: r.added_at, saved_at: toIso(r.saved_at), title: r.title, note: r.note })),
      captures: rows.filter(r => r.cap).map(r => ({
        url: r.url, title: r.cap.title, author: r.cap.handle ? { handle: r.cap.handle } : undefined, text: r.cap.text, kind: r.cap.kind,
        links: r.cap.links, reply_links: r.cap.reply_links, images: r.cap.images, verdict: r.cap.verdict || undefined,
        captured_at: "2026-09-20T10:00:00Z",
      })),
    };
    return state;
  }
  const findStash = id => stored().sessions.find(s => s.id === id);
  function takeTabs(id, ids) {
    const s = findStash(id);
    if (!s || s.locked) return [];
    const taken = s.tabs.filter(t => ids.includes(t.id));
    s.tabs = s.tabs.filter(t => !ids.includes(t.id));
    if (!s.tabs.length) stored().sessions = stored().sessions.filter(x => x !== s);
    return taken;
  }

  window.browser = {
    runtime: {
      getURL: p => `${location.origin}/${p}`,
      getManifest: () => ({ version: "0.0-preview" }),
      sendMessage: async msg => {
        switch (msg.type) {
          case "status": {
            const status = structuredClone(M.status);
            if (params.has("onpage")) status.current.isOpen = true;
            return status;
          }
          case "sessions":
            return { sessions: structuredClone(stored().sessions) };
          case "link-counts": {
            const { links, stashes } = await window.browser.runtime.sendMessage({ type: "links" });
            const chosen = store.viewSources || ["tabs", "import", "list"];
            const shown = links.filter(l => l.sources.some(x => chosen.includes(x)));
            const sources = { tabs: 0, import: 0, list: 0 };
            for (const l of links) for (const x of l.sources) sources[x]++;
            return { total: shown.length, undecided: shown.filter(l => !l.verdict).length, sources, stashes: stashes.length, chosen };
          }
          case "links": {
            // The stored shapes joinLinks reads.
            const { items, captures } = structuredClone(stored());
            const sessions = structuredClone(stored().sessions);
            if (!tagsSeeded) {
              tagsSeeded = true;
              M.dump.items.slice(0, 9).forEach((r, i) => { mockTags[keyOf(r.url)] = [["ai tools", "game dev"], ["ai tools"], ["game dev", "to try"]][i % 3]; });
            }
            return joinLinks({ items, captures, sessions, tags: mockTags,
              currentKey: M.dump.items.find(r => r.current) ? keyOf(M.dump.items.find(r => r.current).url) : null });
          }
          case "set-tags": {
            const tags = [...new Set((msg.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean))];
            if (tags.length) mockTags[keyOf(msg.url)] = tags; else delete mockTags[keyOf(msg.url)];
            await saveTags();
            return { ok: true, tags };
          }
          // The tag library, as the background keeps it (tagDefs): made, recoloured, renamed or merged, deleted.
          case "create-tag": {
            const t = String(msg.name || "").toLowerCase().replace(/\s+/g, " ").trim();
            if (!t) return { ok: false, error: "a tag needs a name" };
            if (library().some(d => d.name === t)) return { ok: false, error: `${t} already exists` };
            library().push({ name: t, hue: msg.hue ?? null });
            await saveTags();
            return { ok: true, tag: t };
          }
          case "recolor-tag": {
            const d = library().find(x => x.name === msg.tag);
            if (!d) return { ok: false, error: "no such tag" };
            d.hue = msg.hue ?? null;
            await saveTags();
            return { ok: true };
          }
          case "rename-tag": case "delete-tag": {
            const from = msg.type === "rename-tag" ? msg.from : msg.tag, to = msg.to;
            const lib = library(), i = lib.findIndex(d => d.name === from);
            if (msg.type === "delete-tag" || lib.some(d => d.name === to)) { if (i !== -1) lib.splice(i, 1); }
            else if (i !== -1) lib[i].name = to;
            let n = 0;
            for (const k of Object.keys(mockTags)) {
              if (!mockTags[k].includes(from)) continue;
              n++;
              mockTags[k] = [...new Set(mockTags[k].flatMap(t => (t !== from ? [t] : to ? [to] : [])))];
              if (!mockTags[k].length) delete mockTags[k];
            }
            await saveTags();
            return { ok: true, links: n };
          }
          case "import-stashes": {
            // Writes one bookmark every 10 ms, as Firefox reports them, so the progress shows.
            const tabs = msg.stashes.flatMap(st => st.tabs);
            for (const [i, t] of tabs.entries()) {
              await new Promise(r => setTimeout(r, 10));
              for (const fn of bookmarkListeners.onCreated || []) fn(`imp${i}`, { id: `imp${i}`, url: t.url });
            }
            return { ok: true, stashes: msg.stashes.length, tabs: tabs.length };
          }
          case "judge-link": {
            const key = keyOf(msg.url), v = msg.verdict, st = stored();
            for (const c of st.captures) if (keyOf(c.url) === key) v ? (c.verdict = v) : delete c.verdict;
            for (const i of st.items) {
              if (keyOf(i.url) !== key) continue;
              if (v === "keep") i.status = "kept"; else if (v === "drop") i.status = "skipped"; else if (i.status === "kept" || i.status === "skipped") i.status = "seen";
            }
            for (const s of st.sessions) for (const t of s.tabs) if (keyOf(t.url) === key) v ? Object.assign(t, { verdict: v, judged_at: new Date().toISOString() }) : (delete t.verdict, delete t.judged_at);
            return { ok: true };
          }
          case "restore-stash": {
            const remove = !!msg.flip;   // the mock's setting is "keep"
            if (remove) takeTabs(msg.id, msg.ids);
            else for (const t of findStash(msg.id)?.tabs || []) if (msg.ids.includes(t.id)) t.seen_at = new Date().toISOString();
            return { ok: true, restored: msg.ids.length, removed: remove, viaHelper: 0, standins: 0 };
          }
          case "delete-stash": {
            const s = findStash(msg.id);
            if (s?.locked) return { ok: false, error: "that stash is locked; unlock it first" };
            return { ok: true, removed: takeTabs(msg.id, msg.ids).length };
          }
          case "move-stash": {
            const s = findStash(msg.id);
            if (s?.locked) return { ok: false, error: "that stash is locked" };
            const taken = takeTabs(msg.id, msg.ids).filter(t => /^https?:/.test(t.url));
            const have = new Set(stored().items.map(i => keyOf(i.url)));
            const fresh = taken.filter(t => !have.has(keyOf(t.url)));
            stored().items.push(...fresh.map(t => ({ url: t.url, title: t.title, status: "pending", added_at: new Date().toISOString(), saved_at: s.created_at })));
            return { ok: true, added: fresh.length, moved: taken.length };
          }
          case "move-stashed": {
            const to = findStash(msg.to);
            if (!to) return { ok: false, error: "that stash is gone" };
            for (const id of msg.ids) {
              const from = stored().sessions.find(s => s.tabs.some(t => t.id === id));
              if (!from) continue;
              if (from.locked && from !== to) return { ok: false, error: "that stash is locked" };
              const tab = from.tabs.find(t => t.id === id);
              from.tabs = from.tabs.filter(t => t !== tab);
              const at = msg.before ? to.tabs.findIndex(t => t.id === msg.before) : -1;
              to.tabs.splice(at < 0 ? to.tabs.length : at, 0, tab);
              if (!from.tabs.length && from !== to) stored().sessions = stored().sessions.filter(x => x !== from);
            }
            return { ok: true, moved: msg.ids.length };
          }
          case "put-back": {
            let s = findStash(msg.stash.id);
            if (!s) {
              s = { ...msg.stash, id: `s${++nextId}`, tabs: [] };
              stored().sessions.unshift(s);
            }
            const ids = [];
            for (const t of [...msg.tabs].sort((a, b) => a.index - b.index)) {
              const tab = { ...t, id: `bm${++nextId}` };
              delete tab.index;
              s.tabs.splice(Math.min(t.index ?? s.tabs.length, s.tabs.length), 0, tab);
              ids.push(tab.id);
            }
            return { ok: true, id: s.id, ids };
          }
          case "remove": {
            const drop = new Set(msg.urls.map(keyOf));
            const removed = stored().items.filter(i => drop.has(keyOf(i.url)));
            stored().items = stored().items.filter(i => !drop.has(keyOf(i.url)));
            return { ok: true, removed: drop.size, items: removed };
          }
          case "restore-items": {
            const have = new Set(stored().items.map(i => keyOf(i.url)));
            const back = (msg.items || []).filter(i => !have.has(keyOf(i.url)));
            stored().items.push(...back);
            return { ok: true, restored: back.length };
          }
          case "stash-settings":
            return { settings: { afterStash: "show", afterRestore: "keep", exclude: ["mail.google.com", "calendar.google.com"] } };
          case "get-folder": return { folder: "link-keeper", fallback: "link-keeper" };
          case "fetch-pending": return { ok: false, quiet: true };
          default: return { ok: true, remaining: 0, added: 0, total: M.status.total };
        }
      },
    },
    storage: {
      local: {
        get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[k]])),
        set: async obj => {
          const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
          Object.assign(store, obj);
          for (const fn of storageListeners) fn(changes, "local");
        },
      },
      onChanged: { addListener(fn) { storageListeners.add(fn); } },
    },
    bookmarks: Object.fromEntries(["onCreated", "onRemoved", "onChanged", "onMoved"].map(k => [k, {
      addListener(fn) { (bookmarkListeners[k] ||= new Set()).add(fn); },
      removeListener(fn) { bookmarkListeners[k]?.delete(fn); },
    }])),
    permissions: { request: async () => true, contains: async () => true },
    tabs: { update: async () => {}, create: async () => {} },
  };
})();
