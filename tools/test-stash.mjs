#!/usr/bin/env node
// DESC: Run background.js's tab stash against a fake browser and prove no tab is lost.
//
// Loads extension/background.js into a VM with a fake WebExtension API — windows of synthetic tabs
// (web pages, container tabs, file: and extension pages, pinned tabs, duplicates) and an in-memory
// bookmark tree — then stashes, restores, moves, locks, imports and migrates, and checks after
// each step that every tab is either still open or recorded in a stash. No real browser is
// involved; tools/run-in-headless-firefox.zsh runs tools/e2e-stash.js for that.
//
// Usage: node tools/test-stash.mjs [--tabs N]      (default 349)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}
const N = Number(process.argv[process.argv.indexOf("--tabs") + 1]) || 349;
// Firefox loads links.js ahead of background.js into one scope; so does this.
const source = ["links.js", "background.js"].map(f => readFileSync(new URL(`../extension/${f}`, import.meta.url), "utf8")).join("\n");

/* Firefox's bookmark API over a map: index is the final position on move, a non-empty folder
 * cannot be removed without removeTree, and everything handed out is a copy. `fail` makes
 * bookmark creates misbehave: "silent" drops them without an error, "throw" fails the fifth one. */
function makeBookmarks({ fail = null } = {}) {
  const nodes = new Map();
  let seq = 0, clock = Date.parse("2026-09-29T10:00:00Z"), creates = 0;
  const add = (node, parentId, index) => {
    nodes.set(node.id, node);
    if (parentId) {
      const kids = nodes.get(parentId).children;
      kids.splice(index == null ? kids.length : Math.min(index, kids.length), 0, node.id);
    }
  };
  add({ id: "root________", title: "", children: [] });
  for (const id of ["menu________", "toolbar_____", "unfiled_____", "mobile______"]) add({ id, parentId: "root________", title: id, children: [] }, "root________");
  const need = id => {
    const n = nodes.get(id);
    if (!n) throw new Error(`Bookmark not found: ${id}`);
    return n;
  };
  const view = n => {
    const parent = n.parentId && nodes.get(n.parentId);
    const out = { id: n.id, parentId: n.parentId, title: n.title, dateAdded: n.dateAdded, index: parent ? parent.children.indexOf(n.id) : 0,
      type: n.url ? "bookmark" : "folder" };
    if (n.url) out.url = n.url;
    return out;
  };
  const tree = n => ({ ...view(n), ...(!n.url && { children: n.children.map(id => tree(nodes.get(id))) }) });
  const detach = n => { const kids = nodes.get(n.parentId).children; kids.splice(kids.indexOf(n.id), 1); };
  const drop = n => { if (!n.url) for (const id of [...n.children]) drop(nodes.get(id)); nodes.delete(n.id); };
  const api = {
    get: async id => [view(need(id))],
    getChildren: async id => need(id).children.map(k => view(nodes.get(k))),
    getSubTree: async id => [tree(need(id))],
    create: async ({ parentId = "unfiled_____", title = "", url, index }) => {
      const parent = need(parentId);
      if (parent.url) throw new Error("parent is not a folder");
      // Firefox keeps the parsed form of a URL, not the text it was given.
      if (url) { try { url = new URL(url).href; } catch { /* kept as given */ } }
      const node = { id: `bm${++seq}`, parentId, title, dateAdded: clock += 1000, ...(url ? { url } : { children: [] }) };
      if (url) {
        creates++;
        if (fail === "silent") return view({ ...node, parentId: null });
        if (fail === "throw" && creates === 5) throw new Error("database is locked");
      }
      add(node, parentId, index);
      return view(node);
    },
    update: async (id, { title, url }) => {
      const n = need(id);
      if (title != null) n.title = title;
      if (url != null) n.url = url;
      return view(n);
    },
    move: async (id, { parentId, index }) => {
      const n = need(id);
      detach(n);
      n.parentId = parentId ?? n.parentId;
      const kids = need(n.parentId).children;
      kids.splice(index == null ? kids.length : Math.min(index, kids.length), 0, id);
      return view(n);
    },
    remove: async id => {
      const n = need(id);
      if (!n.url && n.children.length) throw new Error("Cannot remove a non-empty folder");
      detach(n);
      drop(n);
    },
    removeTree: async id => { const n = need(id); detach(n); drop(n); },
  };
  return { api, nodes };
}

function makeBrowser(tabs, { helper = "installed", bookmarks: bmOpts = {} } = {}) {
  const store = {};
  let nextId = 10_000;
  const listeners = () => ({ addListener() {}, removeListener() {} });
  const closed = [];
  const nativeCalls = [];
  const bm = makeBookmarks(bmOpts);
  const reindex = () => {
    for (const w of new Set(tabs.map(t => t.windowId))) tabs.filter(t => t.windowId === w).forEach((t, i) => { t.index = i; });
  };
  reindex();
  const browser = {
    storage: {
      local: {
        get: async key => ({ [key]: structuredClone(store[key]) }),
        set: async obj => { Object.assign(store, structuredClone(obj)); },
        remove: async keys => { for (const k of [].concat(keys)) delete store[k]; },
      },
      onChanged: listeners(),
    },
    bookmarks: bm.api,
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
    menus: { removeAll: async () => {}, create() {}, onClicked: listeners(), onShown: listeners(), update: async () => {}, refresh: async () => {} },
    commands: { onCommand: listeners() },
    notifications: { create: async () => {} },
    downloads: { onCreated: listeners(), onChanged: listeners() },
    runtime: {
      getURL: p => `moz-extension://fake-uuid/${p}`,
      // The helper opens every existing file; files named "gone" no longer exist.
      sendNativeMessage: async (name, msg) => {
        nativeCalls.push({ name, msg });
        if (helper === "missing") throw new Error("No such native application");
        const opened = msg.open.filter(u => !u.includes("gone"));
        for (const url of opened) tabs.push({ id: nextId++, windowId: 1, url, cookieStoreId: "firefox-default", pinned: false });
        return { ok: true, opened, failed: msg.open.filter(u => u.includes("gone")).map(url => ({ url, error: "file no longer exists" })) };
      },
      onInstalled: listeners(), onStartup: listeners(),
      onMessage: { addListener(fn) { browser.handle = fn; } },
    },
    windows: {
      focused: null,
      getLastFocused: async () => ({ id: 1 }),
      getAll: async () => [...new Set(tabs.map(t => t.windowId))].map(id => ({ id, tabs: tabs.filter(t => t.windowId === id).map(t => ({ ...t })) })),
      update: async (id, props) => { if (props.focused) browser.windows.focused = id; },
    },
    tabs: {
      onUpdated: listeners(),
      // The current window is window 1.
      query: async q => {
        const w = q.currentWindow ? 1 : q.windowId;
        return tabs.filter(t => w == null || t.windowId === w).map(t => ({ ...t }));
      },
      update: async (id, props) => {
        const tab = tabs.find(t => t.id === id);
        if (tab && props.url) tab.url = props.url;
        for (const t of tabs) if (props.active && t.windowId === tab?.windowId) t.active = t.id === id;
      },
      create: async props => {
        if (props.discarded && props.active) throw new Error("a discarded tab cannot be active");
        // What Firefox refuses an extension: local files, privileged pages, other extensions' pages.
        if (props.url && /^(file|about|chrome|data):/.test(props.url) && props.url !== "about:blank") throw new Error(`Illegal URL: ${props.url}`);
        if (props.url?.startsWith("moz-extension://") && !props.url.startsWith("moz-extension://fake-uuid/")) throw new Error(`Illegal URL: ${props.url}`);
        if (props.cookieStoreId === "firefox-container-gone") throw new Error("no such container");
        const tab = { id: nextId++, windowId: props.windowId ?? 1, url: props.url ?? "about:newtab", title: props.title,
          cookieStoreId: props.cookieStoreId || "firefox-default", discarded: !!props.discarded, pinned: false };
        tabs.push(tab);
        reindex();
        return tab;
      },
      remove: async ids => {
        for (const id of [].concat(ids)) {
          const i = tabs.findIndex(t => t.id === id);
          assert.ok(i >= 0, `removed a tab that does not exist: ${id}`);
          closed.push(...tabs.splice(i, 1));
        }
        reindex();
      },
    },
  };
  return { browser, store, closed, nativeCalls, bm };
}

