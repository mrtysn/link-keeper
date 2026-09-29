// DESC: End-to-end stash checks in a real (headless, throwaway) Firefox, beside the real background.js.
//
// Run with: tools/run-in-headless-firefox.zsh --extension extension tools/e2e-stash.js
//
// Shares background.js's globals, so it calls stashTabs, restoreTabs and friends directly and then
// looks at real tabs and real bookmarks. The tabs point at a closed port on 127.0.0.1, so nothing
// leaves the machine.

const url = i => `http://127.0.0.1:9/page-${i}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
const yes = (v, what) => { if (!v) throw new Error(what); };

async function windowOf(urls, { pinFirst = false } = {}) {
  const w = await browser.windows.create({ url: urls });
  await wait(800);
  const tabs = await browser.tabs.query({ windowId: w.id });
  if (pinFirst) await browser.tabs.update(tabs[0].id, { pinned: true });
  return w.id;
}
const rootFolder = async () => (await browser.bookmarks.getChildren("unfiled_____")).find(n => n.title === "Link Keeper stashes");

await check("stashes kept in storage.local move into bookmarks, and the old record is set aside", async () => {
  const old = [
    { id: "a", created_at: "2026-09-28T10:00:00Z", name: "Before bookmarks", tabs: [
      { url: "https://example.com/one", title: "One", verdict: "keep" }, { url: "file:///tmp/x.pdf" }, { url: "about:preferences" }] },
    { id: "b", created_at: "2026-09-20T10:00:00Z", tabs: [{ url: "moz-extension://someone-else/page.html", seen_at: "2026-09-21T00:00:00Z" }] },
    // The shape of a real pile: 249 web pages, then 54 of mixed kinds.
    { id: "c", created_at: "2026-09-19T10:00:00Z", tabs: Array.from({ length: 249 }, (_, i) => ({ url: `https://site-${i % 40}.example/p/${i}`, title: `Page ${i}` })) },
    { id: "d", created_at: "2026-09-18T10:00:00Z", tabs: Array.from({ length: 54 }, (_, i) => ({
      url: i < 41 ? `file:///Users/someone/notes/${i}.html` : i < 50 ? `https://mixed.example/${i}` : i < 53 ? `moz-extension://other-${i}/x.html` : "about:config" })) },
  ];
  await browser.storage.local.set({ sessions: old });
  migration = null;
  const s = await getSessions();
  eq(s.map(x => x.tabs.length), [3, 1, 249, 54], "tabs per stash");
  eq(s[0].name, "Before bookmarks", "name");
  eq(s[0].tabs[0].verdict, "keep", "verdict kept");
  const root = await rootFolder();
  yes(root, "no root folder in Other Bookmarks");
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  eq(tree.children.map(f => f.children.map(b => b.url)), old.map(x => x.tabs.map(t => t.url)), "bookmarks hold every URL, file: and about: too");
  const left = await browser.storage.local.get(["sessions", "sessions_before_bookmarks"]);
  eq(left.sessions, undefined, "old key removed");
  eq(left.sessions_before_bookmarks.length, 4, "old record set aside");
});

await check("a whole window of 40 tabs becomes one folder of bookmarks, and every tab closes", async () => {
  const urls = Array.from({ length: 40 }, (_, i) => url(i));
  const win = await windowOf(urls, { pinFirst: true });
  const res = await stashTabs({ windowId: win });
  yes(res.ok, res.error);
  eq(res.stashed, 39, "stashed");
  eq(res.why, "1 pinned", "why");
  const [s] = await getSessions();
  eq(s.tabs.map(t => t.url), urls.slice(1), "every unpinned tab, in order");
  const left = await browser.tabs.query({ windowId: win });
  eq(left.map(t => t.url).sort(), [url(0), browser.runtime.getURL("sessions.html")].sort(), "pinned tab and the Stashed tabs page stay");
  await browser.windows.remove(win);
});

await check("only this tab, tabs to the left, tabs to the right", async () => {
  const urls = Array.from({ length: 7 }, (_, i) => url(100 + i));
  const win = await windowOf(urls);
  const tabs = await browser.tabs.query({ windowId: win });
  eq((await stashTabs({ windowId: win, scope: "tab", tabId: tabs[3].id })).stashed, 1, "this tab");
  eq((await getSessions())[0].tabs.map(t => t.url), [url(103)], "the right one");
  eq((await stashTabs({ windowId: win, scope: "right", tabId: tabs[4].id })).stashed, 2, "right");
  eq((await getSessions())[0].tabs.map(t => t.url), [url(105), url(106)], "right of it");
  eq((await stashTabs({ windowId: win, scope: "left", tabId: tabs[2].id })).stashed, 2, "left");
  const open = (await browser.tabs.query({ windowId: win })).map(t => t.url);
  eq(open.filter(u => u.startsWith("http")), [url(102), url(104)], "the rest stay open");
  await browser.windows.remove(win);
});

await check("restore opens every tab unloaded and keeps the stash marked", async () => {
  const [s] = await getSessions();
  const before = (await browser.tabs.query({})).length;
  const res = await restoreTabs(s.id);
  yes(res.ok, res.error);
  const after = await browser.tabs.query({});
  eq(after.length - before, s.tabs.length, "one tab per bookmark");
  const back = after.filter(t => s.tabs.some(x => x.url === t.url));
  yes(back.every(t => t.discarded), "restored tabs are unloaded");
  yes((await getSessions())[0].tabs.every(t => t.seen_at), "marked restored");
  await browser.tabs.remove(back.map(t => t.id));
});

await check("drag and drop reorders real bookmarks; a locked stash refuses to give any up", async () => {
  const res = await importStashes([
    { name: "A", tabs: ["1", "2", "3"].map(n => ({ url: `https://${n}.example/` })) },
    { name: "B", tabs: [{ url: "https://9.example/" }] },
  ]);
  yes(res.ok, res.error);
  let [a, b] = await getSessions();
  eq([a.name, b.name], ["A", "B"], "imported in order, on top");
  await moveStashed([a.tabs[0].id], a.id, a.tabs[2].id);
  [a] = await getSessions();
  eq(a.tabs.map(t => t.url[8]), ["2", "1", "3"], "moved ahead of the target");
  await moveStashed([a.tabs[2].id], b.id, b.tabs[0].id);
  [a, b] = await getSessions();
  eq(b.tabs.map(t => t.url[8]), ["3", "9"], "into another stash");
  await editMeta(m => { m.stashes[a.id] = { ...m.stashes[a.id], locked: true }; });
  eq((await dropFromStash(a.id)).length, 0, "locked: nothing dropped");
  eq((await moveStashed([a.tabs[0].id], b.id)).ok, false, "locked: nothing dragged out");
  eq((await getSessions())[0].tabs.length, 2, "still two");
});

await check("every folder is in Firefox's own bookmarks, where the library and Sync see it", async () => {
  const root = await rootFolder();
  const found = await browser.bookmarks.search({ url: url(5) });
  yes(found.some(b => b.parentId && b.parentId !== root.id), "a stashed URL is findable in bookmarks");
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  const total = tree.children.reduce((n, f) => n + (f.children || []).length, 0);
  const listed = (await getSessions()).reduce((n, s) => n + s.tabs.length, 0);
  eq(listed, total, "the page lists exactly what the bookmarks hold");
  report("     ", `${tree.children.length} stash folders, ${total} bookmarks`);
});
