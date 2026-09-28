#!/usr/bin/env node
// DESC: Run background.js's tab stash against a fake browser and prove no tab is lost.
//
// Loads extension/background.js into a VM with a fake WebExtension API holding one window of
// synthetic tabs — web pages, container tabs, file: and extension pages, pinned tabs, duplicates —
// then stashes, restores, moves and deletes, and checks after every step that each tab is either
// still open or recorded in a stash. No real browser is involved.
//
// Usage: node tools/test-stash.mjs [--tabs N]      (default 349)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}
const N = Number(process.argv[process.argv.indexOf("--tabs") + 1]) || 349;
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function makeBrowser(tabs, { failWrites = false } = {}) {
  const store = {};
  let nextId = 10_000;
  const listeners = () => ({ addListener() {}, removeListener() {} });
  const closed = [];
  const browser = {
    storage: {
      local: {
        get: async key => ({ [key]: structuredClone(store[key]) }),
        set: async obj => {
          if (failWrites && "sessions" in obj) return; // a write that silently does not land
          Object.assign(store, structuredClone(obj));
        },
      },
      onChanged: listeners(),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
    menus: { removeAll: async () => {}, create() {}, onClicked: listeners() },
    commands: { onCommand: listeners() },
    notifications: { create: async () => {} },
    downloads: { onCreated: listeners(), onChanged: listeners() },
    runtime: {
      getURL: p => `moz-extension://fake-uuid/${p}`,
      onInstalled: listeners(), onStartup: listeners(), onMessage: listeners(),
    },
    tabs: {
      onUpdated: listeners(),
      query: async q => tabs.filter(t => q.windowId == null || t.windowId === q.windowId).map(t => ({ ...t })),
      update: async (id, props) => {
        for (const t of tabs) if (props.active) t.active = t.id === id;
      },
      create: async props => {
        if (props.discarded && props.active) throw new Error("a discarded tab cannot be active");
        if (props.cookieStoreId === "firefox-container-gone") throw new Error("no such container");
        const tab = { id: nextId++, windowId: props.windowId ?? 1, url: props.url, title: props.title,
          cookieStoreId: props.cookieStoreId || "firefox-default", discarded: !!props.discarded, pinned: false };
        tabs.push(tab);
        return tab;
      },
      remove: async ids => {
        for (const id of [].concat(ids)) {
          const i = tabs.findIndex(t => t.id === id);
          assert.ok(i >= 0, `removed a tab that does not exist: ${id}`);
          closed.push(...tabs.splice(i, 1));
        }
      },
    },
  };
  return { browser, store, closed };
}

/* One window shaped like a real heavy session: mostly web pages, some in a container, file: and
 * extension pages that cannot be reopened, pinned tabs, and a few duplicates. */
function makeTabs(n) {
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
      id: i + 1, windowId: 1, url, title: kind === "web" ? `Title ${i}` : url,
      pinned: i < 2, highlighted: i === 5, active: i === 5,
      cookieStoreId: i % 49 === 10 ? "firefox-container-7" : "firefox-default",
    });
  }
  return tabs;
}

async function load(browser) {
  const ctx = vm.createContext({ browser, console, crypto, structuredClone, setTimeout, clearTimeout, URL, fetch });
  vm.runInContext(source, ctx);
  return ctx;
}

const urlsOf = list => new Set(list.map(t => t.url));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

await check(`whole window of ${N}: every closed tab is recorded, the rest stay open`, async () => {
  const tabs = makeTabs(N);
  const before = tabs.map(t => ({ ...t }));
  const { browser, store, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true, res.error);

  const recorded = urlsOf(store.sessions[0].tabs);
  for (const t of closed) assert.ok(recorded.has(t.url), `closed but not recorded: ${t.url}`);
  const open = urlsOf(tabs);
  for (const t of before) assert.ok(open.has(t.url) || recorded.has(t.url), `lost: ${t.url}`);

  for (const t of tabs.filter(t => !t.url.startsWith("moz-extension://fake-uuid/"))) {
    assert.ok(t.pinned || !/^https?:/.test(t.url), `left open but stashable: ${t.url}`);
  }
  assert.equal(tabs.filter(t => t.url.endsWith("sessions.html")).length, 1, "exactly one sessions page");
  assert.equal(res.closed, closed.length);
  assert.ok(res.stashed < res.closed, "duplicates recorded once");
  const cont = store.sessions[0].tabs.filter(t => t.container);
  assert.equal(cont.length, before.filter(t => t.cookieStoreId !== "firefox-default" && /^https?:/.test(t.url) && !t.pinned).length);
  console.log(`     ${res.closed} closed, ${res.stashed} recorded, ${res.left} left open, ${cont.length} in a container`);
});

