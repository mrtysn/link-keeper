/* The slice of the WebExtension API that popup.js and list.js call, answered from window.MOCK.
 * Query flags pick the state to render; preview.zsh --help lists them. */
(() => {
  const M = window.MOCK;
  const params = new URLSearchParams(location.search);

  const store = {
    popupUi: params.has("msg")
      ? {
        note: "",
        urls: params.has("add") ? "https://example.com/a\nhttps://example.com/b" : "",
        open: [params.has("add"), params.has("house")],
        msg: M.msg,
        msgClass: "ok",
      }
      : undefined,
  };

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
  if (params.has("view")) try { localStorage.setItem("stashView", params.get("view")); } catch (e) { /* no storage */ }
  for (const panel of ["settings", "import"]) {
    if (params.has(panel)) addEventListener("load", () => setTimeout(() => document.getElementById(panel)?.click(), 200));
  }

  window.browser = {
    runtime: {
      getURL: p => `${location.origin}/${p}`,
      sendMessage: async msg => {
        switch (msg.type) {
          case "status": {
            const status = structuredClone(M.status);
            if (params.has("onpage")) status.current.isOpen = true;
            return status;
          }
          case "dump": {
            const dump = structuredClone(M.dump);
            for (const row of dump.loose) row.saved_at = toIso(row.saved_at);
            return dump;
          }
          case "sessions": {
            if (params.has("empty")) return { sessions: [] };
            // Three stashes cut from the mock rows: a named, starred one with a restored tab and a
            // container tab; a locked one named after its time; and an older one from another
            // month that shares a URL with the first, for the "also in" badge.
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
            const third = [{ ...tabs[0], id: `bm${++n}` }, ...tabs.slice(13)];
            return {
              sessions: [
                { id: "a", name: "Research for the jam", created_at: "2026-09-28T08:40:00Z", starred: true, locked: false, tabs: first },
                { id: "b", name: whenOf("2026-09-21T19:05:00Z"), created_at: "2026-09-21T19:05:00Z", starred: false, locked: true, tabs: second },
                { id: "c", name: whenOf("2026-08-30T11:20:00Z"), created_at: "2026-08-30T11:20:00Z", starred: false, locked: false, tabs: third },
              ],
            };
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
          case "stash-settings":
            return { settings: { afterStash: "show", afterRestore: "keep", exclude: ["mail.google.com", "calendar.google.com"] } };
          case "stash-known": {
            // What the background joins from captures and the list, keyed by stashed URL.
            const known = {};
            for (const r of M.dump.items) {
              known[r.url] = {
                key: r.url, list: r.status,
                cap: r.cap && { title: r.cap.title, handle: r.cap.handle, text: r.cap.text,
                  images: r.cap.images || [], links: r.cap.links || [], captured_at: "2026-09-20T10:00:00Z" },
              };
            }
            return { known };
          }
          case "get-folder": return { folder: "link-keeper", fallback: "link-keeper" };
          case "fetch-pending": return { ok: false, quiet: true };
          default: return { ok: true, remaining: 0, added: 0, total: M.status.total };
        }
      },
    },
    storage: {
      local: { get: async key => ({ [key]: store[key] }), set: async () => {} },
      onChanged: { addListener() {} },
    },
    bookmarks: Object.fromEntries(["onCreated", "onRemoved", "onChanged", "onMoved"].map(k => [k, {
      addListener(fn) { (bookmarkListeners[k] ||= new Set()).add(fn); },
      removeListener(fn) { bookmarkListeners[k]?.delete(fn); },
    }])),
    permissions: { request: async () => true, contains: async () => true },
    tabs: { update: async () => {} },
  };
})();