/* One window shaped like a real heavy session: mostly web pages, some in a container, file: and
 * extension pages that cannot be reopened, pinned tabs, and a few duplicates. */
function makeTabs(n, windowId = 1, idBase = 0) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 7 === 0 ? "file" : i % 43 === 0 ? "ext" : i === 1 ? "about" : "web";
    const url = {
      file: `file:///Users/someone/doc-${i}.pdf`,
      ext: `moz-extension://other/page-${i}.html`,
      about: "about:preferences",
      web: i % 50 === 3 ? "https://example.com/dup" : `https://site-${i % 30}.example/post/${i}`,
    }[kind];
    tabs.push({
      id: idBase + i + 1, windowId, url, title: kind === "web" ? `Title ${i}` : url,
      pinned: i < 2, highlighted: i === 5, active: i === 5,
      cookieStoreId: i % 49 === 10 ? "firefox-container-7" : "firefox-default",
    });
  }
  return tabs;
}

async function load(browser) {
  const ctx = vm.createContext({ browser, console, crypto, structuredClone, setTimeout, clearTimeout, URL, URLSearchParams, fetch, btoa });
  vm.runInContext(source, ctx);
  return ctx;
}

// Results come from the VM's realm; compare by value.
const plain = v => JSON.parse(JSON.stringify(v));
const stashes = async bg => plain(await bg.getSessions());
const urlsOf = list => new Set(list.map(t => t.url));
// The List page grouped by stash is where stashing shows the stashes.
const isPage = t => t.url.startsWith("moz-extension://fake-uuid/list.html");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

await check(`whole window of ${N}: every closed tab is a bookmark, the rest stay open`, async () => {
  const tabs = makeTabs(N);
  const before = tabs.map(t => ({ ...t }));
  const { browser, closed, bm } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true, res.error);

  const [s] = await stashes(bg);
  const recorded = urlsOf(s.tabs);
  for (const t of closed) assert.ok(recorded.has(t.url), `closed but not recorded: ${t.url}`);
  const open = urlsOf(tabs);
  for (const t of before) assert.ok(open.has(t.url) || recorded.has(t.url), `lost: ${t.url}`);
  // The record is the bookmarks themselves, in tab order.
  const folder = bm.nodes.get(s.id);
  assert.equal(bm.nodes.get(folder.parentId).title, "Link Keeper stashes");
  assert.equal(bm.nodes.get(folder.parentId).parentId, "unfiled_____");
  assert.deepEqual(folder.children.map(id => bm.nodes.get(id).url), s.tabs.map(t => t.url));
  assert.deepEqual(s.tabs.map(t => t.url), [...new Set(before.filter(t => !t.pinned).map(t => t.url))], "tab order kept");

  for (const t of tabs.filter(t => !isPage(t))) assert.ok(t.pinned, `left open but not pinned: ${t.url}`);
  assert.equal(tabs.filter(isPage).length, 1, "exactly one List page");
  assert.equal(tabs.find(isPage).url, "moz-extension://fake-uuid/list.html?group=stash");
  assert.equal(res.closed, closed.length);
  assert.ok(res.stashed < res.closed, "duplicates recorded once");
  const cont = s.tabs.filter(t => t.container);
  assert.equal(cont.length, before.filter(t => t.cookieStoreId !== "firefox-default" && !t.pinned).length);
  console.log(`     ${res.closed} closed, ${res.stashed} recorded, ${res.left} left open, ${cont.length} in a container`);
});

await check("bookmarks that silently do not land close nothing", async () => {
  const tabs = makeTabs(N);
  const { browser, closed } = makeBrowser(tabs, { bookmarks: { fail: "silent" } });
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, false);
  assert.match(res.error, /no tab was closed/);
  assert.equal(closed.length, 0);
  assert.equal(tabs.length, N, "nothing opened, nothing closed");
  assert.deepEqual(await stashes(bg), [], "the half-written stash is taken back out");
});

await check("a bookmark write that fails halfway closes nothing and leaves no half stash", async () => {
  const tabs = makeTabs(40);
  const { browser, closed } = makeBrowser(tabs, { bookmarks: { fail: "throw" } });
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, false);
  assert.equal(closed.length, 0);
  assert.deepEqual(await stashes(bg), []);
});

await check("a selection of only local files and extension pages is stashed too", async () => {
  const tabs = makeTabs(60).map(t => ({ ...t, url: t.id % 5 ? `file:///r/${t.id}.html` : `moz-extension://other/${t.id}.html`, highlighted: true, pinned: false }));
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true, res.error);
  assert.equal(closed.length, 60);
  assert.equal((await stashes(bg))[0].tabs.length, 60);
});

await check("a window of only pinned and empty tabs says why nothing closed", async () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.example/", pinned: true, highlighted: true, cookieStoreId: "firefox-default" },
    { id: 2, windowId: 1, url: "about:newtab", pinned: false, highlighted: false, cookieStoreId: "firefox-default" },
  ];
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, false);
  assert.equal(closed.length, 0);
  assert.match(res.error, /this window holds only 1 pinned, 1 empty tab/);
});

await check("selected tabs only, when several are selected", async () => {
  const tabs = makeTabs(40);
  for (const i of [10, 11, 12]) tabs[i].highlighted = true;
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true);
  const want = [5, 10, 11, 12].map(i => makeTabs(40)[i]).filter(t => !t.pinned);
  assert.deepEqual([...urlsOf(closed)].sort(), [...urlsOf(want)].sort());
});

