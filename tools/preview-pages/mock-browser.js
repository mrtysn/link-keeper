/* The slice of the WebExtension API the pages call, answered from window.MOCK. "links" is joined by
 * the real joinLinks (links.js, loaded ahead of this). Query flags pick the state to render;
 * preview.zsh --help lists them. */
(() => {
  const M = window.MOCK;
  const params = new URLSearchParams(location.search);
  // ?scale=N pads the sample to N links, spread over 150 made-up sites, to measure the pages at the
  // owner's size (about 2000) rather than the sample's 40.
  if (params.has("scale")) {
    const want = Number(params.get("scale")) || 2000, base = M.dump.items.slice();
    for (let i = M.dump.items.length; i < want; i++) {
      const r = base[i % base.length];
      M.dump.items.push({ ...r, url: `https://site${i % 150}.example/${i}`, current: false, cap: r.cap && { ...r.cap } });
    }
  }

  const storageListeners = new Set();
  // The capture queue as capture-queue.js reports it (its status message).
  const idleQueue = () => ({ status: "idle", speed: "normal", total: 0, captured: 0, skipped: 0, pending: 0, active: [], failed: [], stoppedSites: {}, next: null, sites: [], recent: [] });
  const mockQueue = idleQueue();
  if (params.has("queue")) {
    Object.assign(mockQueue, { status: params.get("queue") || "running", total: 1009, captured: 211, skipped: 3, pending: 788, active: [],
      next: { host: "instagram.com", at: Date.now() + 22000 },
      failed: [
        { url: "https://www.instagram.com/p/DAbc123/", error: "www.instagram.com asked to log in" },
        { url: "https://www.instagram.com/reel/DXyz789/", error: "not tried: www.instagram.com asked to log in" },
        { url: "https://slow.example/post", error: "the page never finished loading" }],
      stoppedSites: { "instagram.com": "www.instagram.com asked to log in" },
      active: params.get("queue") === "running" || !params.get("queue") ? ["https://github.com/someone/repo42", "https://news.ycombinator.com/item?id=1"] : [],
      sites: [
        { host: "x.com", waiting: 240, captured: 58, failed: 0, loading: false, nextAt: Date.now() + 22000, gap: 30000, stopped: null },
        { host: "github.com", waiting: 61, captured: 14, failed: 0, loading: true, nextAt: 0, gap: 2000, stopped: null },
        { host: "youtube.com", waiting: 70, captured: 10, failed: 0, loading: false, nextAt: Date.now() + 5000, gap: 8000, stopped: null },
        { host: "news.ycombinator.com", waiting: 30, captured: 12, failed: 0, loading: true, nextAt: 0, gap: 2000, stopped: null },
        { host: "instagram.com", waiting: 0, captured: 0, failed: 2, loading: false, nextAt: 0, gap: 30000, stopped: "www.instagram.com asked to log in" },
        { host: "slow.example", waiting: 0, captured: 3, failed: 1, loading: false, nextAt: 0, gap: 2000, stopped: null }],
      recent: [
        { url: "https://github.com/someone/repo41", title: "someone/repo41: A tool that does one thing well", kind: "repo", chars: 2140, thin: false, at: new Date(Date.now() - 4000).toISOString() },
        { url: "https://pstream.org/", title: "P-Stream", kind: "page", chars: 0, thin: true, at: new Date(Date.now() - 9000).toISOString() },
        { url: "https://x.com/someone/status/1", title: "Someone on X: a thread about capture queues", kind: "tweet", chars: 512, thin: false, at: new Date(Date.now() - 15000).toISOString() }] });
  }
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
        msg: "captured (+3 links)\npng 1346×32000 from 31 tiles → link-keeper/x-preview.png",
        // About the about: page the ?tab=about state shows, and recent, as one just made.
        url: "about:preferences", at: Date.now(),
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

  /* Three stashes cut from the mock rows: a named one with a container tab; one named after its
   * time; and an older OneTab import that shares a URL with the
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
      ...t, ...(i === 2 && { container: "firefox-container-7" }),
    }));
    const second = tabs.slice(7, 13);
    const third = [{ ...tabs[0], id: `bm${++n}` }, ...tabs.slice(13),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `bm${++n}`, url: `https://gamejams.example/jam-${i}`, title: `Jam page ${i}` }))];
    return [
      { id: "a", name: "Research for the jam", created_at: "2026-09-28T08:40:00Z", source: "tabs", tabs: first },
      { id: "b", name: whenOf("2026-09-21T19:05:00Z"), created_at: "2026-09-21T19:05:00Z", source: "tabs", tabs: second },
      { id: "c", name: whenOf("2026-08-30T11:20:00Z"), created_at: "2026-08-30T11:20:00Z", source: "import", format: "onetab", tabs: third },
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
      trash: [],
      items: M.dump.items.map(r => ({ url: r.url, added_at: r.added_at, saved_at: toIso(r.saved_at), title: r.title, note: r.note })),
      captures: rows.filter(r => r.cap).map(r => ({
        url: r.url, title: r.cap.title, author: r.cap.handle ? { handle: r.cap.handle } : undefined, text: r.cap.text, kind: r.cap.kind,
        account: r.cap.account, thread: r.cap.thread, senders: r.cap.senders,
        links: r.cap.links, reply_links: r.cap.reply_links,
        replies: Array.from({ length: r.cap.reply_count || 0 }, (_, n) => ({ handle: `@reply${n}`, text: `reply ${n}`, url: `https://x.com/reply${n}/status/${n}`, links: [] })), images: r.cap.images,
        captured_at: "2026-09-20T10:00:00Z",
      })),
    };
    return state;
  }
  const findStash = id => stored().sessions.find(s => s.id === id);
  function takeTabs(id, ids) {
    const s = findStash(id);
    if (!s) return [];
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
          // ?chat on the popup: the tab is an x.com chat, grabbed once before (?chat=new: never; =locked).
          case "chat-info": {
            if (!params.has("chat")) return null;
            const how = params.get("chat");
            return { platform: "x", site: "X", thread: { id: "1-2", name: "Friend", handle: "@friend" }, locked: how === "locked", ready: how !== "locked",
              key: "x:1-2", last: how === "new" || how === "locked" ? null : { newest: Date.parse("2026-10-10T18:00:00Z"), at: "2026-10-11T09:00:00Z", name: "@friend" },
              // ?chat=running: a grab under way on the page (=paused: held).
              ...(how === "running" || how === "paused" ? { run: { done: false, paused: how === "paused", progress: { messages: 140, links: 23, oldest: Date.parse("2026-08-25T12:00:00Z"), loads: 3 } } } : {}) };
          }
          case "chat-control":
            return { ok: true };
          // ?exports=running|done|failed: the Import panel's import from exports, as the helper reports it.
          case "import-status": {
            const how = params.get("exports");
            const lines = ["--- import 2026-10-16T14:00:00", "export : ~/Downloads/Telegram Desktop/ChatExport/result.json", "1/8  x.com via FxTwitter", "2/8  everything else via og: tags and free APIs"];
            if (how === "done") lines.push("5/8  merging", "  handover: 997 captures, 27 for the browser", "--- exit 0");
            if (how === "failed") lines.push("  ! could not reach node01 — using the last mirror", "--- exit 1");
            return how ? { ok: true, running: how === "running", started: "2026-10-16T14:00:00", lines, exit: how === "done" ? 0 : how === "failed" ? 1 : null }
              : { ok: true, running: false, started: null, lines: [], exit: null };
          }
          case "import-start":
            return { ok: true, pid: 1, started: "2026-10-16T14:00:00" };
          // ?watch=running: the helper watching videos, two waiting.
          case "watch-settings":
            if (typeof msg.onCapture === "boolean") store.watchOnCapture = msg.onCapture;
            return { ok: true, onCapture: store.watchOnCapture !== false };
          case "watch-status":
            return params.get("watch") === "running" ? { ok: true, running: true, queued: 2, imported: 0 } : { ok: true, running: false, queued: 0, imported: 0 };
          case "watch-start":
            return { ok: true, added: 1, queued: 1, running: true };
          case "grab-chat":
            return { ok: true, summary: "@friend: 12 links in 140 messages (2026-08-25 to 2026-10-15), 9 new, 3 already held, now with this chat" };
          case "link-counts": {
            const { links, stashes } = await window.browser.runtime.sendMessage({ type: "links" });
            const chosen = store.viewSources || ["tabs", "import", "list"];
            const shown = links.filter(l => l.sources.some(x => chosen.includes(x)));
            const sources = { tabs: 0, import: 0, list: 0 };
            for (const l of links) for (const x of l.sources) sources[x]++;
            return { total: shown.length, untagged: shown.filter(l => !l.tags.length).length, sources, stashes: stashes.length, chosen };
          }
          case "links": {
            // The stored shapes joinLinks reads.
            const { items, captures } = structuredClone(stored());
            const sessions = structuredClone(stored().sessions);
            if (!tagsSeeded) {
              tagsSeeded = true;
              M.dump.items.slice(0, 9).forEach((r, i) => { mockTags[keyOf(r.url)] = [["ai tools", "game dev"], ["ai tools"], ["game dev", "to try"]][i % 3]; });
            }
            // ?suggest: every link a model suggested two tags for, as the stored map holds them; every
            // third link also has "dev" from Gutsy, so that tag arrives from two sources.
            const suggestions = {};
            if (params.has("suggest")) {
              const urls = [...items.map(i => i.url), ...captures.map(c => c.url), ...sessions.flatMap(s => s.tabs.map(x => x.url))];
              urls.forEach((u, i) => {
                const tags = [{ tag: "dev", p: 0.82, by: "model" }, { tag: "ai", p: 0.64, by: "system-one" }];
                if (i % 3 === 0) tags.push({ tag: "dev", p: 0.9, by: "system-one" }, { tag: "ai", p: 0.6, by: "gutsy" });
                suggestions[keyOf(u)] = { at: "2026-10-14T00:00:00Z", tags };
              });
            }
            // ?agent: every second link carries tags a Claude agent wrote (haiku), as the stored map holds them;
            // together with the seeded own tags and ?suggest, links show all three layers.
            const agentTags = {};
            if (params.has("agent")) {
              const urls = [...items.map(i => i.url), ...captures.map(c => c.url), ...sessions.flatMap(s => s.tabs.map(x => x.url))];
              urls.forEach((u, i) => {
                if (i % 2 === 0) agentTags[keyOf(u)] = { at: "2026-10-14T00:00:00Z", by: "haiku", tags: i % 4 === 0 ? ["ai tools", "tutorial", "rust"] : ["tutorial", "game dev"] };
              });
            }
            // Previews for the links never captured, as the background keeps them: a drawn picture, a title and a line.
            const pic = (h, c) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${h} 45% 45%)"/><circle cx="${c}" cy="90" r="46" fill="hsl(${h} 60% 75%)"/></svg>`);
            const previews = params.has("nopreviews") ? {} : Object.fromEntries(items.filter(i => !captures.some(c => keyOf(c.url) === keyOf(i.url)))
              .map((i, n) => [keyOf(i.url), { title: `Preview title of ${new URL(i.url).hostname}${new URL(i.url).pathname}`, text: "What the page says it is about, from its preview tags, cut to one line or two.", image: pic(n * 47 % 360, 80 + n * 30 % 160) }]));
            // ?fails: two links not captured carry a recorded failure, as the capture queue leaves them.
            const capKeys = new Set(captures.map(c => keyOf(c.url)));
            const fails = !params.has("fails") ? {} : Object.fromEntries(items.filter(i => /^https?:/.test(i.url) && !capKeys.has(keyOf(i.url))).slice(0, 2)
              .map((i, n) => [keyOf(i.url), n ? { error: "www.example.com asked to log in", kind: "wall", at: "2026-10-20T01:30:00Z" } : { error: "kept, but the page showed almost no text", kind: "thin", at: "2026-10-20T01:31:00Z" }]));
            return joinLinks({ items, captures, sessions, tags: mockTags, suggestions, agentTags, previews, fails,
              currentKey: M.dump.items.find(r => r.current) ? keyOf(M.dump.items.find(r => r.current).url) : null });
          }
          // Filtered out, as the background keeps it: rules on a page's address, tagging what matches.
          case "filter-rules": return { rules: store.filterRules || [] };
          case "set-filter-rules": {
            const form = u => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, "")}${x.hash ? x.pathname : x.pathname.replace(/\/+$/, "")}${x.hash}`; } catch (e) { return ""; } };
            const rules = (msg.rules || []).map(r => r.trim().replace(/^https?:\/\//, "").replace(/^www\./, "")).filter(Boolean);
            const tests = rules.map(r => new RegExp(`^${r.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
            const { links } = await window.browser.runtime.sendMessage({ type: "links" });
            let matched = 0;
            for (const l of links) {
              const hit = tests.some(t => t.test(form(l.url)));
              const tags = (mockTags[l.key] || []).filter(t => t !== "filtered-out");
              if (hit) { matched++; mockTags[l.key] = [...tags, "filtered-out"]; } else if (tags.length) mockTags[l.key] = tags; else delete mockTags[l.key];
            }
            store.filterRules = rules;
            await saveTags();
            return { ok: true, matched, added: matched, removed: 0, rules };
          }
          // The popup's page: the link as the pages see it, and the stashes holding it.
          case "page-info": {
            const { links, stashes } = await window.browser.runtime.sendMessage({ type: "links" });
            const link = links.find(l => l.key === keyOf(msg.url)) || null;
            const tagUse = {};
            for (const l of links) for (const t of l.tags) tagUse[t] = (tagUse[t] || 0) + 1;
            return { link, stashes: link ? stashes.filter(s => link.copies.some(c => c.stash === s.id)) : [], tagUse };
          }
          case "set-tags": {
            const tags = [...new Set((msg.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean))];
            if (tags.length) mockTags[keyOf(msg.url)] = tags; else delete mockTags[keyOf(msg.url)];
            await saveTags();
            return { ok: true, tags };
          }
          case "tag-links": {
            const extra = [...new Set((msg.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean))];
            if (!extra.length) return { ok: false, error: "no tag given" };
            const keys = [...new Set((msg.urls || []).map(keyOf))];
            for (const k of keys) mockTags[k] = [...new Set([...(mockTags[k] || []), ...extra])];
            await saveTags();
            return { ok: true, tagged: keys.length };
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
            const before = { links: structuredClone(mockTags), lib: structuredClone(lib) };
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
            return { ok: true, links: n, before };
          }
          case "put-tags-back": {
            for (const k of Object.keys(mockTags)) delete mockTags[k];
            Object.assign(mockTags, msg.before.links);
            library().splice(0, library().length, ...msg.before.lib);
            await saveTags();
            return { ok: true };
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
          case "restore-stash": {
            return { ok: true, restored: msg.ids.length, viaHelper: 0, standins: 0 };
          }
          case "delete-stash": {
            const s = findStash(msg.id);
            const at = new Date().toISOString();
            const taken = takeTabs(msg.id, msg.ids);
            const trashed = msg.trash === false ? [] : taken.map(t => {
              const e = { id: `tr${++nextId}`, at, kind: "tab", url: t.url, title: t.title, stash: { id: s.id, name: s.name || s.created_at, created_at: s.created_at }, tab: {} };
              stored().trash.unshift(e);
              return e.id;
            });
            return { ok: true, removed: taken.length, trashed };
          }
          case "trash-list": return { ok: true, entries: structuredClone(stored().trash), days: 30 };
          case "trash-delete": {
            const gone = new Set(msg.all ? stored().trash.map(e => e.id) : msg.ids);
            const before = stored().trash.length;
            stored().trash = stored().trash.filter(e => !gone.has(e.id));
            return { ok: true, removed: before - stored().trash.length };
          }
          case "trash-restore": {
            const back = stored().trash.filter(e => msg.ids.includes(e.id));
            for (const e of back) {
              if (e.kind === "item") { stored().items.push(e.item); continue; }
              let s = findStash(e.stash.id);
              if (!s) { s = { ...e.stash, id: `s${++nextId}`, tabs: [] }; stored().sessions.unshift(s); }
              s.tabs.push({ id: `bm${++nextId}`, url: e.url, title: e.title });
            }
            stored().trash = stored().trash.filter(e => !msg.ids.includes(e.id));
            return { ok: true, restored: back.length, where: [...new Set(back.map(e => (e.kind === "item" ? "no stash" : e.stash.name)))] };
          }
          case "move-stashed": {
            const to = findStash(msg.to);
            if (!to) return { ok: false, error: "that stash is gone" };
            for (const id of msg.ids) {
              const from = stored().sessions.find(s => s.tabs.some(t => t.id === id));
              if (!from) continue;
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
            const at = new Date().toISOString();
            const trashed = msg.trash === false ? [] : removed.map(i => {
              const e = { id: `tr${++nextId}`, at, kind: "item", url: i.url, title: i.title, item: i };
              stored().trash.unshift(e);
              return e.id;
            });
            return { ok: true, removed: drop.size, items: removed, trashed };
          }
          case "restore-items": {
            const have = new Set(stored().items.map(i => keyOf(i.url)));
            const back = (msg.items || []).filter(i => !have.has(keyOf(i.url)));
            stored().items.push(...back);
            return { ok: true, restored: back.length };
          }
          // A capture of a page: a short made-up record, kept like the background keeps one.
          case "capture-url": {
            const record = { url: msg.url, title: `Captured ${msg.url}`, text: "Text read off the page.", links: [], captured_at: new Date().toISOString() };
            stored().captures = [...stored().captures.filter(c => keyOf(c.url) !== keyOf(msg.url)), record];
            return { ok: true, record };
          }
          case "stash-counts":
            return { ok: true, counts: { auto: 6, window: 6, left: 2, right: 3, others: 5, "all-windows": 9 } };
          case "stash-settings":
            return { settings: { afterStash: "show", exclude: ["mail.google.com", "calendar.google.com"] } };
          case "get-folder": return { folder: "link-keeper", fallback: "link-keeper" };
          case "bridge-status": return { ok: true, state: "on", error: null, folder: "~/backups/link-keeper",
            lastBackup: { ok: true, at: new Date().toISOString(), file: "~/backups/link-keeper/latest.json" } };
          case "list-backups": return { ok: true, backups: [
            { name: "latest.json", bytes: 812000, modified: new Date().toISOString() },
            { name: "backup-2026-10-06.json", bytes: 798000, modified: "2026-10-06T09:12:00" }] };
          case "backup-now": return { ok: true, file: "~/backups/link-keeper/latest.json" };
          case "fetch-pending": return { ok: false, quiet: true };
          // ?queue=running|paused|done shows the capture queue's line in that state; Capture starts one.
          case "capture-queue-status": return { ok: true, ...mockQueue };
          case "capture-queue-start":
            Object.assign(mockQueue, { status: "running", total: mockQueue.total + msg.urls.length, active: msg.urls.slice(0, 2) });
            return { ok: true, added: msg.urls.length, ...mockQueue };
          case "capture-queue-speed": mockQueue.speed = msg.speed; return { ok: true, ...mockQueue };
          case "capture-queue-pause": mockQueue.status = "paused"; mockQueue.active = []; return { ok: true, ...mockQueue };
          case "capture-queue-resume": mockQueue.status = "running"; return { ok: true, ...mockQueue };
          case "capture-queue-stop": mockQueue.status = "stopped"; mockQueue.active = []; return { ok: true, ...mockQueue };
          case "capture-queue-retry": mockQueue.failed = []; mockQueue.status = "running"; return { ok: true, ...mockQueue };
          case "capture-queue-dismiss": Object.assign(mockQueue, idleQueue()); return { ok: true, ...mockQueue };
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
    windows: { update: async () => {} },
    tabs: {
      // What the pages open is kept on window.openedTabs, for the tests to read.
      update: async () => {}, create: async props => { (window.openedTabs ||= []).push(props.url); },
      getCurrent: async () => ({ id: 1, index: 0, windowId: 1 }),
      // The popup's active tab: ?tab=new for a page held nowhere, ?tab=about for a browser page,
      // ?tab=<url> for that one; otherwise a link held in two stashes. No other extension page is open.
      query: async q => {
        if (q?.url) return [];
        const want = params.get("tab");
        if (want === "new") return [{ id: 1, url: "https://new.example/an-article", title: "An article not saved yet" }];
        if (want === "about") return [{ id: 1, url: "about:preferences", title: "Settings" }];
        if (want) return [{ id: 1, url: want, title: want }];
        const { links } = await window.browser.runtime.sendMessage({ type: "links" });
        const two = links.find(l => l.copies.length > 1) || links[0];
        return [{ id: 1, url: two.url, title: two.title || two.url }];
      },
    },
  };
})();
