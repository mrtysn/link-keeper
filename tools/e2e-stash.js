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

// Polls until fn() returns something truthy, and returns it; throws with `what` after `ms`.
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

// A window's new tabs report about:blank, with status "complete", until Firefox gets round to
// them, in batches; a stash taken before then leaves those tabs open as empty. So this returns
// only once every tab reports the URL it was opened with, in order.
async function windowOf(urls, { pinFirst = false } = {}) {
  const w = await browser.windows.create({ url: urls });
  const tabs = await until(async () => {
    const t = await browser.tabs.query({ windowId: w.id });
    return JSON.stringify(t.map(x => x.url)) === JSON.stringify(urls) && t;
  }, `the ${urls.length} tabs of a new window to take their URLs`, 60000);
  if (pinFirst) {
    await browser.tabs.update(tabs[0].id, { pinned: true });
    await until(async () => (await browser.tabs.get(tabs[0].id)).pinned, "the first tab to pin");
  }
  return w.id;
}
const rootFolder = async () => (await browser.bookmarks.getChildren("unfiled_____")).find(n => n.title === "Link Keeper stashes");

// The extension starts itself beside this script: its bridge connects to the helper and checks
// whether storage needs a restore, and its data patches run. Nothing below starts until both have
// finished, so no check races them. (The runner points the helper at empty temporary folders, so
// there is nothing to restore.)
await until(async () => bridge.state === "off" || (bridge.state === "on" && (await browser.storage.local.get("storageId")).storageId),
  "the bridge to connect and settle", 60000);
yes(!(await browser.storage.local.get("restoredFrom")).restoredFrom, "storage was restored from a backup: the run is not isolated from the owner's data");
// A failed pass is retried by the next one, as the extension does itself.
await until(() => applyDataPatches().then(() => true, () => false), "the data patches to run", 60000);

// A page's window, once it has loaded and `ready(document, window)` holds. Pages draw after storage
// answers, so each case waits on what the page draws, never on a delay. Looked up by tab, since a
// page may forward to another.
const pageOf = (tab, ready, what, ms = 20000) => until(() => {
  const view = browser.extension.getViews({ type: "tab", tabId: tab.id })[0];
  return view && view.document.readyState === "complete" && ready(view.document, view) && view;
}, `${what} to draw`, ms);
async function openPage(page, ready, what = page) {
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(page), active: true });
  const view = await pageOf(tab, ready, what);
  return { tab, view, doc: view.document };
}
const hasGroups = d => d.querySelectorAll(".group > h2").length > 0;
const hasRows = d => d.querySelectorAll("ul.rows > li").length > 0;

// Every case starts from the same ground: no stashes, reading list, tags, filter rules or settings
// left by an earlier case, and no window or tab but the ones the browser started with. A case
// that needs data makes it itself, so none passes because another ran first.
const startTabs = new Set((await browser.tabs.query({})).map(t => t.id));
const startWindows = new Set((await browser.windows.getAll()).map(w => w.id));
const SHARED_KEYS = ["items", "captures", "linkTags", "tagDefs", "stashMeta", "stashRoot", "stashSettings", "stashMigrating",
  "sessions", "sessions_before_bookmarks", "viewSources", "filterRules", "filteredAuto", "favicons", "folder", "current", "thumbs", "pendingShot"];
async function resetState() {
  for (const w of await browser.windows.getAll()) if (!startWindows.has(w.id)) await browser.windows.remove(w.id).catch(() => {});
  const stray = (await browser.tabs.query({})).filter(t => !startTabs.has(t.id)).map(t => t.id);
  if (stray.length) await browser.tabs.remove(stray).catch(() => {});
  const root = await rootFolder();
  if (root) await browser.bookmarks.removeTree(root.id).catch(() => {});
  await browser.storage.local.remove(SHARED_KEYS);
  migration = null;
  await until(async () => (await getSessions()).length === 0 && (await getItems()).length === 0, "the stashes and the list to clear", 15000);
}
const runCheck = check;
const kase = async (name, fn) => runCheck(name, async () => { await resetState(); await fn(); });

