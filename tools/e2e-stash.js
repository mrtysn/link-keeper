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
  // List takes up ?group=stash and then drops it from its address, so either form is the List page.
  eq(left.map(t => t.url.replace("?group=stash", "")).sort(), [url(0), browser.runtime.getURL("list.html")].sort(), "pinned tab and the List page stay");
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

await check("import takes OneTab's raw URLs — unicode, spaces, uppercase hosts — and reads them back", async () => {
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

await check("the joined dataset: one link per URL across stashes and the list, one verdict for every copy, imports marked", async () => {
  const res = await importStashes([{ tabs: [{ url: "https://joint.example/a", title: "A" }, { url: "https://joint.example/b" }] }], "onetab");
  yes(res.ok, res.error);
  await addItems([{ url: "https://joint.example/a", title: "A on the list" }]);
  let { links, stashes } = await getLinks();
  const a = links.filter(l => l.url.startsWith("https://joint.example/a"));
  eq(a.length, 1, "one row for a URL held in a stash and on the list");
  eq(a[0].sources.sort(), ["import", "list"], "held in both");
  eq([stashes[0].source, stashes[0].format], ["import", "onetab"], "the import is marked");
  const judged = await judgeLink("https://joint.example/a", "drop");
  eq([judged.list, judged.stashed], [1, 1], "the verdict reached the list and the stash");
  ({ links } = await getLinks());
  eq(links.find(l => l.key === a[0].key).verdict, "drop", "one verdict");
  eq((await getItems()).find(i => i.url === "https://joint.example/a").status, "skipped", "the list entry is skipped");
  eq((await getSessions())[0].tabs[0].verdict, "drop", "the bookmark's record is dropped");
  await judgeLink("https://joint.example/a", null);
  eq((await getSessions())[0].tabs[0].verdict, undefined, "cleared everywhere");
});

await check("List, Cards and Explore load in Firefox with the bar, the sources and rows from every source", async () => {
  const errors = [];
  const open = async page => {
    const tab = await browser.tabs.create({ url: browser.runtime.getURL(page), active: true });
    await wait(1500);
    const view = browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === `/${page.split("?")[0]}`);
    yes(view, `${page}: no page to inspect`);
    view.addEventListener("error", e => errors.push(`${page}: ${e.message}`));
    return { tab, doc: view.document, view };
  };
  const list = await open("list.html?group=stash");
  const d = list.doc;
  eq([...d.querySelectorAll(".app-pages a")].map(a => a.textContent), ["List", "Cards", "Explore", "Tags"], "viewers in the bar");
  eq(d.querySelector('.app-pages a[aria-current="page"]').textContent, "List", "List is marked");
  eq([...d.querySelectorAll(".app-sources button")].map(b => b.getAttribute("aria-pressed")), ["true", "true", "true"], "every source on at first");
  yes(d.querySelectorAll("ul.rows.stash > li").length > 300, "stash rows listed");
  yes([...d.querySelectorAll(".group > h2 .badge")].some(b => b.textContent.startsWith("Imported")), "an import is marked on its heading");
  eq(d.getElementById("groupby").value, "stash", "grouped by stash");

  // Turning Stashed tabs and Imports off leaves the reading list, on every page.
  d.querySelectorAll(".app-sources button")[0].click();
  d.querySelectorAll(".app-sources button")[1].click();
  await wait(800);
  eq((await browser.storage.local.get("viewSources")).viewSources, ["list"], "the choice is stored");
  eq(d.querySelectorAll("ul.rows.stash > li").length, 0, "no stash rows with stashes off");
  yes([...d.querySelectorAll(".group > h2")].some(h => h.textContent.startsWith("Reading list")), "the reading list shows");

  const explore = await open("stash-cards.html");
  eq([...explore.doc.querySelectorAll(".app-sources button")].map(b => b.getAttribute("aria-pressed")), ["false", "false", "true"], "Explore shares the choice");
  yes(explore.doc.querySelector("#side h2")?.textContent.startsWith("Reading list"), "Explore lists the reading list");
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  await wait(800);
  yes(explore.doc.querySelectorAll("#side li").length > 300, "Explore lists stashed tabs once they are back on");
  yes(explore.doc.querySelector(".dtitle"), "a link is shown in full");

  const cards = await open("cards.html");
  yes(cards.doc.querySelector(".card.top"), "Cards deals a card");

  const sessions = await browser.tabs.create({ url: browser.runtime.getURL("sessions.html"), active: true });
  await wait(1000);
  eq((await browser.tabs.get(sessions.id)).url, browser.runtime.getURL("list.html?group=stash").replace("?group=stash", ""), "the old page forwards to List (its ?group is taken up and dropped)");
  eq(errors, [], "no script errors");
  await browser.tabs.remove([list.tab.id, explore.tab.id, cards.tab.id, sessions.id]);
});

await check("Duplicates: every copy of a link gets a checkbox, nothing is ticked, and only the ticked copy goes", async () => {
  const res = await importStashes([
    { name: "Dup one", tabs: [{ url: "https://dup.example/x", title: "X" }, { url: "https://dup.example/only-here" }] },
    { name: "Dup two", tabs: [{ url: "https://dup.example/x", title: "X again" }] },
  ], "text");
  yes(res.ok, res.error);
  await addItems([{ url: "https://dup.example/x" }]);
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html?group=stash"), active: true });
  await wait(1500);
  const view = browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === "/list.html");
  const d = view.document;
  yes(!d.getElementById("dups").hidden, "the Duplicates button shows");
  d.getElementById("dups").click();
  await wait(300);
  const card = [...d.querySelectorAll(".dup-card")].find(c => c.textContent.includes("dup.example/x"));
  yes(card, "a card for the duplicated link");
  const rows = [...card.querySelectorAll(".dup-row")];
  eq(rows.map(r => r.querySelector(".dup-where").textContent), ["Dup one", "Dup two", "Reading list"], "one row per copy");
  eq(rows.map(r => r.querySelector("input").checked), [false, false, false], "nothing ticked");
  yes(d.getElementById("dups-remove").disabled, "nothing to remove yet");
  rows[1].querySelector("input").click();
  view.confirm = () => true;
  d.getElementById("dups-remove").click();
  await wait(1500);
  const all = await getSessions();
  eq(all.find(s => s.name === "Dup one")?.tabs.length, 2, "the unticked stash keeps its copy");
  eq(all.some(s => s.name === "Dup two"), false, "the ticked copy went, and its emptied stash with it");
  yes((await getItems()).some(i => i.url === "https://dup.example/x"), "the reading-list copy stays");
  await browser.tabs.remove(tab.id);
});