await check("scopes: only this tab (pinned too), left, right, all except this one", async () => {
  const run = async (scope, tabId) => {
    const tabs = makeTabs(12);
    const { browser, closed } = makeBrowser(tabs);
    const bg = await load(browser);
    const res = await bg.stashTabs({ windowId: 1, scope, tabId });
    assert.equal(res.ok, true, `${scope}: ${res.error}`);
    return closed.map(t => t.id);
  };
  assert.deepEqual(await run("tab", 8), [8]);
  assert.deepEqual(await run("tab", 1), [1], "a pinned tab stashed by name goes");
  assert.deepEqual(await run("left", 6), [3, 4, 5], "left of tab 6, without the pinned 1 and 2");
  assert.deepEqual(await run("right", 9), [10, 11, 12]);
  assert.deepEqual(await run("others", 4), [3, 5, 6, 7, 8, 9, 10, 11, 12]);
  const tabs = makeTabs(12);
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs({ windowId: 1, scope: "left", tabId: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /the tabs to the left holds only 2 pinned/);
});

await check("every window: one stash per window, one List page", async () => {
  const tabs = [...makeTabs(20, 1), ...makeTabs(15, 2, 100), ...makeTabs(9, 3, 200)];
  const before = tabs.map(t => ({ ...t }));
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs({ scope: "all-windows" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stashes, 3);
  const all = await stashes(bg);
  assert.equal(all.length, 3);
  const recorded = urlsOf(all.flatMap(s => s.tabs));
  for (const t of closed) assert.ok(recorded.has(t.url));
  for (const t of before) assert.ok(urlsOf(tabs).has(t.url) || recorded.has(t.url), `lost: ${t.url}`);
  assert.equal(tabs.filter(isPage).length, 1);
});

await check("never-stash sites stay open, say so, and can be taken off the list", async () => {
  const tabs = makeTabs(40);
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  assert.equal((await browser.handle({ type: "toggle-excluded", host: "www.site-4.example" })).excluded, true);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true);
  assert.ok(!closed.some(t => t.url.includes("site-4.example")), "an excluded site closed");
  assert.ok(tabs.some(t => t.url.includes("site-4.example")));
  assert.match(res.why, /\d+ never-stash sites?/);
  assert.equal((await browser.handle({ type: "toggle-excluded", host: "site-4.example" })).excluded, false);
  assert.deepEqual(plain((await browser.handle({ type: "stash-settings" })).settings.exclude), []);
});

await check("an open List page is reused, switched to its stash grouping, and never stashed itself", async () => {
  const tabs = makeTabs(20);
  tabs.push({ id: 999, windowId: 1, url: "moz-extension://fake-uuid/list.html", pinned: false, cookieStoreId: "firefox-default" });
  tabs.push({ id: 997, windowId: 1, url: "moz-extension://fake-uuid/cards.html", pinned: false, cookieStoreId: "firefox-default" });
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  assert.deepEqual(tabs.filter(isPage).map(t => [t.id, t.url]), [[999, "moz-extension://fake-uuid/list.html?group=stash"]]);
  assert.ok(tabs.some(t => t.id === 997), "the Cards page stays open");
  assert.ok(!closed.some(t => t.url.includes("fake-uuid")), "no Link Keeper page was stashed");
});

await check("an old Stashed tabs page pinned in another window is the one shown, as the List page", async () => {
  const tabs = makeTabs(20);
  tabs.push({ id: 998, windowId: 2, url: "moz-extension://fake-uuid/sessions.html", pinned: true, cookieStoreId: "firefox-default" });
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs({ windowId: 1 });
  assert.equal(res.ok, true);
  await browser.handle({ type: "open-sessions" });
  const pages = tabs.filter(isPage);
  assert.deepEqual(pages.map(t => t.id), [998], "no second List page");
  assert.equal(pages[0].active, true);
  assert.equal(browser.windows.focused, 2);
});

await check("with no List page open, the popup's Stashed button opens exactly one", async () => {
  const tabs = makeTabs(5);
  const { browser } = makeBrowser(tabs);
  await load(browser);
  await browser.handle({ type: "open-sessions" });
  await browser.handle({ type: "open-sessions" });
  assert.equal(tabs.filter(isPage).length, 1);
});

await check("after stashing, 'stay' opens a new tab where a window would close, and no List page", async () => {
  const tabs = makeTabs(10).map(t => ({ ...t, pinned: false }));
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  await browser.handle({ type: "set-stash-settings", afterStash: "stay" });
  const res = await bg.stashTabs();
  assert.equal(res.ok, true);
  assert.equal(closed.length, 10);
  assert.equal(tabs.filter(isPage).length, 0);
  assert.deepEqual(tabs.map(t => t.url), ["about:newtab"], "the window keeps one new tab");
});

await check("restore all brings every tab back — web unloaded in its container, files via the helper, the rest as stand-ins", async () => {
  const tabs = makeTabs(N);
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  const [session] = await stashes(bg);
  const openBefore = tabs.length;
  const res = await bg.restoreTabs(session.id);
  assert.equal(res.restored, session.tabs.length);
  const reopened = tabs.slice(openBefore);
  assert.equal(reopened.length, session.tabs.length, "one tab back per stashed tab");
  const standin = u => { const q = new URL(u).searchParams; return u.includes("/standin.html?") ? q.get("url") : null; };
  const back = new Set(reopened.map(t => standin(t.url) || t.url));
  for (const t of session.tabs) assert.ok(back.has(t.url), `not restored: ${t.url}`);
  const files = session.tabs.filter(t => t.url.startsWith("file:"));
  assert.equal(res.viaHelper, files.length);
  assert.ok(reopened.filter(t => t.url.startsWith("file:")).length === files.length, "files opened for real");
  assert.equal(res.standins, session.tabs.filter(t => /^(moz-extension:\/\/other|about:)/.test(t.url)).length);
  assert.ok(reopened.filter(t => /^https?:/.test(t.url)).every(t => t.discarded), "web pages come back unloaded");
  for (const t of session.tabs.filter(t => t.container)) {
    assert.ok(reopened.some(r => r.url === t.url && r.cookieStoreId === t.container), `container lost: ${t.url}`);
  }
  const [after] = await stashes(bg);
  assert.equal(after.tabs.length, session.tabs.length, "stash kept");
  assert.ok(after.tabs.every(t => t.seen_at), "marked seen");
});

await check("with 'remove after restore', restored tabs leave the stash — unless it is locked", async () => {
  const tabs = makeTabs(20);
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  await browser.handle({ type: "set-stash-settings", afterRestore: "remove" });
  let [s] = await stashes(bg);
  const res = await browser.handle({ type: "restore-stash", id: s.id, ids: [s.tabs[0].id] });
  assert.equal(res.removed, true);
  [s] = await stashes(bg);
  const n = s.tabs.length;
  await browser.handle({ type: "flag-stash", id: s.id, locked: true });
  await browser.handle({ type: "restore-stash", id: s.id });
  [s] = await stashes(bg);
  assert.equal(s.tabs.length, n, "a locked stash keeps everything");
  await browser.handle({ type: "flag-stash", id: s.id, locked: false });
  await browser.handle({ type: "restore-stash", id: s.id });
  assert.deepEqual(await stashes(bg), [], "restoring all empties and removes it");
});

await check("a deleted container falls back to a plain tab rather than failing", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "s", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://a.example/", container: "firefox-container-gone" }] }];
  const bg = await load(browser);
  const [s] = await stashes(bg);
  const res = await bg.restoreTabs(s.id);
  assert.equal(res.restored, 1);
});

