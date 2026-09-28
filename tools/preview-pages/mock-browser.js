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

  window.browser = {
    runtime: {
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
            // Two stashes cut from the mock rows: a named one with a restored tab and a container
            // tab, and a larger unnamed one where some tabs have no title.
            const tabs = M.dump.items.map((r, i) => ({
              url: r.url,
              title: i % 4 === 3 ? undefined : (r.cap?.title || r.cap?.text?.slice(0, 120) || undefined),
            }));
            const first = tabs.slice(0, 5).map((t, i) => ({
              ...t, ...(i === 1 && { seen_at: "2026-09-28T09:12:00Z" }), ...(i === 2 && { container: "firefox-container-7" }),
            }));
            return {
              sessions: [
                { id: "a", name: "Research for the jam", created_at: "2026-09-28T08:40:00Z", tabs: first },
                { id: "b", created_at: "2026-09-21T19:05:00Z", tabs: tabs.slice(5) },
              ],
            };
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
    permissions: { request: async () => true },
    tabs: { update: async () => {} },
  };
})();