await kase("stashes kept in storage.local move into bookmarks, and the old record is set aside", async () => {
  const old = [
    { id: "a", created_at: "2026-09-28T10:00:00Z", name: "Before bookmarks", tabs: [
      { url: "https://example.com/one", title: "One", container: "firefox-container-2" }, { url: "file:///tmp/x.pdf" }, { url: "about:preferences" }] },
    { id: "b", created_at: "2026-09-20T10:00:00Z", tabs: [{ url: "moz-extension://someone-else/page.html" }] },
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
  eq(s[0].tabs[0].container, "firefox-container-2", "container kept");
  const root = await rootFolder();
  yes(root, "no root folder in Other Bookmarks");
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  eq(tree.children.map(f => f.children.map(b => b.url)), old.map(x => x.tabs.map(t => t.url)), "bookmarks hold every URL, file: and about: too");
  const left = await browser.storage.local.get(["sessions", "sessions_before_bookmarks"]);
  eq(left.sessions, undefined, "old key removed");
  eq(left.sessions_before_bookmarks.length, 4, "old record set aside");
});

await kase("a whole window of 40 tabs becomes one folder of bookmarks, and every tab closes", async () => {
  const urls = Array.from({ length: 40 }, (_, i) => url(i));
  const win = await windowOf(urls, { pinFirst: true });
  const res = await stashTabs({ windowId: win });
  yes(res.ok, res.error);
  eq(res.stashed, 39, "stashed");
  eq(res.why, "1 pinned", "why");
  const [s] = await getSessions();
  eq(s.tabs.map(t => t.url), urls.slice(1), "every unpinned tab, in order");
  const left = await browser.tabs.query({ windowId: win });
  // List takes up ?group=stash and then drops it from its address, so either form is the List page.
  eq(left.map(t => t.url.replace("?group=stash", "")).sort(), [url(0), browser.runtime.getURL("list.html")].sort(), "pinned tab and the List page stay");
  await browser.windows.remove(win);
});

await kase("only this tab, tabs to the left, tabs to the right", async () => {
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

await kase("restore opens every tab unloaded and keeps the stash marked", async () => {
  const win = await windowOf(Array.from({ length: 4 }, (_, i) => url(200 + i)));
  yes((await stashTabs({ windowId: win })).ok, "stashed to restore");
  const [s] = await getSessions();
  const before = (await browser.tabs.query({})).length;
  const res = await restoreTabs(s.id);
  yes(res.ok, res.error);
  const after = await browser.tabs.query({});
  eq(after.length - before, s.tabs.length, "one tab per bookmark");
  const back = after.filter(t => s.tabs.some(x => x.url === t.url));
  yes(back.every(t => t.discarded), "restored tabs are unloaded");
  yes((await getSessions())[0].tabs.every(t => !t.seen_at), "opening records no mark");
  await browser.tabs.remove(back.map(t => t.id));
});

await kase("drag and drop reorders real bookmarks", async () => {
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
  eq((await getSessions())[0].tabs.length, 2, "two left in the first");
});

await kase("every folder is in Firefox's own bookmarks, where the library and Sync see it", async () => {
  const win = await windowOf(Array.from({ length: 6 }, (_, i) => url(i)));
  yes((await stashTabs({ windowId: win })).ok, "stashed");
  yes((await importStashes([{ name: "Imported here", tabs: [{ url: "https://bm.example/1" }, { url: "https://bm.example/2" }] }])).ok, "imported");
  const root = await rootFolder();
  const found = await browser.bookmarks.search({ url: url(5) });
  yes(found.some(b => b.parentId && b.parentId !== root.id), "a stashed URL is findable in bookmarks");
  const [tree] = await browser.bookmarks.getSubTree(root.id);
  const total = tree.children.reduce((n, f) => n + (f.children || []).length, 0);
  const listed = (await getSessions()).reduce((n, s) => n + s.tabs.length, 0);
  eq(listed, total, "the page lists exactly what the bookmarks hold");
  report("     ", `${tree.children.length} stash folders, ${total} bookmarks`);
});

await kase("import takes OneTab's raw URLs — unicode, spaces, uppercase hosts — and reads them back", async () => {
  // What parseStashImport reads out of OneTab's text (tools/test-stash-import.mjs checks that part).
  const parsed = { stashes: [
    { tabs: [{ url: "https://jysk.com.tr/depolama/antre-ünitesi-egeby", title: "Antre ünitesi EGEBY" },
      { url: "https://Example.COM", title: "Example" },
      { url: "https://www.google.com/search?udm=2&q=EGEBY%20%20jysk#vhid=P1", title: "EGEBY jysk - Google Search" },
      { url: "https://example.com/a b", title: "Spaced" }] },
    { tabs: [{ url: "https://bücher.de/x", title: "Bücher" }] },
  ] };
  const res = await importStashes(parsed.stashes);
  yes(res.ok, res.error);
  eq(res.tabs, 5, "tabs");
  const [a, b] = await getSessions();
  eq([...a.tabs, ...b.tabs].map(t => t.url), ["https://jysk.com.tr/depolama/antre-%C3%BCnitesi-egeby", "https://example.com/",
    "https://www.google.com/search?udm=2&q=EGEBY%20%20jysk#vhid=P1", "https://example.com/a%20b", "https://xn--bcher-kva.de/x"], "as Firefox stores them");
});

await kase("the joined dataset: one link per URL across stashes and the list, imports marked", async () => {
  const res = await importStashes([{ tabs: [{ url: "https://joint.example/a", title: "A" }, { url: "https://joint.example/b" }] }], "onetab");
  yes(res.ok, res.error);
  // A reading-list entry as data from before 5.64 holds it (adds now go into groups): null skips the group.
  await addItems([{ url: "https://joint.example/a", title: "A on the list" }], "", null);
  let { links, stashes } = await getLinks();
  const a = links.filter(l => l.url.startsWith("https://joint.example/a"));
  eq(a.length, 1, "one row for a URL held in a stash and on the list");
  eq(a[0].sources.sort(), ["import", "list"], "held in both");
  eq([stashes[0].source, stashes[0].format], ["import", "onetab"], "the import is marked");
});

await kase("Links, its detail pane and Cards load in Firefox with the bar, the sources and rows from every source", async () => {
  // The case makes its own data: a long stash from open tabs, an import, and a reading-list entry.
  yes((await writeStash(Array.from({ length: 310 }, (_, i) => ({ url: `https://seed.example/${i}`, title: `Seed ${i}` })), { name: "Seed stashed" })).ok, "seed stash");
  yes((await importStashes([{ name: "Seed imported", tabs: [{ url: "https://seed.example/imported-1" }, { url: "https://seed.example/imported-2" }] }], "onetab")).ok, "seed import");
  await addItems([{ url: "https://seed.example/listed", title: "Seed listed" }]);
  const errors = [];
  const open = async (page, ready) => {
    const { tab, view } = await openPage(page, ready);
    view.addEventListener("error", e => errors.push(`${page}: ${e.message}`));
    return { tab, doc: view.document, view };
  };
  const list = await open("list.html?group=stash", (d, v) => v.location.pathname === "/list.html" && hasGroups(d));
  const d = list.doc;
  eq([...d.querySelectorAll(".app-pages a")].map(a => a.textContent), [], "one page: no viewer tabs in the bar");
  eq(d.querySelectorAll(".app-sources").length, 0, "one pile: no source chips");
  yes(d.querySelectorAll("ul.rows.stash > li").length > 300, "stash rows listed");
  yes([...d.querySelectorAll(".group > h2 .n")].some(n => /\d+ tabs?/.test(n.textContent)), "each stash heading counts its tabs");
  eq(d.getElementById("groupby").value, "stash", "grouped by stash");

  // Since 5.64 every link sits in a group: no section of links in no stash.
  yes(![...d.querySelectorAll(".group > h2")].some(h => h.textContent.startsWith("Not in a stash")), "every link is in a group: no 'Not in a stash' section");

  // Explore's old address forwards to Links with the detail pane.
  const explore = await open("stash-cards.html", (d, v) => v.location.pathname === "/list.html" && hasGroups(d) && d.querySelector("#detail .dtitle"));
  eq(explore.view.location.pathname, "/list.html", "Explore's address forwards to Links");
  yes(explore.doc.body.classList.contains("pane") && !explore.doc.getElementById("detail").hidden, "with the detail pane on");
  yes(explore.doc.querySelectorAll("ul.rows > li").length > 300, "every link is listed");
  yes(explore.doc.querySelector("#detail .dtitle"), "a link is shown in full");

  const cards = await open("cards.html", (d, v) => v.location.pathname === "/list.html" && d.querySelector(".cm-card.top"));
  yes(cards.doc.querySelector(".cm-card.top"), "the Cards address opens Links in card mode, dealing a card");
  cards.view.localStorage.setItem("listCards", "0");   // card mode is remembered; the later cases want the detail

  const sessions = await browser.tabs.create({ url: browser.runtime.getURL("sessions.html"), active: true });
  const listUrl = browser.runtime.getURL("list.html");
  await until(async () => (await browser.tabs.get(sessions.id)).url === listUrl, "the old page to forward to List (its ?group is taken up and dropped)");
  eq((await browser.tabs.get(sessions.id)).url, listUrl, "the old page forwards to List (its ?group is taken up and dropped)");
  eq(errors, [], "no script errors");
  await browser.tabs.remove([list.tab.id, explore.tab.id, cards.tab.id, sessions.id]);
});

await kase("Duplicates: every copy of a link gets a checkbox, nothing is ticked, and only the ticked copy goes", async () => {
  const res = await importStashes([
    { name: "Dup one", tabs: [{ url: "https://dup.example/x", title: "X" }, { url: "https://dup.example/only-here" }] },
    { name: "Dup two", tabs: [{ url: "https://dup.example/x", title: "X again" }] },
  ], "text");
  yes(res.ok, res.error);
  await addItems([{ url: "https://dup.example/x" }], "", null);   // an old list copy, as before 5.64
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  const { tab, view, doc: d } = await openPage("list.html?group=stash", d => hasRows(d) && +(d.querySelector("#f-dups .n")?.textContent || 0) > 0, "the Duplicates switch to count");
  yes(+d.querySelector("#f-dups .n").textContent > 0, "the Duplicates switch counts them");
  d.getElementById("f-dups").click();
  const card = await until(() => [...d.querySelectorAll(".dup-card")].find(c => c.textContent.includes("dup.example/x")), "a card for the duplicated link");
  yes(card, "a card for the duplicated link");
  const rows = [...card.querySelectorAll(".dup-row")];
  eq(rows.map(r => r.querySelector(".dup-where").textContent).sort(), ["Dup one", "Dup two", "Not in a stash"], "one row per copy");
  eq(rows[0].querySelector(".dup-where").textContent, "Not in a stash", "the newest copy comes first");
  eq(rows.map(r => r.querySelector("input").checked), [false, false, false], "nothing ticked");
  yes(d.getElementById("dups-remove").disabled, "nothing to remove yet");
  rows.find(r => r.querySelector(".dup-where").textContent === "Dup two").querySelector("input").click();
  view.confirm = () => true;
  d.getElementById("dups-remove").click();
  await until(async () => !(await getSessions()).some(s => s.name === "Dup two"), "the ticked copy to go");
  const all = await getSessions();
  eq(all.find(s => s.name === "Dup one")?.tabs.length, 2, "the unticked stash keeps its copy");
  eq(all.some(s => s.name === "Dup two"), false, "the ticked copy went, and its emptied stash with it");
  yes((await getItems()).some(i => i.url === "https://dup.example/x"), "the reading-list copy stays");
  // It is in the Trash, and Restore writes the emptied stash again with the tab in it.
  const trash = (await getTrash());
  eq(trash.map(e => e.url), ["https://dup.example/x"], "the ticked copy is in the Trash");
  const back = await restoreFromTrash(trash.map(e => e.id));
  eq(back.restored, 1, "Restore puts it back");
  const again = (await getSessions()).find(s => s.name === "Dup two");
  eq(again?.tabs.map(t => t.url), ["https://dup.example/x"], "its stash is written again with the tab");
  eq((await getTrash()).length, 0, "and the Trash is empty");
  await browser.tabs.remove(tab.id);
});

await kase("Duplicates: pages that differ only by their #fragment (Gmail messages) are not duplicates of each other", async () => {
  const res = await importStashes([
    { name: "Mail one", tabs: [{ url: "https://mail.example/u/0/#inbox/AAA", title: "Mail A" }, { url: "https://mail.example/u/0/#inbox/BBB", title: "Mail B" }] },
    { name: "Mail two", tabs: [{ url: "https://mail.example/u/0/#inbox/AAA", title: "Mail A" }, { url: "https://mail.example/u/0/#inbox/CCC", title: "Mail C" }] },
  ], "text");
  yes(res.ok, res.error);
  const { tab, doc: d } = await openPage("list.html?group=stash", d => hasRows(d) && +(d.querySelector("#f-dups .n")?.textContent || 0) > 0, "the Duplicates switch to count");
  d.getElementById("f-dups").click();
  const cards = await until(() => [...d.querySelectorAll(".dup-card")].filter(c => c.textContent.includes("mail.example")), "the cards for mail.example");
  eq(cards.length, 1, "one card, for the one address held twice");
  yes(cards[0].textContent.includes("#inbox/AAA") || cards[0].textContent.includes("Mail A"), "and it is the one held twice");
  eq(cards[0].querySelectorAll(".dup-row").length, 2, "with its two copies");
  await browser.tabs.remove(tab.id);
});

await kase("Tags: the ✎ editor on a List row saves a tag for the URL, every page shows it, and Group by Tag files it", async () => {
  const res = await importStashes([{ name: "Tag me", tabs: [{ url: "https://github.com/tagged/repo", title: "A repo" }, { url: "https://tag.example/two" }] }], "text");
  yes(res.ok, res.error);
  const rowOf = d => [...d.querySelectorAll("ul.rows.stash > li")].find(li => li.textContent.includes("A repo"));
  const { tab, view, doc: d } = await openPage("list.html?group=stash", d => rowOf(d)?.querySelector(".tag.guess"), "the row of A repo");
  const row = rowOf(d);
  yes(row, "the row is listed");
  eq(row.querySelector(".tag.guess")?.textContent, "code", "github is guessed as code, dimmed");
  row.querySelector(".tagedit").click();
  const input = await until(() => d.querySelector(".tagpop .tagger input"), "the editor to open");
  yes(input, "the editor opens");
  input.value = "Jam Tools";
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const tagsOf = async () => ((await browser.storage.local.get("linkTags")).linkTags || {})["github.com/tagged/repo"];
  await until(async () => JSON.stringify(await tagsOf()) === '["code","jam tools"]', "the tags to be saved");
  eq(await tagsOf(), ["code", "jam tools"], "the kept guess and the new tag are saved for the URL");
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !d.querySelector(".tagpop"), "Escape to close the editor");
  eq(d.querySelector(".tagpop"), null, "Escape closes the editor");

  d.getElementById("groupby").value = "tag";
  d.getElementById("groupby").dispatchEvent(new view.Event("change"));
  const headsOf = () => [...d.querySelectorAll(".group > h2 span:first-child")].map(s => s.textContent);
  await until(() => headsOf().includes("jam tools") && headsOf().includes("code"), "Group by Tag to draw a section per tag");
  const heads = headsOf();
  yes(heads.includes("jam tools") && heads.includes("code"), "Group by Tag has a section per tag");
  eq(heads[heads.length - 1], "Untagged", "untagged links come last");

  const t = await tagStash((await getSessions()).find(s => s.name === "Tag me").id, ["from stash"]);
  eq(t.tagged, 2, "Tag all tabs reaches both tabs");
  const links = (await getLinks()).links;
  eq(links.find(l => l.url === "https://tag.example/two").tags, ["from stash"], "an untagged tab gets the stash's tag");
  d.getElementById("groupby").value = "stash";
  d.getElementById("groupby").dispatchEvent(new view.Event("change"));
  await browser.tabs.remove(tab.id);
});

await kase("the popup: this page, Stash ▾ for the window, and the viewers as links", async () => {
  const { tab, doc: d } = await openPage("popup.html", d => d.getElementById("where").textContent && d.getElementById("open-links"), "the popup");
  // Opened as a tab, the popup's own page is the one it is on: one of Link Keeper's own pages.
  yes(/Link Keeper's pages are not saved/.test(d.getElementById("where").textContent) && d.getElementById("page-host").textContent === "Link Keeper's page",
    `its own page says so: ${d.getElementById("where").textContent}`);
  yes(d.getElementById("open-links") && !d.querySelector(".viewers"), "one button opens the page; no viewer buttons");
  eq([...d.querySelectorAll("#stash-menu [data-scope]")].map(b => b.dataset.scope), ["window", "left", "right", "others", "all-windows"], "the scopes sit behind the arrow");
  yes(d.getElementById("keep-shot") && d.getElementById("keep-note"), "Capture's arrow offers a screenshot and a note");
  eq(d.getElementById("next"), null, "no reading-list walker");
  const info = await pageInfo("http://127.0.0.1:9/page-0");
  eq(info.link === null || typeof info.link === "object", true, "page-info answers for any URL");
  await browser.tabs.remove(tab.id);
});

await kase("List's Import adds pasted links on their own, with their dates", async () => {
  const { tab, view, doc: d } = await openPage("list.html#import", d => d.getElementById("import-text") && d.getElementById("import-go"), "the Import form");
  d.getElementById("import-text").value = "https://dated.example/a 2024-03-05\nhttps://dated.example/b";
  d.getElementById("import-text").dispatchEvent(new view.Event("input"));
  yes(!d.getElementById("import-dest").hidden, "the destination choice shows");
  d.querySelector('input[name="import-dest"][value="list"]').click();
  d.querySelector('input[name="import-dest"][value="list"]').dispatchEvent(new view.Event("change"));
  yes(/2 web links, each on its own, in no stash, 1 with a date/.test(d.getElementById("import-msg").textContent), `preview: ${d.getElementById("import-msg").textContent}`);
  d.getElementById("import-go").click();
  // A paste is a group of its own, each link keeping its own date.
  const pasted = await until(async () => (await getSessions()).find(s => /^Pasted links · /.test(s.name) && s.tabs.length >= 2), "the pasted links to land in their group");
  eq(pasted.tabs.find(t => t.url === "https://dated.example/a")?.saved_at, "2024-03-05T00:00:00.000Z", "the date is kept");
  yes(pasted.tabs.some(t => t.url === "https://dated.example/b"), "the undated one is added too");
  yes(!(await getItems()).some(i => i.url.startsWith("https://dated.example/")), "and no reading-list entry is made");
  await browser.tabs.remove(tab.id);
});

const viewOf = page => browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === `/${page}`);

await kase("right-click Stash menu: each scope stashes what it names, relative to the tab clicked", async () => {
  const urls = Array.from({ length: 6 }, (_, i) => url(300 + i));
  const win = await windowOf(urls);
  const tabs = await browser.tabs.query({ windowId: win });
  await onMenuClicked({ menuItemId: "stash:tab:right" }, tabs[3]);
  eq((await getSessions())[0].tabs.map(t => t.url), [url(304), url(305)], "Tabs to the right of the clicked tab");
  await onMenuClicked({ menuItemId: "stash:page:tab" }, tabs[1]);
  eq((await getSessions())[0].tabs.map(t => t.url), [url(301)], "Only this tab");
  await onMenuClicked({ menuItemId: "stash:tab:left" }, tabs[3]);
  eq((await getSessions())[0].tabs.map(t => t.url), [url(300), url(302)], "Tabs to the left, without the ones already gone");
  const left = (await browser.tabs.query({ windowId: win })).map(t => t.url).filter(u => u.startsWith("http"));
  eq(left, [url(303)], "the clicked tab stays");
  await onMenuClicked({ menuItemId: "stash:page:exclude" }, { url: "https://never.example/x", windowId: win });
  yes((await getStashSettings()).exclude.includes("never.example"), "Never stash this site adds it");
  await onMenuClicked({ menuItemId: "stash:page:exclude" }, { url: "https://never.example/x", windowId: win });
  yes(!(await getStashSettings()).exclude.includes("never.example"), "and pressing it again takes it off");
  await browser.windows.remove(win);
});

await kase("List: dragging a row onto a row of another stash moves the bookmark there, ahead of it", async () => {
  const res = await importStashes([
    { name: "Drag A", tabs: ["a1", "a2", "a3"].map(n => ({ url: `https://${n}.drag.example/`, title: `row ${n}` })) },
    { name: "Drag B", tabs: [{ url: "https://b1.drag.example/", title: "row b1" }] },
  ], "text");
  yes(res.ok, res.error);
  const row = (d, text) => [...d.querySelectorAll("ul.rows.stash > li")].find(li => li.querySelector(".ttl")?.textContent === text);
  const { tab, view, doc: d } = await openPage("list.html?group=stash", d => row(d, "row a2") && row(d, "row b1"), "the rows to drag");
  const from = row(d, "row a2"), onto = row(d, "row b1");
  yes(from && onto, "both rows listed");
  eq(from.draggable, true, "a stash's row drags");
  const dt = new view.DataTransfer();
  const drag = (type, node, y) => node.dispatchEvent(new view.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  const top = onto.getBoundingClientRect().top + 2;
  drag("dragstart", from, 0);
  drag("dragover", onto, top);
  yes(onto.classList.contains("drop-before"), "the drop spot is marked");
  drag("drop", onto, top);
  await until(async () => (await getSessions()).find(x => x.name === "Drag B")?.tabs.length === 2, "the row to land in the other stash");
  const s = await getSessions();
  eq(s.find(x => x.name === "Drag B").tabs.map(t => t.title), ["row a2", "row b1"], "moved into B, ahead of b1");
  eq(s.find(x => x.name === "Drag A").tabs.map(t => t.title), ["row a1", "row a3"], "and out of A");
  await browser.tabs.remove(tab.id);
});

await kase("popup: the Stash ▾ scopes stash what they say from the popup", async () => {
  const win = await windowOf([url(400), url(401)]);
  const popup = await browser.tabs.create({ windowId: win, url: browser.runtime.getURL("popup.html"), active: true });
  await browser.windows.update(win, { focused: true });
  const d = (await pageOf(popup, d => d.getElementById("where").textContent && d.getElementById("stash-more"), "the popup")).document;
  d.getElementById("stash-more").click();
  d.querySelector('#stash-menu [data-scope="left"]').click();
  await until(async () => (await getSessions()).length === 1, "the popup's stash to be written");
  eq((await getSessions())[0].tabs.map(t => t.url), [url(400), url(401)], "Tabs to the left of the popup's tab");
  await browser.tabs.remove(popup.id).catch(() => {});
  await browser.windows.remove(win).catch(() => {});
});

await kase("Cards: t opens the tag editor over the card; a tag typed there is saved for that link", async () => {
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  await addItems(["a", "b", "c"].map(n => ({ url: `https://card.example/${n}`, title: `Card ${n}` })));
  const { tab, view, doc: d } = await openPage("list.html?cards", d => d.querySelector(".cm-card.top .cm-open"), "a card to be dealt");
  const cardUrl = d.querySelector(".cm-card.top .cm-open")?.href;
  yes(cardUrl, "a card is dealt");
  d.body.dispatchEvent(new view.KeyboardEvent("keydown", { key: "t", bubbles: true }));
  const input = await until(() => d.querySelector(".tagpop .tagger input"), "the editor to open");
  yes(input, "the editor opens");
  input.value = "from cards";
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const linkOf = async () => (await getLinks()).links.find(l => l.url === cardUrl || l.key === keyOf(cardUrl));
  await until(async () => (await linkOf())?.tags.includes("from cards"), "the tag to be saved for the card's link");
  await until(() => d.querySelector(".cm-card.top .tags")?.textContent.includes("from cards"), "the card to show the tag");
  const link = await linkOf();
  yes(link?.tags.includes("from cards"), `saved for the card's link: ${JSON.stringify(link?.tags)}`);
  yes(d.querySelector(".cm-card.top .tags")?.textContent.includes("from cards"), "the card shows it at once");
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !d.querySelector(".tagpop"), "Escape to close the editor");
  eq(d.querySelector(".tagpop"), null, "Escape closes it");
  view.localStorage.setItem("listCards", "0");
  await browser.tabs.remove(tab.id);
});

await kase("Settings: renaming a tag onto another merges them on every link", async () => {
  await setTags("https://merge.example/1", ["mergeme"]);
  await setTags("https://merge.example/2", ["target", "mergeme"]);
  await addItems([{ url: "https://merge.example/1" }, { url: "https://merge.example/2" }]);
  const { tab, view, doc: d } = await openPage("list.html", d => hasRows(d) && d.getElementById("settings"), "the List page");
  d.getElementById("settings").click();
  const chip = await until(() => [...d.querySelectorAll("#tag-list button.link")].find(b => b.textContent === "mergeme"), "the tag to be listed");
  yes(chip, "the tag is listed");
  chip.click();
  const input = await until(() => d.querySelector("#tag-list input.rename-tag"), "the rename field to open");
  input.value = "target";
  view.confirm = () => true;   // a merge asks first
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => /Merged mergeme → target on 2 links/.test(d.getElementById("msg").textContent), "the merge to say so");
  const tags = (await browser.storage.local.get("linkTags")).linkTags;
  eq([tags["merge.example/1"], tags["merge.example/2"]], [["target"], ["target"]], "merged, with no repeat");
  yes(/Merged mergeme → target on 2 links/.test(d.getElementById("msg").textContent), "and it says so");
  await browser.tabs.remove(tab.id);
});