await check("without the helper, local files come back as stand-ins that say why", async () => {
  const tabs = makeTabs(60);
  const { browser } = makeBrowser(tabs, { helper: "missing" });
  const bg = await load(browser);
  await bg.stashTabs();
  const [session] = await stashes(bg);
  const openBefore = tabs.length;
  const res = await bg.restoreTabs(session.id);
  assert.match(res.helperError, /not installed/);
  const reopened = tabs.slice(openBefore);
  assert.equal(reopened.length, session.tabs.length);
  const fileStandins = reopened.filter(t => t.url.includes("/standin.html?") && new URL(t.url).searchParams.get("url").startsWith("file:"));
  assert.equal(fileStandins.length, session.tabs.filter(t => t.url.startsWith("file:")).length);
  assert.ok(fileStandins.every(t => /not installed/.test(new URL(t.url).searchParams.get("why"))));
});

await check("a file that no longer exists comes back as a stand-in, the others through the helper", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "s", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "file:///r/a.html", title: "A" }, { url: "file:///r/gone.html", title: "Gone" }] }];
  const bg = await load(browser);
  const [s] = await stashes(bg);
  const res = await bg.restoreTabs(s.id);
  assert.equal(res.viaHelper, 1);
  assert.equal(res.standins, 1);
});

await check("move to list carries title and stash date, and empties the stash", async () => {
  const tabs = makeTabs(30);
  const { browser, store } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  const [session] = await stashes(bg);
  const one = session.tabs.find(t => t.url.startsWith("https:"));
  const res = await bg.moveStashToList(session.id, [one.id]);
  assert.equal(res.moved, 1);
  const item = store.items.find(i => i.url === one.url);
  assert.equal(item.title, one.title);
  assert.equal(item.saved_at, session.created_at);
  assert.equal((await stashes(bg))[0].tabs.length, session.tabs.length - 1);
  const rest = await bg.moveStashToList(session.id);
  const web = session.tabs.filter(t => /^https?:/.test(t.url));
  assert.equal(store.items.length, web.length, "only web pages go to the list");
  assert.equal(rest.stayed, session.tabs.length - web.length);
  assert.ok((await stashes(bg))[0].tabs.every(t => !/^https?:/.test(t.url)), "local and browser pages stay in the stash");
});

await check("a verdict is a flag: set, cleared by null, and only Clear dropped removes a tab", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://1.example/" }, { url: "file:///r/2.html" }] },
    { id: "b", created_at: "2026-09-27T00:00:00Z", tabs: [{ url: "https://3.example/" }] },
  ];
  const bg = await load(browser);
  const [a, b] = await stashes(bg);
  const judge = (s, i, verdict) => browser.handle({ type: "judge-link", url: s.tabs[i].url, verdict });
  assert.equal((await judge(a, 0, "drop")).ok, true);
  assert.equal((await judge(a, 1, "keep")).ok, true);
  assert.equal((await judge(b, 0, "drop")).ok, true);
  let all = await stashes(bg);
  assert.equal(all[0].tabs[0].verdict, "drop");
  assert.equal(all.flatMap(s => s.tabs).length, 3, "a drop deletes nothing");

  await judge(b, 0, null);
  assert.equal((await stashes(bg))[1].tabs[0].verdict, undefined, "null clears");

  const res = await browser.handle({ type: "clear-dropped" });
  assert.equal(res.removed, 1);
  all = await stashes(bg);
  assert.deepEqual(all.flatMap(s => s.tabs.map(t => t.url)), ["file:///r/2.html", "https://3.example/"]);

  await browser.handle({ type: "judge-link", url: all[0].tabs[0].url, verdict: "drop" });
  await browser.handle({ type: "clear-dropped", id: a.id });
  assert.deepEqual((await stashes(bg)).map(s => s.id), [b.id], "a stash emptied by clearing goes");
  assert.equal((await browser.handle({ type: "judge-link", url: "https://nowhere.example/", verdict: "keep" })).ok, false);
});

await check("a locked stash gives up nothing: no delete, remove, move to list, clear or drag out", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://1.example/", verdict: "drop" }, { url: "https://2.example/" }] },
    { id: "b", created_at: "2026-09-27T00:00:00Z", tabs: [{ url: "https://3.example/" }] },
  ];
  const bg = await load(browser);
  const [a, b] = await stashes(bg);
  await browser.handle({ type: "flag-stash", id: a.id, locked: true });
  assert.equal((await browser.handle({ type: "delete-stash", id: a.id })).ok, false);
  assert.equal((await browser.handle({ type: "delete-stash", id: a.id, ids: [a.tabs[1].id] })).ok, false);
  assert.equal((await browser.handle({ type: "move-stash", id: a.id })).ok, false);
  assert.equal((await browser.handle({ type: "clear-dropped" })).removed, 0);
  assert.equal((await browser.handle({ type: "move-stashed", ids: [a.tabs[0].id], to: b.id })).ok, false);
  const [after] = await stashes(bg);
  assert.equal(after.tabs.length, 2);
  assert.equal(after.locked, true);
  // Moving into a locked stash is fine.
  assert.equal((await browser.handle({ type: "move-stashed", ids: [b.tabs[0].id], to: a.id })).ok, true);
  assert.equal((await stashes(bg))[0].tabs.length, 3);
});

await check("starred stashes come first; rename to nothing brings back the date", async () => {
  const { browser, store, bm } = makeBrowser([]);
  store.sessions = ["a", "b", "c"].map((id, i) => ({ id, created_at: `2026-09-2${8 - i}T00:00:00Z`, tabs: [{ url: `https://${id}.example/` }] }));
  const bg = await load(browser);
  const [a, b, c] = await stashes(bg);
  await browser.handle({ type: "flag-stash", id: c.id, starred: true });
  assert.deepEqual((await stashes(bg)).map(s => s.id), [c.id, a.id, b.id]);
  await browser.handle({ type: "rename-stash", id: a.id, name: "  Research  " });
  assert.equal(bm.nodes.get(a.id).title, "Research", "the name is the folder's title");
  await browser.handle({ type: "rename-stash", id: a.id, name: "" });
  assert.equal(bm.nodes.get(a.id).title, a.name, "back to the stash time");
});

