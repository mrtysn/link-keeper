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