await check("a stash whose write does not land closes nothing", async () => {
  const tabs = makeTabs(N);
  const { browser, closed } = makeBrowser(tabs, { failWrites: true });
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, false);
  assert.equal(closed.length, 0);
  assert.equal(tabs.length, N, "nothing opened, nothing closed");
});

await check("selected tabs only, when several are selected", async () => {
  const tabs = makeTabs(40);
  for (const i of [10, 11, 12]) tabs[i].highlighted = true;
  const { browser, closed } = makeBrowser(tabs);
  const bg = await load(browser);
  const res = await bg.stashTabs();
  assert.equal(res.ok, true);
  const want = [5, 10, 11, 12].map(i => makeTabs(40)[i]).filter(t => /^https?:/.test(t.url) && !t.pinned);
  assert.deepEqual([...urlsOf(closed)].sort(), [...urlsOf(want)].sort());
});

await check("an open sessions page is reused, not duplicated", async () => {
  const tabs = makeTabs(20);
  tabs.push({ id: 999, windowId: 1, url: "moz-extension://fake-uuid/sessions.html", pinned: false, cookieStoreId: "firefox-default" });
  const { browser } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  assert.equal(tabs.filter(t => t.url.endsWith("sessions.html")).length, 1);
});

await check("restore all reopens every tab unloaded, in its container, and keeps the stash", async () => {
  const tabs = makeTabs(N);
  const { browser, store } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  const session = store.sessions[0];
  const openBefore = tabs.length;
  const res = await bg.restoreTabs(session.id);
  assert.equal(res.restored, session.tabs.length);
  const reopened = tabs.slice(openBefore);
  assert.deepEqual([...urlsOf(reopened)].sort(), [...urlsOf(session.tabs)].sort());
  assert.ok(reopened.every(t => t.discarded));
  for (const t of session.tabs.filter(t => t.container)) {
    assert.ok(reopened.some(r => r.url === t.url && r.cookieStoreId === t.container), `container lost: ${t.url}`);
  }
  assert.equal(store.sessions[0].tabs.length, session.tabs.length, "stash kept");
  assert.ok(store.sessions[0].tabs.every(t => t.seen_at), "marked seen");
});

await check("a deleted container falls back to a plain tab rather than failing", async () => {
  const { browser, store } = makeBrowser([]);
  store.sessions = [{ id: "s", created_at: "2026-09-28T00:00:00Z",
    tabs: [{ url: "https://a.example/", container: "firefox-container-gone" }] }];
  const tabs = [];
  browser.tabs.query = async () => tabs;
  const bg = await load(browser);
  const res = await bg.restoreTabs("s");
  assert.equal(res.restored, 1);
});

await check("move to list carries title and stash date, and empties the stash", async () => {
  const tabs = makeTabs(30);
  const { browser, store } = makeBrowser(tabs);
  const bg = await load(browser);
  await bg.stashTabs();
  const session = store.sessions[0];
  const one = session.tabs[0];
  const res = await bg.moveStashToList(session.id, [one.url]);
  assert.equal(res.moved, 1);
  const item = store.items.find(i => i.url === one.url);
  assert.equal(item.title, one.title);
  assert.equal(item.saved_at, session.created_at);
  assert.equal(store.sessions[0].tabs.length, session.tabs.length - 1);
  await bg.moveStashToList(session.id);
  assert.equal(store.sessions.length, 0, "an emptied stash goes");
  assert.equal(store.items.length, session.tabs.length);
});

console.log(`\n${passed} checks passed`);