await check("Tags: the ✎ editor on a List row saves a tag for the URL, every page shows it, and Group by Tag files it", async () => {
  const res = await importStashes([{ name: "Tag me", tabs: [{ url: "https://github.com/tagged/repo", title: "A repo" }, { url: "https://tag.example/two" }] }], "text");
  yes(res.ok, res.error);
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html?group=stash"), active: true });
  await wait(1500);
  const view = browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === "/list.html");
  const d = view.document;
  const row = [...d.querySelectorAll("ul.rows.stash > li")].find(li => li.textContent.includes("A repo"));
  yes(row, "the row is listed");
  eq(row.querySelector(".tag.guess")?.textContent, "code", "github is guessed as code, dimmed");
  row.querySelector(".tagedit").click();
  await wait(200);
  const input = d.querySelector(".tagpop .tagger input");
  yes(input, "the editor opens");
  input.value = "Jam Tools";
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(600);
  const stored = (await browser.storage.local.get("linkTags")).linkTags || {};
  eq(stored["github.com/tagged/repo"], ["code", "jam tools"], "the kept guess and the new tag are saved for the URL");
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(800);
  eq(d.querySelector(".tagpop"), null, "Escape closes the editor");

  d.getElementById("groupby").value = "tag";
  d.getElementById("groupby").dispatchEvent(new view.Event("change"));
  await wait(300);
  const heads = [...d.querySelectorAll(".group > h2 span:first-child")].map(s => s.textContent);
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

await check("the popup: three viewers with live counts, This tab's split buttons, and the reading list's next link", async () => {
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("popup.html"), active: true });
  await wait(1200);
  const view = browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === "/popup.html");
  const d = view.document;
  const c = await linkCounts();
  eq(d.getElementById("n-links").textContent, c.total.toLocaleString(), "List shows the links on show");
  eq(d.getElementById("n-undecided").textContent, c.undecided.toLocaleString(), "Cards shows what is left to judge");
  eq([...d.querySelectorAll("#sources button")].length, 3, "one toggle per source");
  eq([...d.querySelectorAll("#stash-menu [data-scope]")].map(b => b.dataset.scope), ["window", "tab", "left", "right", "others", "all-windows"], "the scopes sit behind the arrow");
  yes(d.getElementById("keep-shot") && d.getElementById("keep-note"), "Keep's arrow offers a screenshot and a note");
  eq(d.querySelector("details"), null, "no drawers left");
  d.getElementById("keep-note").click();
  await wait(100);
  eq(d.getElementById("note-row").hidden, false, "the note field shows when asked for");
  await browser.tabs.remove(tab.id);
});