await check("drag and drop moves tabs within and across stashes, in order; an emptied stash goes", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: ["1", "2", "3", "4"].map(n => ({ url: `https://${n}.example/` })) },
    { id: "b", created_at: "2026-09-27T00:00:00Z", tabs: [{ url: "https://9.example/" }] },
  ];
  const bg = await load(browser);
  let [a, b] = await stashes(bg);
  const order = s => s.tabs.map(t => new URL(t.url).hostname[0]).join("");
  await browser.handle({ type: "move-stashed", ids: [a.tabs[0].id], to: a.id, before: a.tabs[3].id });
  [a] = await stashes(bg);
  assert.equal(order(a), "2314", "down within a stash, ahead of the target");
  await browser.handle({ type: "move-stashed", ids: [a.tabs[2].id], to: a.id, before: a.tabs[0].id });
  [a] = await stashes(bg);
  assert.equal(order(a), "1234", "up within a stash");
  await browser.handle({ type: "move-stashed", ids: [a.tabs[1].id, a.tabs[2].id], to: b.id });
  [a, b] = await stashes(bg);
  assert.equal(order(a), "14");
  assert.equal(order(b), "923", "several, in order, to the end of another stash");
  await browser.handle({ type: "move-stashed", ids: a.tabs.map(t => t.id), to: b.id, before: b.tabs[0].id });
  const all = await stashes(bg);
  assert.equal(all.length, 1, "the emptied stash goes");
  assert.equal(order(all[0]), "14923");
});

await check("import writes stashes in the order given, with dates, names and verdicts, and drops junk", async () => {
  const tabs = makeTabs(5);
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs({ windowId: 1, scope: "tab", tabId: 3 });
  const res = await browser.handle({ type: "import-stashes", stashes: [
    { name: "From OneTab", created_at: "2020-01-02T03:04:05Z", tabs: [{ url: "https://a.example/", title: "A" }, { url: "https://a.example/" }, { url: "not a url" }, { url: 7 }] },
    { tabs: [{ url: "file:///r/x.pdf", verdict: "keep" }] },
    { name: "empty", tabs: [{ url: "junk" }] },
  ] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stashes, 2);
  assert.equal(res.tabs, 2);
  const all = await stashes(bg);
  assert.deepEqual(all.map(s => s.tabs.length), [1, 1, 1]);
  assert.equal(all[0].name, "From OneTab");
  assert.equal(all[0].created_at, "2020-01-02T03:04:05.000Z");
  assert.equal(all[0].tabs[0].title, "A");
  assert.equal(all[1].tabs[0].verdict, "keep");
  assert.equal((await browser.handle({ type: "import-stashes", stashes: [{ tabs: [] }] })).ok, false);
});

await check("import takes URLs as OneTab writes them — raw unicode, spaces, uppercase hosts — as Firefox stores them", async () => {
  const { browser } = makeBrowser([]);
  const bg = await load(browser);
  const res = await browser.handle({ type: "import-stashes", stashes: [{ tabs: [
    { url: "https://jysk.com.tr/depolama/antre-ünitesi" }, { url: "https://Example.COM" }, { url: "https://example.com/" },
    { url: "https://example.com/a b" }, { url: " https://bücher.de/x " }] }] });
  assert.equal(res.ok, true, res.error);
  const [s] = await stashes(bg);
  assert.deepEqual(s.tabs.map(t => t.url), ["https://jysk.com.tr/depolama/antre-%C3%BCnitesi", "https://example.com/",
    "https://example.com/a%20b", "https://xn--bcher-kva.de/x"], "stored as Firefox stores them, the same page once");
});

await check("an import that fails partway takes back every stash it wrote", async () => {
  const { browser } = makeBrowser([], { bookmarks: { fail: "throw" } });
  const bg = await load(browser);
  const res = await browser.handle({ type: "import-stashes", stashes: [
    { tabs: [{ url: "https://1.example/" }, { url: "https://2.example/" }] },
    { tabs: [1, 2, 3, 4].map(n => ({ url: `https://${n}.other.example/` })) }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /nothing was imported/);
  assert.deepEqual(await stashes(bg), []);
});

await check("stashes from storage.local move into bookmarks once, with every mark, and the old record is kept aside", async () => {
  const { browser, store } = makeBrowser([]);
  const old = [
    { id: "new", created_at: "2026-09-28T10:00:00Z", name: "Named", tabs: [
      { url: "https://1.example/", title: "One", container: "firefox-container-3", verdict: "keep", judged_at: "2026-09-28T11:00:00Z" },
      { url: "file:///r/2.pdf", seen_at: "2026-09-28T12:00:00Z" }] },
    { id: "old", created_at: "2026-09-20T10:00:00Z", tabs: [{ url: "about:preferences" }] },
    { id: "empty", created_at: "2026-09-19T10:00:00Z", tabs: [] },
  ];
  store.sessions = structuredClone(old);
  const bg = await load(browser);
  const all = await stashes(bg);
  assert.deepEqual(all.map(s => s.created_at), ["2026-09-28T10:00:00Z", "2026-09-20T10:00:00Z"], "dates kept as they were");
  assert.equal(all[0].name, "Named");
  assert.deepEqual(all[0].tabs.map(t => [t.url, t.title, t.container, t.verdict, t.seen_at]), [
    ["https://1.example/", "One", "firefox-container-3", "keep", undefined],
    ["file:///r/2.pdf", undefined, undefined, undefined, "2026-09-28T12:00:00Z"]]);
  assert.equal(store.sessions, undefined, "the old key is gone");
  assert.deepEqual(store.sessions_before_bookmarks, old, "and kept aside whole");
  await stashes(bg);
  assert.equal((await stashes(bg)).length, 2, "runs once");
});

await check("a migration cut short is cleaned up and redone; one that fails to read back leaves the old record", async () => {
  const { browser, store, bm } = makeBrowser([]);
  store.sessions = [{ id: "x", created_at: "2026-09-28T10:00:00Z", tabs: [{ url: "https://1.example/" }, { url: "https://2.example/" }] }];
  // A previous run got as far as a folder with one bookmark.
  const root = await browser.bookmarks.create({ parentId: "unfiled_____", title: "Link Keeper stashes" });
  const partial = await browser.bookmarks.create({ parentId: root.id, title: "half" });
  await browser.bookmarks.create({ parentId: partial.id, url: "https://1.example/" });
  store.stashMigrating = [partial.id];
  const bg = await load(browser);
  const all = await stashes(bg);
  assert.equal(all.length, 1);
  assert.equal(all[0].tabs.length, 2);
  assert.ok(!bm.nodes.has(partial.id), "the half folder is gone");

  const tabs = makeTabs(8);
  const failing = makeBrowser(tabs, { bookmarks: { fail: "silent" } });
  failing.store.sessions = [{ id: "x", created_at: "2026-09-28T10:00:00Z", tabs: [{ url: "https://1.example/" }] }];
  const bg2 = await load(failing.browser);
  await assert.rejects(bg2.getSessions(), /did not read back/);
  assert.equal(failing.store.sessions.length, 1, "old record untouched");
  await assert.rejects(bg2.stashTabs({ windowId: 1 }), /did not read back/);
  assert.equal(failing.closed.length, 0, "no stash, and so no closing, while the migration fails");
});

await check("after a reinstall the stashes are found by folder name; bookmarks edited in Firefox show as they are", async () => {
  const tabs = makeTabs(12);
  const { browser, store, bm } = makeBrowser(tabs);
  let bg = await load(browser);
  await bg.stashTabs();
  const [s] = await stashes(bg);
  // A reinstall: the extension's storage is gone, the bookmarks are not.
  for (const k of Object.keys(store)) delete store[k];
  bg = await load(browser);
  const [again] = await stashes(bg);
  assert.deepEqual(again.tabs.map(t => t.url), s.tabs.map(t => t.url));
  assert.equal(again.tabs.filter(t => t.container).length, 0, "containers were in the lost storage");
  await browser.bookmarks.remove(again.tabs[0].id);
  await browser.bookmarks.update(again.id, { title: "Renamed in the library" });
  const [edited] = await stashes(bg);
  assert.equal(edited.tabs.length, s.tabs.length - 1);
  assert.equal(edited.name, "Renamed in the library");
  assert.equal([...bm.nodes.values()].filter(n => n.title === "Link Keeper stashes").length, 1, "no second root");
});

await check("frame headers are removed only for frames opened from the extension's pages", async () => {
  // Whether Firefox then shows the frame is tools/preview-frames/test-preview-frames.zsh's to check.
  const { browser } = makeBrowser([]);
  let rules = null;
  browser.declarativeNetRequest = { updateSessionRules: async u => { rules = u; } };
  await load(browser);
  await new Promise(r => setTimeout(r, 0));
  const [rule] = plain(rules.addRules);
  assert.deepEqual(plain(rules.removeRuleIds), [rule.id], "registering again replaces it");
  assert.deepEqual(rule.condition, { resourceTypes: ["sub_frame"], initiatorDomains: ["fake-uuid"] });
  assert.deepEqual(rule.action.responseHeaders.map(h => [h.header, h.operation]),
    [["x-frame-options", "remove"], ["content-security-policy", "remove"]]);
});

await check("links: one row per URL across stashes and the reading list, captures joined by visited or canonical URL", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://x.com/i/status/123" }, { url: "https://t.example/short" }, { url: "file:///r/a.html" }] },
    { id: "b", created_at: "2026-09-20T00:00:00Z", tabs: [{ url: "https://x.com/i/status/123", title: "Older copy" }] },
  ];
  store.captures = [
    { url: "https://x.com/someone/status/123", text: "hello", author: { handle: "@someone" } },
    { url: "https://long.example/article", source_url: "https://t.example/short", title: "Article" },
  ];
  store.items = [{ url: "https://x.com/someone/status/123", status: "seen", added_at: "2026-09-01T00:00:00Z" }, { url: "https://only.example/", status: "pending" }];
  await load(browser);
  const { links, stashes: st } = plain(await browser.handle({ type: "links" }));
  const x = links.find(l => l.key === "status:123");
  assert.equal(links.filter(l => l.key === "status:123").length, 1, "one row, not three");
  assert.deepEqual(x.sources.sort(), ["list", "tabs"]);
  assert.equal(x.copies.length, 2);
  assert.equal(x.cap.text, "hello");
  assert.equal(x.list.status, "seen");
  assert.equal(x.date, "2026-09-01T00:00:00Z", "the list's date wins over the stash's");
  assert.equal(links.find(l => l.url === "https://t.example/short").cap.title, "Article");
  assert.equal(links.find(l => l.url === "file:///r/a.html").cap, null);
  const only = links.find(l => l.url === "https://only.example/");
  assert.deepEqual([only.sources, only.seen, only.verdict], [["list"], false, null]);
  assert.deepEqual(st.map(s => [s.source, s.tabs.length]), [["tabs", 3], ["tabs", 1]]);
  assert.equal(st[0].tabs[0].key, "status:123");
});

await check("a verdict reaches every copy: capture, reading-list entry and each stash; null clears them all", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://x.com/i/status/9" }] },
    { id: "b", created_at: "2026-09-27T00:00:00Z", tabs: [{ url: "https://x.com/i/status/9" }, { url: "https://other.example/" }] },
  ];
  store.captures = [{ url: "https://x.com/me/status/9", text: "t" }];
  store.items = [{ url: "https://x.com/me/status/9", status: "pending" }];
  const bg = await load(browser);
  const res = await browser.handle({ type: "judge-link", url: "https://x.com/i/status/9", verdict: "drop" });
  assert.deepEqual([res.ok, res.captures, res.list, res.stashed], [true, 1, 1, 2]);
  assert.equal(store.captures[0].verdict, "drop");
  assert.equal(store.items[0].status, "skipped");
  const all = await stashes(bg);
  assert.deepEqual(all.flatMap(s => s.tabs.map(t => t.verdict || null)), ["drop", "drop", null]);
  let x = plain(await browser.handle({ type: "links" })).links.find(l => l.key === "status:9");
  assert.equal(x.verdict, "drop");

  await browser.handle({ type: "judge-link", url: "https://x.com/me/status/9", verdict: null });
  assert.equal(store.captures[0].verdict, undefined);
  assert.equal(store.items[0].status, "seen", "a cleared list entry is opened, undecided");
  assert.ok((await stashes(bg)).flatMap(s => s.tabs).every(t => !t.verdict));
  x = plain(await browser.handle({ type: "links" })).links.find(l => l.key === "status:9");
  assert.deepEqual([x.verdict, x.seen], [null, true]);
  assert.equal((await browser.handle({ type: "judge-link", url: "https://x.com/me/status/9", verdict: "maybe" })).ok, false);
});