await kase("data patches run once and are recorded; a fingerprint not found here changes nothing", async () => {
  yes((await importStashes([{ name: "Left alone", tabs: [{ url: "https://patch.example/a" }] }], "text")).ok, "seed stash");
  const before = (await getSessions()).map(s => [s.id, s.source]);
  eq(before.length, 1, "one stash to leave alone");
  const done = await applyDataPatches();
  const rec = done["2026-09-29-mark-onetab-import"];
  yes(rec?.at, "recorded with when it ran");
  yes(/folders in the window/.test(rec.skipped || ""), `skipped here: ${JSON.stringify(rec)}`);
  eq((await getSessions()).map(s => [s.id, s.source]), before, "no stash changed");
  // Stored as returned, and a second pass in a fresh run of the code (as after the page is suspended and wakes) leaves it as it was.
  const id = "2026-09-29-mark-onetab-import";
  eq((await browser.storage.local.get("dataPatches")).dataPatches[id], rec, "stored as returned");
  patching = null;
  eq((await applyDataPatches())[id], rec, "a second pass does not run it again");
  eq((await browser.storage.local.get("dataPatches")).dataPatches[id], rec, "and leaves the record as it was");
});

await kase("tagging one link after another in the Links detail pane: Untagged chip, Enter saves, Enter on empty moves to the next", async () => {
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  await addItems(["a", "b", "c"].map(n => ({ url: `https://pane.example/${n}`, title: `Pane ${n}` })));
  const { tab, view, doc: d } = await openPage("list.html?pane=1", d => hasRows(d) && /^Untagged/.test(d.querySelector("#tagchips .tagchip")?.textContent || "") && d.querySelector("#detail .pos")?.textContent, "the List page with its pane");
  d.querySelector("#tagchips .tagchip").click();
  await until(() => d.querySelector('#tagchips .chip[aria-pressed="true"]'), "the Untagged chip to apply");
  const untagged = (await getLinks()).links.filter(l => !l.tags.length).length;
  yes(d.querySelectorAll("ul.rows > li").length > 0 && untagged > 0, "the chip shows the untagged links");
  // Rows may share a title; the pane's "i / n" says which row is selected.
  const first = d.querySelector("#detail .pos").textContent;
  const input = () => d.querySelector("#detail .tagger input");
  input().focus();
  input().value = "tagged in the pane";
  input().dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(async () => (await getLinks()).links.some(l => l.tags.includes("tagged in the pane")), "the tag to be saved for that link");
  yes((await getLinks()).links.some(l => l.tags.includes("tagged in the pane")), "saved for that link");
  input().dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => d.querySelector("#detail .pos").textContent !== first, "Enter on the empty field to move to the next link");
  yes(d.querySelector("#detail .pos").textContent !== first, `Enter on the empty field moves to the next link (${first} → ${d.querySelector("#detail .pos").textContent})`);
  eq(d.activeElement, input(), "with its tag field open");
  await browser.tabs.remove(tab.id);
});

await kase("'All tabs in this window' takes the whole window even when several tabs are selected", async () => {
  const urls = Array.from({ length: 5 }, (_, i) => url(500 + i));
  const win = await windowOf(urls, { pinFirst: true });
  const tabs = await browser.tabs.query({ windowId: win });
  await browser.tabs.highlight({ windowId: win, tabs: [tabs[2].index, tabs[3].index] });
  await onMenuClicked({ menuItemId: "stash:page:window" }, tabs[3]);
  eq((await getSessions())[0].tabs.map(t => t.url), urls.slice(1), "every unpinned tab, not just the selection");
  const left = (await browser.tabs.query({ windowId: win })).map(t => t.url).filter(u => u.startsWith("http"));
  eq(left, [url(500)], "the pinned tab stays");
  await browser.windows.remove(win);
});