await check("List's Import adds pasted links to the reading list with their dates", async () => {
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html#import"), active: true });
  await wait(1500);
  const view = browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === "/list.html");
  const d = view.document;
  d.getElementById("import-text").value = "https://dated.example/a 2024-03-05\nhttps://dated.example/b";
  d.getElementById("import-text").dispatchEvent(new view.Event("input"));
  yes(!d.getElementById("import-dest").hidden, "the destination choice shows");
  d.querySelector('input[name="import-dest"][value="list"]').click();
  d.querySelector('input[name="import-dest"][value="list"]').dispatchEvent(new view.Event("change"));
  yes(/2 web links for the reading list, 1 with a date/.test(d.getElementById("import-msg").textContent), `preview: ${d.getElementById("import-msg").textContent}`);
  d.getElementById("import-go").click();
  await wait(800);
  const items = await getItems();
  eq(items.find(i => i.url === "https://dated.example/a")?.saved_at, "2024-03-05T00:00:00.000Z", "the date is kept");
  yes(items.some(i => i.url === "https://dated.example/b"), "the undated one is added too");
  await browser.tabs.remove(tab.id);
});

const viewOf = page => browser.extension.getViews({ type: "tab" }).find(v => v.location.pathname === `/${page}`);

await check("right-click Stash menu: each scope stashes what it names, relative to the tab clicked", async () => {
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

await check("List: dragging a row onto a row of another stash moves the bookmark there, ahead of it", async () => {
  const res = await importStashes([
    { name: "Drag A", tabs: ["a1", "a2", "a3"].map(n => ({ url: `https://${n}.drag.example/`, title: `row ${n}` })) },
    { name: "Drag B", tabs: [{ url: "https://b1.drag.example/", title: "row b1" }] },
  ], "text");
  yes(res.ok, res.error);
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html?group=stash"), active: true });
  await wait(1500);
  const view = viewOf("list.html"), d = view.document;
  const row = text => [...d.querySelectorAll("ul.rows.stash > li")].find(li => li.querySelector(".ttl")?.textContent === text);
  const from = row("row a2"), onto = row("row b1");
  yes(from && onto, "both rows listed");
  eq(from.draggable, true, "an unlocked stash's row drags");
  const dt = new view.DataTransfer();
  const drag = (type, node, y) => node.dispatchEvent(new view.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  const top = onto.getBoundingClientRect().top + 2;
  drag("dragstart", from, 0);
  drag("dragover", onto, top);
  yes(onto.classList.contains("drop-before"), "the drop spot is marked");
  drag("drop", onto, top);
  await wait(1000);
  const s = await getSessions();
  eq(s.find(x => x.name === "Drag B").tabs.map(t => t.title), ["row a2", "row b1"], "moved into B, ahead of b1");
  eq(s.find(x => x.name === "Drag A").tabs.map(t => t.title), ["row a1", "row a3"], "and out of A");
  await browser.tabs.remove(tab.id);
});

await check("popup: the Stash ▾ scopes stash what they say from the popup", async () => {
  const win = await windowOf([url(400), url(401)]);
  const popup = await browser.tabs.create({ windowId: win, url: browser.runtime.getURL("popup.html"), active: true });
  await browser.windows.update(win, { focused: true });
  await wait(1200);
  const d = viewOf("popup.html").document;
  d.getElementById("stash-more").click();
  d.querySelector('#stash-menu [data-scope="left"]').click();
  await wait(1500);
  eq((await getSessions())[0].tabs.map(t => t.url), [url(400), url(401)], "Tabs to the left of the popup's tab");
  await browser.tabs.remove(popup.id).catch(() => {});
  await browser.windows.remove(win).catch(() => {});
});

await check("Cards: t opens the tag editor over the card; a tag typed there is saved for that link", async () => {
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("cards.html"), active: true });
  await wait(1500);
  const view = viewOf("cards.html"), d = view.document;
  const cardUrl = d.querySelector(".card.top .open")?.href;
  yes(cardUrl, "a card is dealt");
  d.body.dispatchEvent(new view.KeyboardEvent("keydown", { key: "t", bubbles: true }));
  await wait(200);
  const input = d.querySelector(".tagpop .tagger input");
  yes(input, "the editor opens");
  input.value = "from cards";
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(600);
  const link = (await getLinks()).links.find(l => l.url === cardUrl || l.key === keyOf(cardUrl));
  yes(link?.tags.includes("from cards"), `saved for the card's link: ${JSON.stringify(link?.tags)}`);
  yes(d.querySelector(".card.top .tags")?.textContent.includes("from cards"), "the card shows it at once");
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(200);
  eq(d.querySelector(".tagpop"), null, "Escape closes it");
  await browser.tabs.remove(tab.id);
});

await check("Settings: renaming a tag onto another merges them on every link", async () => {
  await setTags("https://merge.example/1", ["mergeme"]);
  await setTags("https://merge.example/2", ["target", "mergeme"]);
  await addItems([{ url: "https://merge.example/1" }, { url: "https://merge.example/2" }]);
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html"), active: true });
  await wait(1500);
  const view = viewOf("list.html"), d = view.document;
  d.getElementById("settings").click();
  const chip = [...d.querySelectorAll("#tag-list button.link")].find(b => b.textContent === "mergeme");
  yes(chip, "the tag is listed");
  chip.click();
  const input = d.querySelector("#tag-list input.rename-tag");
  input.value = "target";
  input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(800);
  const tags = (await browser.storage.local.get("linkTags")).linkTags;
  eq([tags["merge.example/1"], tags["merge.example/2"]], [["target"], ["target"]], "merged, with no repeat");
  yes(/Merged mergeme → target on 2 links/.test(d.getElementById("msg").textContent), "and it says so");
  await browser.tabs.remove(tab.id);
});

await check("data patches run once and are recorded; a fingerprint not found here changes nothing", async () => {
  const before = (await getSessions()).map(s => [s.id, s.source]);
  const done = await applyDataPatches();
  const rec = done["2026-09-29-mark-onetab-import"];
  yes(rec?.at, "recorded with when it ran");
  yes(/folders in the window/.test(rec.skipped || ""), `skipped here: ${JSON.stringify(rec)}`);
  eq((await getSessions()).map(s => [s.id, s.source]), before, "no stash changed");
  eq((await browser.storage.local.get("dataPatches")).dataPatches["2026-09-29-mark-onetab-import"].at, rec.at, "stored");
});

await check("tagging one link after another in Explore: Untagged chip, Enter saves, Enter on empty moves to the next", async () => {
  await browser.storage.local.set({ viewSources: ["tabs", "import", "list"] });
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("stash-cards.html"), active: true });
  await wait(1500);
  const view = viewOf("stash-cards.html"), d = view.document;
  d.querySelector('.chip[data-f="untagged"]').click();
  await wait(200);
  const untagged = (await getLinks()).links.filter(l => !l.tags.length).length;
  yes(d.querySelectorAll("#side li").length > 0 && untagged > 0, "the chip shows the untagged links");
  const first = d.querySelector("#side button[aria-current]").dataset.key;
  const input = () => d.querySelector("#detail .tagger input");
  input().focus();
  input().value = "tagged in explore";
  input().dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(600);
  yes((await getLinks()).links.some(l => l.tags.includes("tagged in explore")), "saved for that link");
  input().dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  yes(d.querySelector("#side button[aria-current]").dataset.key !== first, "Enter on the empty field moves to the next link");
  eq(d.activeElement, input(), "with its tag field open");
  await browser.tabs.remove(tab.id);
});

await check("'All tabs in this window' takes the whole window even when several tabs are selected", async () => {
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