await check("imports are marked as imports with their format; a stash's source can be changed by hand", async () => {
  const { browser } = makeBrowser([]);
  const bg = await load(browser);
  const res = await browser.handle({ type: "import-stashes", format: "onetab", stashes: [{ tabs: [{ url: "https://i.example/" }] }] });
  assert.equal(res.ok, true, res.error);
  const tabs = makeTabs(6).map(t => ({ ...t, pinned: false }));
  const b2 = makeBrowser(tabs);
  let [imp] = await stashes(bg);
  assert.deepEqual([imp.source, imp.format], ["import", "onetab"]);
  assert.equal((await browser.handle({ type: "set-stash-source", id: imp.id, source: "tabs" })).ok, true);
  [imp] = await stashes(bg);
  assert.deepEqual([imp.source, imp.format], ["tabs", undefined]);
  await browser.handle({ type: "set-stash-source", id: imp.id, source: "import" });
  assert.equal((await stashes(bg))[0].source, "import");
  const bg2 = await load(b2.browser);
  await bg2.stashTabs();
  assert.equal((await stashes(bg2))[0].source, "tabs", "a stash of open tabs is from tabs");
  assert.equal((await browser.handle({ type: "set-stash-source", id: "gone", source: "import" })).ok, false);
});

await check("tags: set by hand per URL, guesses from the site until then, one tag on a whole stash", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [
    { url: "https://github.com/me/repo" }, { url: "https://x.com/i/status/5" }, { url: "https://plain.example/" }] }];
  store.items = [{ url: "https://x.com/someone/status/5", status: "pending" }];
  await load(browser);
  const links = async () => plain(await browser.handle({ type: "links" })).links;
  let l = await links();
  const by = u => l.find(x => x.url.startsWith(u));
  assert.deepEqual([by("https://github.com").guessed, by("https://x.com").guessed, by("https://plain").guessed], [["code"], ["post"], []]);

  await browser.handle({ type: "set-tags", url: "https://x.com/i/status/5", tags: ["Game Jam", " game  jam ", "ideas"] });
  l = await links();
  assert.deepEqual(by("https://x.com").tags, ["game jam", "ideas"], "cleaned, and one per URL across the stash and the list");
  assert.deepEqual(by("https://x.com").guessed, [], "a hand tag replaces the guess");

  const { sessions: [st] } = plain(await browser.handle({ type: "sessions" }));
  const res = await browser.handle({ type: "tag-stash", id: st.id, tags: ["jam research"] });
  assert.equal(res.tagged, 3);
  l = await links();
  assert.deepEqual(by("https://github.com").tags, ["code", "jam research"], "a guess becomes its own tag when the stash is tagged");
  assert.deepEqual(by("https://x.com").tags, ["game jam", "ideas", "jam research"]);
  assert.deepEqual(by("https://plain").tags, ["jam research"]);

  await browser.handle({ type: "rename-tag", from: "game jam", to: "ideas" });
  l = await links();
  assert.deepEqual(by("https://x.com").tags, ["ideas", "jam research"], "renaming onto an existing tag merges");
  await browser.handle({ type: "delete-tag", tag: "jam research" });
  l = await links();
  assert.deepEqual([by("https://plain").tags, by("https://plain").guessed], [[], []], "deleted everywhere");
  await browser.handle({ type: "set-tags", url: "https://github.com/me/repo", tags: [] });
  l = await links();
  assert.deepEqual(by("https://github.com").guessed, ["code"], "clearing brings the guess back");
});

await check("tag library: presets first, every tag in use joins it, made, recoloured, merged and deleted", async () => {
  const { browser, store } = makeBrowser([]);
  store.items = [{ url: "https://a.example/", status: "pending" }];
  const ctx = await load(browser);
  const keyOf = url => vm.runInContext(`keyOf(${JSON.stringify(url)})`, ctx);
  store.linkTags = { [keyOf("https://a.example/")]: ["old one"] };
  const lib = () => store.tagDefs.list.map(d => d.name);
  await browser.handle({ type: "set-tags", url: "https://a.example/", tags: ["old one", "Fresh"] });
  assert.deepEqual(lib().slice(0, 3), ["to-read", "to-watch", "to-try"], "the presets come first");
  assert.equal(lib().length, 18, "then the tags in use: the one there before, and the new one");
  assert.deepEqual(lib().slice(16), ["old one", "fresh"]);

  assert.equal((await browser.handle({ type: "create-tag", name: " Big  Idea ", hue: 140 })).tag, "big idea");
  assert.equal((await browser.handle({ type: "create-tag", name: "big idea" })).ok, false, "a name in use is refused");
  assert.deepEqual(store.tagDefs.list.at(-1), { name: "big idea", hue: 140 });
  await browser.handle({ type: "recolor-tag", tag: "big idea", hue: null });
  assert.equal(store.tagDefs.list.at(-1).hue, null, "a colour can go back to the name's own");

  await browser.handle({ type: "rename-tag", from: "fresh", to: "new name" });
  assert.ok(lib().includes("new name") && !lib().includes("fresh"), "a rename renames it in the library, in place");
  await browser.handle({ type: "rename-tag", from: "old one", to: "to-read" });
  assert.ok(!lib().includes("old one"), "merging into a tag drops the merged one");
  assert.deepEqual(store.linkTags[keyOf("https://a.example/")], ["to-read", "new name"]);
  await browser.handle({ type: "delete-tag", tag: "to-read" });
  assert.ok(!lib().includes("to-read"), "a deleted preset leaves the library");
  await browser.handle({ type: "set-tags", url: "https://a.example/", tags: ["new name"] });
  assert.ok(!lib().includes("to-read"), "and the presets are not written back");
});

await check("capturing a link is not keeping it: the queue moves on, every check mark clears, old data is put right", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://s.example/1" }] }];
  store.items = [{ url: "https://q.example/1", status: "pending" }];
  await load(browser);
  const links = async () => plain(await browser.handle({ type: "links" })).links;
  const by = (l, u) => l.find(x => x.url === u);
  await browser.handle({ type: "import-captures", records: [{ url: "https://q.example/1", text: "x" }, { url: "https://s.example/1", text: "y" }] });
  let l = await links();
  assert.equal(by(l, "https://q.example/1").list.status, "seen", "a captured list entry leaves the queue as opened");
  assert.equal(by(l, "https://q.example/1").verdict, null, "and is not kept");
  assert.equal(by(l, "https://s.example/1").verdict, null, "a captured stashed link is not kept either");
  await browser.handle({ type: "judge-link", url: "https://s.example/1", verdict: "keep" });
  assert.equal(by(await links(), "https://s.example/1").verdict, "keep");
  await browser.handle({ type: "judge-link", url: "https://s.example/1", verdict: null });
  assert.equal(by(await links(), "https://s.example/1").verdict, null, "and a keep on it clears");

  // Before 5.32: kept by capturing alone goes back; a pressed keep, or a keep with no capture, stays.
  const old = makeBrowser([]);
  old.store.items = [{ url: "https://a.example/", status: "kept", kept_at: "2026-09-01T00:00:00Z" },
    { url: "https://b.example/", status: "kept" }, { url: "https://c.example/", status: "kept" }];
  old.store.captures = [{ url: "https://a.example/", text: "x" }, { url: "https://b.example/", text: "y", verdict: "keep" }];
  const bg = await load(old.browser);
  await bg.applyDataPatches();
  assert.deepEqual(old.store.items.map(i => i.status), ["seen", "kept", "kept"]);
  assert.equal(old.store.dataPatches["2026-10-07-capture-is-not-keep"].reset, 1);
});

await check("site icons: saved from tabs as they are stashed, as data when readable, else as their address", async () => {
  const tabs = makeTabs(4);
  tabs[2].favIconUrl = "data:image/png;base64,AAAA";
  tabs[3].favIconUrl = "https://cdn.example/icon.png";
  const [withData, withHttps] = [tabs[2], tabs[3]];
  const { browser, store } = makeBrowser(tabs);
  const bg = await load(browser);
  // No network in a test: one icon reads, the next is refused as an unpermitted site's would be.
  let calls = 0;
  bg.fetch = async () => { if (calls++) throw new TypeError("NetworkError"); return { ok: true, blob: async () => new Blob(["x"], { type: "image/png" }) }; };
  await bg.stashTabs();
  await new Promise(r => setTimeout(r, 50));
  const host = u => new URL(u).hostname;
  assert.equal(store.favicons[host(withData.url)].icon, "data:image/png;base64,AAAA", "a data: icon is kept as it is");
  assert.match(store.favicons[host(withHttps.url)].icon, /^data:image\/png;base64,/, "a readable https icon is stored as data");
  await bg.saveFavicons([{ ...withHttps, favIconUrl: "https://cdn.example/other.png" }]);
  assert.equal(store.favicons[host(withHttps.url)].icon, "https://cdn.example/other.png", "an unreadable one keeps its address");
  assert.equal(Object.keys(store.favicons).length, 2, "tabs without an icon add nothing");
});

await check("page-info: the page you are on, with each stash that holds it, or nothing", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [
    { id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://p.example/1" }, { url: "https://other.example/" }] },
    { id: "b", created_at: "2026-09-29T00:00:00Z", tabs: [{ url: "https://p.example/1" }] },
  ];
  store.items = [{ url: "https://p.example/1", status: "pending" }];
  await load(browser);
  const info = plain(await browser.handle({ type: "page-info", url: "https://p.example/1" }));
  assert.deepEqual(info.link.copies.length, 2);
  assert.deepEqual(info.stashes.map(s => s.tabs.length).sort(), [1, 2], "each holding stash, whole");
  assert.deepEqual(!!info.link.list, true, "and its reading-list entry");
  assert.deepEqual(plain(await browser.handle({ type: "page-info", url: "https://nowhere.example/" })), { link: null, stashes: [] });
});

await check("tags travel in exports and come back with imports", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://t.example/1" }] }];
  store.captures = [{ url: "https://c.example/", text: "x" }];
  await load(browser);
  await browser.handle({ type: "set-tags", url: "https://t.example/1", tags: ["keep me"] });
  await browser.handle({ type: "set-tags", url: "https://c.example/", tags: ["read"] });
  const { sessions } = plain(await browser.handle({ type: "sessions" }));
  assert.deepEqual(sessions[0].tabs[0].tags, ["keep me"]);
  const { captures } = plain(await browser.handle({ type: "export" }));
  assert.deepEqual(captures[0].tags, ["read"]);

  const fresh = makeBrowser([]);
  await load(fresh.browser);
  await fresh.browser.handle({ type: "import-stashes", stashes: [{ tabs: [{ url: "https://t.example/1", tags: ["keep me"] }] }], format: "link-keeper" });
  await fresh.browser.handle({ type: "import-captures", records: captures });
  assert.deepEqual(plain(fresh.store.linkTags), { "t.example/1": ["keep me"], "c.example": ["read"] });
});

await check("the popup's view buttons switch to an open viewer instead of opening another, and count per source", async () => {
  const tabs = makeTabs(3);
  const { browser, store } = makeBrowser(tabs);
  store.sessions = [{ id: "a", created_at: "2026-09-28T00:00:00Z", tabs: [{ url: "https://s.example/1", verdict: "keep" }, { url: "https://s.example/2" }] }];
  store.items = [{ url: "https://s.example/2", status: "pending" }, { url: "https://l.example/", status: "pending" }];
  const ctx = await load(browser);
  store.linkTags = { [vm.runInContext('keyOf("https://s.example/1")', ctx)]: ["read later"] };
  for (const type of ["open-cards", "open-cards", "open-explore", "open-list", "open-list"]) await browser.handle({ type });
  const pages = p => tabs.filter(t => t.url.startsWith(`moz-extension://fake-uuid/${p}`)).length;
  assert.deepEqual([pages("cards.html"), pages("stash-cards.html"), pages("list.html")], [1, 1, 1], "one tab per viewer");
  let c = plain(await browser.handle({ type: "link-counts" }));
  assert.deepEqual([c.total, c.untagged, c.sources, c.stashes], [3, 2, { tabs: 2, import: 0, list: 2 }, 1]);
  store.viewSources = ["list"];
  c = plain(await browser.handle({ type: "link-counts" }));
  assert.deepEqual([c.total, c.untagged], [2, 2], "counts follow the chosen sources");
});

/* Stash folders as the 29 Sep import left them: written within ten seconds, in these sizes, plus
 * a stash of open tabs from the day before and one from the day after. */
async function sep29(browser, bm, bg, sizes = [80, 87, 40, 23, 296, 7, 2, 12]) {
  await bg.getSessions();
  const root = (await browser.bookmarks.getChildren("unfiled_____")).find(n => n.title === "Link Keeper stashes").id;
  const folder = async (at, n, title) => {
    const f = await browser.bookmarks.create({ parentId: root, index: 0, title });
    bm.nodes.get(f.id).dateAdded = Date.parse(at);
    for (let i = 0; i < n; i++) await browser.bookmarks.create({ parentId: f.id, url: `https://${title.replace(/\W/g, "")}.example/${i}` });
    return f.id;
  };
  const before = await folder("2026-09-29T10:13:43Z", 3, "Sep 28 tabs");
  const ids = [];
  for (const [i, n] of sizes.entries()) ids.push(await folder(new Date(Date.parse("2026-09-29T11:01:51Z") + i * 1200).toISOString(), n, `import ${i}`));
  const after = await folder("2026-09-30T09:30:58Z", 2, "Sep 30 tabs");
  return { ids, others: [before, after] };
}

await check("data patch: the 29 Sep OneTab import is marked once on launch, and only those 8 stashes", async () => {
  const { browser, store, bm } = makeBrowser([]);
  const bg = await load(browser);
  const { ids, others } = await sep29(browser, bm, bg);
  await bg.applyDataPatches();
  const all = await stashes(bg);
  const src = id => all.find(x => x.id === id);
  assert.deepEqual(ids.map(id => [src(id).source, src(id).format]), ids.map(() => ["import", "onetab"]));
  assert.deepEqual(others.map(id => src(id).source), ["tabs", "tabs"], "stashes of open tabs are left alone");
  assert.equal(store.dataPatches["2026-09-29-mark-onetab-import"].marked, 8);

  // Once recorded it never runs again: a stash marked back by hand stays as you set it, across launches.
  await browser.handle({ type: "set-stash-source", id: ids[0], source: "tabs" });
  const again = await load(browser);
  await again.applyDataPatches();
  assert.equal((await stashes(again)).find(x => x.id === ids[0]).source, "tabs");
});

await check("data patch: a fingerprint that does not match changes nothing and says why; a failure is retried", async () => {
  const { browser, store, bm } = makeBrowser([]);
  const bg = await load(browser);
  const { ids } = await sep29(browser, bm, bg, [80, 87, 40, 23, 296, 7, 2]);   // one of the eight deleted
  await bg.applyDataPatches();
  assert.ok((await stashes(bg)).every(x => x.source === "tabs"), "nothing marked");
  assert.match(store.dataPatches["2026-09-29-mark-onetab-import"].skipped, /7 folders in the window/);

  const fresh = makeBrowser([]);
  const bg2 = await load(fresh.browser);
  await sep29(fresh.browser, fresh.bm, bg2);
  const real = fresh.browser.bookmarks.getSubTree;
  fresh.browser.bookmarks.getSubTree = async () => { throw new Error("places is busy"); };
  await assert.rejects(bg2.applyDataPatches(), /places is busy/);
  assert.equal(fresh.store.dataPatches, undefined, "a patch that failed is not recorded");
  fresh.browser.bookmarks.getSubTree = real;
  await bg2.applyDataPatches();
  assert.equal(fresh.store.dataPatches["2026-09-29-mark-onetab-import"].marked, 8, "and the next launch applies it");
});

console.log(`\n${passed} checks passed`);
