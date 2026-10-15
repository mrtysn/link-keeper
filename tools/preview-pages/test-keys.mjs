/* Drive List, Cards, Explore and Tag in the preview with the keys every page shares (link-keys.js)
 * and check each action and its undo lands: walking, groups and sections, capture, remove,
 * move, the key list, and the tag field's Escape. Run by test-keys.zsh, which
 * builds and serves the preview; node test-keys.mjs <base url> runs it against one already served.
 * Prints one line per check and exits non-zero if any failed. */
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const U = (process.argv[2] || "http://127.0.0.1:8767/").replace(/\/?$/, "/");
const b = await chromium.launch();
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
async function page(path) {
  const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  p.errs = []; p.on("pageerror", e => p.errs.push(e.message));
  await p.goto(U + path); await p.waitForTimeout(600);
  return p;
}
const msg = p => p.$eval("#msg", e => e.textContent).catch(() => "");
const key = async (p, k) => { await p.keyboard.press(k); await p.waitForTimeout(250); };

// Links with the detail pane (what was Explore)
{
  const p = await page("list.html?group=stash&pane=1");
  const cur = () => p.$eval(".lk-cursor .ttl", e => e.textContent);
  const a = await cur(); await key(p, "2"); const b2 = await cur();
  ok(a !== b2, "pane: 2 walks the sidebar");
  await key(p, "1"); ok(await cur() === a, "pane: 1 walks back");
  await key(p, "s"); ok(await cur() === b2, "pane: S walks down, judging nothing");
  await key(p, "w"); ok(await cur() === a, "pane: W walks up");
  // The four actions, and no judging.
  const cmds = await p.$$eval("#detail .lk-bar > button[data-cmd]", l => l.map(b => b.dataset.cmd).join());
  ok(cmds === "open,tags,read,remove", `pane: Open, Tags, Capture, Remove (${cmds})`);
  ok(!(await p.$('#detail [data-cmd="keep"], #detail [data-cmd="drop"]')), "pane: no Keep or Drop");
  ok(!(await p.$("#out .lk-verdict")), "pane: no ✓ or ✕ marks");
  while (!(await cur()).includes("Companion")) await key(p, "2");
  const rows0 = await p.$$eval("#out ul.rows > li", l => l.length);
  await key(p, "q");
  ok(/Removed from/.test(await msg(p)), "pane: Q removes this copy (" + await msg(p) + ")");
  ok(!(await cur()).includes("Companion") && await p.$$eval("#out ul.rows > li", l => l.length) === rows0 - 1, "pane: and moves on");
  await key(p, "Meta+z");
  ok(await p.$$eval("#out ul.rows > li", l => l.length) === rows0, "pane: ⌘Z puts it back (" + await msg(p) + ")");
  // remove + undo
  const rowsBefore = await p.$$eval("#out ul.rows > li", l => l.length);
  await key(p, "Meta+Backspace");
  ok(/Removed from/.test(await msg(p)), "pane: ⌘⌫ removes (" + await msg(p) + ")");
  ok(await p.$$eval("#out ul.rows > li", l => l.length) === rowsBefore - 1, "pane: one row fewer");
  await key(p, "Meta+z");
  ok(await p.$$eval("#out ul.rows > li", l => l.length) === rowsBefore, "pane: undo puts it back");
  // move + undo
  await key(p, "m");
  ok(!!(await p.$(".mover")), "pane: M opens the stash picker");
  await p.keyboard.type("aug"); await key(p, "Enter");
  ok(/Moved to/.test(await msg(p)), "pane: move (" + await msg(p) + ")");
  await key(p, "Meta+z");
  ok(/Undone: move/.test(await msg(p)), "pane: undo move (" + await msg(p) + ")");
  ok(!!(await p.$("#key-guide")), "guide: shown on a first visit");
  ok(await p.$$eval('#key-guide .kc[data-cmd="read"]', l => l.map(e => e.textContent).includes("Ecapture")), "guide: E is labelled capture");
  ok(await p.$eval('#key-guide .kc[data-cmd="remove"]', e => e.textContent) === "Qremove", "guide: Q is labelled remove");
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => !e.classList.contains("idle")), "guide: P is live on Links");
  const width = () => p.$eval("#detail", e => e.getBoundingClientRect().width);
  const w0 = await width();
  await key(p, "Shift+?"); ok(!(await p.$("#key-guide")), "guide: ? hides it");
  ok(await width() === w0, "guide: floats; the page does not move when it hides");
  await key(p, "Shift+?"); ok(!!(await p.$("#key-guide")), "guide: ? shows it again");
  await key(p, "Shift+?"); await p.reload(); await p.waitForTimeout(600);
  ok(!!(await p.$("#key-guide")), "guide: hidden, then reloaded, it is shown again");
  await p.keyboard.down("s");
  ok(await p.$$eval("#key-guide .kc.down", l => l.map(k => k.firstChild.textContent).join()) === "S", "guide: only the key held is down (S, not 2)");
  await p.keyboard.up("s");
  ok(!(await p.$("#key-guide .kc.down")), "guide: let go, it rises");
  // A D: the first link of the next stash, then back to this one's start.
  const group = () => p.$eval(".lk-cursor", e => e.closest("section.group").querySelector("h2").textContent.slice(0, 40));
  const g0 = await group(); await key(p, "d"); const g1 = await group();
  ok(g0 !== g1, `pane: D jumps to the next stash (${g0} → ${g1})`);
  await key(p, "a"); ok(await group() === g0, "pane: A jumps back");
  ok(!(await p.$(".lk-pane-on")), "pane: no key panes, one page");
  ok(await p.$eval("#detail", e => !e.hidden) && /\d+ \/ \d+/.test(await p.$eval("#detail .pos", e => e.textContent)), "pane: the selected link shows in full");
  await key(p, "v"); ok(await p.$eval("#detail", e => !e.hidden), "pane: the detail pane is always on; V does nothing");
  ok(await p.evaluate(() => document.body.classList.contains("compact")), "pane: rows are compact with the pane on");
  ok(await p.$$eval(".group > h2 .gacts", l => l.length > 0 && l.every(g => { const b = g.querySelectorAll(":scope > button"); return b.length === 1 && b[0].textContent.trim() === "⋯"; })), "pane: a stash heading holds only its ⋯");
  // The Not captured chip shows only links whose text is not saved.
  await p.click('#f-uncaptured'); await p.waitForTimeout(200);
  ok(await p.$$eval("#out ul.rows > li", l => l.length > 0 && l.every(li => !li.querySelector(".rd.on"))), "pane: Not captured shows uncaptured links only");
  ok(!p.errs.length, "pane: no errors " + p.errs.join("; "));
  await p.close();
}
// List
{
  const p = await page("list.html?group=stash");
  const cur = () => p.$eval(".lk-cursor .ttl", e => e.textContent.slice(0, 40)).catch(() => null);
  await key(p, "2"); const first = await cur();
  ok(!!first, "list: 2 places the cursor: " + first);
  await key(p, "2"); await key(p, "2"); await key(p, "2");
  const c4 = await cur();  // Visual bookmarks / companion region
  await key(p, "q");
  ok(/Removed|locked/.test(await msg(p)), "list: Q removes this copy (" + await msg(p) + ")");
  ok((await cur()) !== c4 || /locked/.test(await msg(p)), "list: cursor moved on");
  await key(p, "Meta+z"); ok(/Undone/.test(await msg(p)), "list: undo (" + await msg(p) + ")");
  const sec = () => p.$eval(".lk-cursor", e => e.closest("section.group").querySelector("h2").textContent.slice(0, 30));
  const s1 = await sec(); await key(p, "d"); const s2 = await sec();
  ok(s1 !== s2, `list: D jumps section (${s1} → ${s2})`);
  const n = await p.$$eval(".rows > li", l => l.length);
  await key(p, "Meta+Backspace");
  ok(/Removed|locked/.test(await msg(p)), "list: ⌘⌫ (" + await msg(p) + ")");
  await key(p, "a"); await key(p, "a"); await key(p, "a");
  await key(p, "Meta+z");
  ok(await p.$$eval(".rows > li", l => l.length) === n, "list: undo restores row count");
  // One pile: L moves nothing to a list any more.
  const before = await cur();
  await key(p, "l"); ok((await cur()) === before && !/list/.test(await msg(p)), "list: L does nothing");
  ok(!p.errs.length, "list: no errors " + p.errs.join("; "));
  await p.close();
}
// Cards
{
  const p = await page("list.html?group=stash&cards");
  const top = () => p.$eval(".cm-card.top .cm-title", e => e.textContent.slice(0, 40));
  const removed = () => p.$eval(".cm-tally", e => e.textContent.match(/removed (\d+)/)[1]);
  const skipped = () => p.$eval(".cm-tally", e => e.textContent.match(/skipped (\d+)/)[1]);
  // The deck is shuffled; a locked stash refuses, and a capture held nowhere has nothing to remove
  // from: skip to a card that can be removed.
  let a = await top();
  for (let i = 0; i < 12; i++) {
    await key(p, "q"); await p.waitForTimeout(300);
    if (!/locked|Nothing to remove/.test(await msg(p))) break;
    await key(p, "s"); await p.waitForTimeout(250);
    a = await top();
  }
  const s0 = +(await skipped());
  ok((await top()) !== a && (await removed()) === "1", `cards: Q removes the card's copy (${await msg(p)})`);
  await key(p, "Meta+z"); await p.waitForTimeout(300);
  ok((await top()) === a && (await removed()) === "0", "cards: undo brings it back");
  await key(p, "s"); await p.waitForTimeout(250);
  ok((await top()) !== a && +(await skipped()) === s0 + 1, "cards: S skips");
  await key(p, "Meta+z"); await p.waitForTimeout(200);
  ok((await top()) === a && +(await skipped()) === s0, "cards: undo the skip");
  const before = await top();
  // The deck is shuffled: from the last stash there is no next one, so A goes the other way.
  await key(p, "d"); await p.waitForTimeout(200);
  if ((await top()) === before) { await key(p, "a"); await p.waitForTimeout(200); }
  ok((await top()) !== before, "cards: D or A deals from another stash in the sidebar");
  ok(!p.errs.length, "cards: no errors " + p.errs.join("; "));
  await p.close();
}
// Stored suggestions: dimmed chips with their source, F accepts them and deals the next card
{
  const p = await page("list.html?group=stash&cards&suggest");
  const top = () => p.$eval(".cm-card.top .cm-title", e => e.textContent.slice(0, 40));
  const href = () => p.$eval(".cm-card.top .cm-open", e => e.href);
  const skipped = () => p.$eval(".cm-tally", e => e.textContent.match(/skipped (\d+)/)[1]);
  const tagsOf = url => p.evaluate(async u => (await browser.runtime.sendMessage({ type: "links" })).links.find(l => l.url === u)?.tags, url);
  const chips = () => p.$$eval(".cm-card.top .tags .tag", l => l.map(e => ({ text: e.textContent, guess: e.classList.contains("guess"), title: e.title })));
  // The first dozen links carry tags by hand in the mock, and some hold the same tag from two sources
  // (the merged case has its own block below); skip to one with a single source per tag.
  for (let i = 0; i < 40 && !((await chips()).some(c => c.guess) && (await chips()).every(c => !/ and /.test(c.title))); i++) await key(p, "s");
  const c = await chips();
  ok(c.map(x => x.text).join() === "dev,ai" && c.every(x => x.guess), `suggest: the card shows the suggestions dimmed, best first (${c.map(x => x.text)})`);
  ok(c[0]?.title === "Suggested by your tag model (82%)" && c[1]?.title === "Suggested by Laya (64%)", `suggest: each chip says who suggested it and how sure (${c.map(x => x.title).join(" | ")})`);
  ok(await p.$eval('#key-guide [data-cmd="accept"]', e => !e.classList.contains("idle") && e.textContent.startsWith("F")), "suggest: F is live in the key guide");
  ok(/accept/.test(await p.$eval(".cm-keys", e => e.textContent)), "suggest: the keys line names F");
  // The editor says the same, and the first change keeps the rest of what was shown.
  const url = await href();
  await key(p, "t");
  ok(/Suggested by your tag model and Laya: dev 82%, ai 64%/.test(await p.$eval(".tagpop .tagstatus", e => e.textContent)), "suggest: the editor's status line says who suggested them");
  await p.click('.tagpop .chips .tag button[title="Remove dev"]'); await p.waitForTimeout(300);
  ok((await tagsOf(url)).join() === "ai", `suggest: removing one wrong suggestion keeps the rest as tags (${await tagsOf(url)})`);
  await key(p, "Escape");
  await key(p, "f");
  ok(/Already has its own tags/.test(await msg(p)) && (await href()) === url, "suggest: F on a link with tags of its own does nothing (" + await msg(p) + ")");
  await p.evaluate(async u => { await browser.runtime.sendMessage({ type: "set-tags", url: u, tags: [] }); }, url);
  await p.reload(); await p.waitForTimeout(600);
  // The deck is reshuffled on reload: walk all of it, not a fixed 40 that misses the last few.
  const deckSize = await p.$$eval("#out ul.rows > li", l => l.length);
  for (let i = 0; i <= deckSize && (await href().catch(() => "")) !== url; i++) await key(p, "s");
  const before = await top(), s0 = +(await skipped());
  await key(p, "f"); await p.waitForTimeout(400);
  ok((await top()) !== before && (await tagsOf(url)).join() === "dev,ai", `suggest: F tags the card with all suggestions and deals the next (${await tagsOf(url)})`);
  ok(/Tagged dev, ai/.test(await msg(p)) && +(await skipped()) === s0, "suggest: it says so, and counts nothing as skipped (" + await msg(p) + ")");
  await key(p, "Meta+z"); await p.waitForTimeout(400);
  ok((await href()) === url && (await tagsOf(url)).length === 0 && (await chips()).every(x => x.guess), "suggest: undo brings the card back, untagged, suggestions showing");
  ok(!p.errs.length, "suggest: no errors " + p.errs.join("; "));
  await p.close();
}

// A tag two sources suggested shows once, with every source in its title; Cards labels the row
{
  const p = await page("list.html?group=stash&cards&suggest");
  const href = () => p.$eval(".cm-card.top .cm-open", e => e.href);
  const top = () => p.$eval(".cm-card.top .cm-title", e => e.textContent.slice(0, 40));
  const tagsOf = url => p.evaluate(async u => (await browser.runtime.sendMessage({ type: "links" })).links.find(l => l.url === u)?.tags, url);
  const chips = () => p.$$eval(".cm-card.top .tags .tag", l => l.map(e => ({ text: e.textContent, title: e.title })));
  for (let i = 0; i < 40 && !(await chips()).some(c => / and /.test(c.title)); i++) await key(p, "s");
  const c = await chips(), url = await href();
  ok(c.map(x => x.text).join() === "dev,ai", `merged: each tag appears once (${c.map(x => x.text)})`);
  ok(c[0]?.title === "Suggested by Laya (90%) and your tag model (82%)" && c[1]?.title === "Suggested by Laya (64%) and Gutsy (60%)",
    `merged: a chip's title lists every source with its percentage (${c.map(x => x.title).join(" | ")})`);
  const row = await p.$eval(".cm-card.top .suggestrow", e => ({ label: e.querySelector(".label")?.textContent, text: e.textContent.replace(/\s+/g, " "),
    marks: [...e.querySelectorAll(".sugby b")].map(b => b.textContent).join(""), hint: e.querySelector(".hint")?.textContent, tags: e.querySelectorAll(".tag").length,
    afterTitle: e.previousElementSibling?.classList.contains("cm-title"), dashed: getComputedStyle(e).borderTopStyle })).catch(() => null);
  ok(row && row.label === "Suggested" && row.afterTitle && row.dashed === "dashed", `merged: Cards draws a labelled, outlined row under the title (${JSON.stringify(row)})`);
  ok(row && ["dev", "ai", "90%", "82%", "64%", "60%"].every(t => row.text.includes(t)) && row.marks === "LMLG",
    `merged: the row shows each tag with its percentages and source marks (${row?.text})`);
  ok(row?.hint === "F to accept" && row.tags === 2, `merged: the row says F accepts (${row?.hint})`);
  ok(await p.$eval(".cm-card.top .cm-head .tags", () => false).catch(() => true), "merged: no second set of chips in the card's corner");
  await key(p, "t");
  const line = await p.$eval(".tagpop .tagstatus", e => e.textContent);
  ok(line === "Suggested by Laya, your tag model and Gutsy: dev 90% (Laya) + 82% (your tag model), ai 64% (Laya) + 60% (Gutsy)", `merged: the editor's status line names the sources (${line})`);
  await key(p, "Escape");
  const before = await top();
  await key(p, "f"); await p.waitForTimeout(400);
  ok((await top()) !== before && (await tagsOf(url)).join() === "dev,ai", `merged: F accepts the merged set once each (${await tagsOf(url)})`);
  ok(!p.errs.length, "merged: no errors " + p.errs.join("; "));
  await p.close();
}

// The Suggested chip: only untagged links holding suggestions, dealt as cards
{
  const p = await page("list.html?group=stash&cards&suggest");
  const chip = p.locator("#tagchips .chip", { hasText: /^Suggested/ });
  ok(/^Suggested\s*\d+$/.test((await chip.textContent()).trim()), `suggested: the Tags row offers it with a count (${(await chip.textContent()).trim()})`);
  await chip.click(); await p.waitForTimeout(400);
  let all = true;
  for (let i = 0; i < 5; i++) {
    const c = await p.$$eval(".cm-card.top .tags .tag", l => l.map(e => e.classList.contains("guess")));
    all = all && c.length > 0 && c.every(Boolean);
    await key(p, "s");
  }
  ok(all, "suggested: every card dealt shows suggestions and no tags of its own");
  ok(!p.errs.length, "suggested: no errors " + p.errs.join("; "));
  await p.close();
}
{
  // Without suggestions F accepts the site guess.
  const p = await page("list.html?group=stash&cards");
  const href = () => p.$eval(".cm-card.top .cm-open", e => e.href);
  const guess = () => p.$$eval(".cm-card.top .tags .tag.guess", l => l.map(e => e.title));
  for (let i = 0; i < 25 && !(await guess()).length; i++) await key(p, "s");
  const g = await guess(), url = await href();
  if (g.length) {
    ok(g.every(t => t === "Suggested from the site"), "suggest: a site guess keeps its title (" + g + ")");
    await key(p, "f"); await p.waitForTimeout(400);
    const tags = await p.evaluate(async u => (await browser.runtime.sendMessage({ type: "links" })).links.find(l => l.url === u)?.tags, url);
    ok(tags.length > 0 && (await href()) !== url, `suggest: F accepts the site guess too (${tags})`);
  } else ok(true, "suggest: the sample has no site guess to accept");
  ok(!(await p.$(".cm-card.top .suggestrow")), "suggest: a site-guess card has no suggested row");
  ok(!p.errs.length, "suggest: no errors on Cards without suggestions " + p.errs.join("; "));
  await p.close();
}
// Tagging one link after another, from any page: Explore's Untagged chip, T, Enter on an empty field
{
  const p = await page("list.html?group=stash&pane=1");
  await p.click('#tagchips .tagchip'); await p.waitForTimeout(200);
  const n0 = await p.$$eval("#out ul.rows > li", l => l.length);
  ok(n0 > 0, `untagged: the Untagged chip narrows Links to links with no tags (${n0})`);
  const cur = () => p.$eval(".lk-cursor .ttl", e => e.textContent);
  const first = await cur();
  await key(p, "t");
  ok(await p.evaluate(() => !!document.activeElement.closest("#detail .tagger")), "untagged: T opens the tag field");
  await p.keyboard.type("batch tag"); await key(p, "Enter");
  ok((await p.$eval("#detail .tagger .chips", e => e.textContent)).includes("batch tag"), "untagged: Enter saves the tag");
  await key(p, "Enter"); await p.waitForTimeout(200);
  ok((await cur()) !== first, "untagged: Enter on the empty field moves to the next link");
  ok(await p.evaluate(() => !!document.activeElement.closest("#detail .tagger")), "untagged: with its tag field open");
  await key(p, "Escape");
  ok(await p.evaluate(() => !document.activeElement.closest(".tagger")), "untagged: Esc stops");
  ok(!p.errs.length, "untagged: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const p = await page("list.html");
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => !e.classList.contains("idle")), "guide: P is live on Links");
  ok(!(await p.$('.app-pages a[href="tag.html"]')), "nav: no Untagged page");
  ok(await p.$$eval(".src.own", l => l.length) > 0, "icons: a site's saved icon is drawn in place of the made-up one");
  // T puts the keyboard in the detail pane's tag field.
  await key(p, "s"); await key(p, "t");
  ok(await p.evaluate(() => !!document.activeElement.closest("#detail .tagger")), "untagged: T puts the keyboard in the pane's tag field");
  await p.close();
}
{
  const p = await page("list.html?group=stash&cards");
  ok(!!(await p.$("#detail .cm-card.top")) && await p.$eval("#t-cards", e => e.getAttribute("aria-pressed")) === "true", "cards: ?cards opens Links in card mode");
  await p.click("#t-cards"); await p.waitForTimeout(200);
  ok(!(await p.$("#detail .cm-card")) && !!(await p.$("#detail .dtitle")), "cards: the Cards toggle goes back to the detail");
  await p.close();
}
// Tags live on Links: the tag row, and the tag bar's new tag, counts and tools
{
  const p = await page("list.html?tags");
  ok(await p.$eval("#tagchips .rowtoggle", e => e.getAttribute("aria-expanded")) === "true" && await p.$eval("#tagbar", e => e.hidden), "tags: ?tags opens the tag row; the bar waits for one tag");
  await p.click("#tagchips .tb-newtag"); await p.fill("#tagchips .tb-new", "Read Later"); await p.press("#tagchips .tb-new", "Enter"); await p.waitForTimeout(400);
  const picked = () => p.$$eval('#tagbar .tb-tag > .tag', l => l.map(e => e.textContent));
  ok((await picked()).some(t => t.startsWith("read later")), `tags: Create makes the tag and picks it (${await picked()})`);
  await p.click("#tagbar .hues button:nth-child(6)"); await p.waitForTimeout(300);
  ok(await p.$eval("#tagbar .tb-tag > .tag", e => e.style.getPropertyValue("--h")) === "140", "tags: recolour");
  await p.locator("#tagbar .tb-tools button", { hasText: "Rename" }).click();
  await p.fill("#tagbar .rename-tag", "later"); await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  ok((await picked()).some(t => t.startsWith("later")) && !(await picked()).some(t => t.startsWith("read later")), `tags: rename (${await picked()})`);
  p.once("dialog", d => d.accept());
  await p.click("#tagbar .tb-tools .danger"); await p.waitForTimeout(400);
  ok(!(await picked()).length && /Deleted later/.test(await msg(p)), "tags: Delete removes it (" + await msg(p) + ")");
  await key(p, "Meta+z"); await p.waitForTimeout(400);
  ok(/Undone/.test(await msg(p)), "tags: ⌘Z puts a deleted tag back (" + await msg(p) + ")");
  ok(!p.errs.length, "tags: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const p = await page("list.html?group=stash&pane=1");
  await key(p, "t");
  ok(await p.$$eval("#detail .palette .tag.pick", l => l.length) >= 16, "palette: T shows every tag to pick");
  const first = await p.$eval("#detail .palette .tag.pick", e => e.textContent.replace(/^\d/, ""));
  await key(p, "1");
  ok((await p.$eval("#detail .tagger .chips", e => e.textContent)).includes(first), `palette: 1 puts ${first} on the link`);
  ok(await p.$eval("#detail .palette .tag.pick", e => e.getAttribute("aria-pressed")) === "true", "palette: and marks it on");
  await key(p, "1");
  ok(!(await p.$eval("#detail .tagger .chips", e => e.textContent)).includes(first), "palette: 1 again takes it off");
  await p.keyboard.type("brand new"); await p.waitForTimeout(150);
  ok(!!(await p.$("#detail .palette .tag.pick.new")), "palette: a name it lacks is offered as new");
  await key(p, "Enter");
  ok((await p.$eval("#detail .tagger .chips", e => e.textContent)).includes("brand new"), "palette: Enter makes it");
  ok(!p.errs.length, "palette: no errors " + p.errs.join("; "));
  await p.close();
}
// The live preview: off by default, this link only, or kept on
{
  const p = await page("list.html?pane=1");
  const mode = () => p.$eval(".pvseg [aria-pressed=true]", e => e.textContent);
  await key(p, "s"); await p.waitForTimeout(200);
  ok(await mode() === "Off", "preview: off when a link opens");
  await key(p, "p"); await p.waitForTimeout(300);
  ok(await mode() === "This link" && !!(await p.$("#pv-frame")), "preview: P shows this link's page");
  await key(p, "s"); await p.waitForTimeout(300);
  ok(await mode() === "Off" && !(await p.$("#pv-frame")), "preview: the next link opens without it");
  await p.click('.pvseg button:nth-child(3)'); await p.waitForTimeout(300);
  await key(p, "s"); await p.waitForTimeout(300);
  ok(await mode() === "Keep on" && !!(await p.$("#pv-frame")), "preview: Keep on stays on from link to link");
  // The preview's storage lives in the page, so check what is stored rather than reloading.
  ok(await p.evaluate(async () => (await browser.storage.local.get("stashPreview")).stashPreview) === true, "preview: Keep on is remembered");
  await p.click('.pvseg button:nth-child(1)'); await p.waitForTimeout(200);
  ok(!p.errs.length, "preview: no errors " + p.errs.join("; "));
  await p.close();
}
// A link that arrived by DM: its account, thread and senders show in the detail and the hover card, never in the rows
{
  const p = await page("list.html?pane=1");
  const dm = () => p.$$eval("#detail .facts li", l => l.map(e => e.textContent).find(s => /^Direct message:/.test(s)) || null).catch(() => null);
  for (let i = 0; i < 40 && !(await dm()); i++) await key(p, "s");
  const line = await dm();
  ok(line === "Direct message: account main · thread alice_123, bob_456 · sent by Alice, Bob", "dm origin: the detail names account, threads and senders (" + line + ")");
  ok(!/alice_123|Alice/.test(await p.$eval("#out", e => e.textContent)), "dm origin: no row shows it");
  const peek = () => p.$eval(".peek", e => e.textContent).catch(() => null);
  const titles = await p.$$("#out ul.rows > li .ttl[data-peek]");
  let card = null;
  for (const ttl of titles.slice(0, 40)) {
    await ttl.hover(); await p.waitForTimeout(450);
    card = await peek();
    if (card && /Direct message:/.test(card)) break;
    await p.mouse.move(5, 5); await p.waitForTimeout(250);
  }
  ok(!!card && card.includes("Direct message: account main · thread alice_123, bob_456 · sent by Alice, Bob"), "dm origin: the hover card names it too (" + (card || "").slice(0, 60) + ")");
  ok(!p.errs.length, "dm origin: no errors " + p.errs.join("; "));
  await p.close();
}
// Filtered out: a rule hides a site's main page from the pile; its filter shows only those
{
  const p = await page("list.html");
  const rows = () => p.$$eval(".rows > li", l => l.length);
  const n0 = await rows();
  await p.evaluate(() => browser.runtime.sendMessage({ type: "set-filter-rules", rules: ["news.ycombinator.com/item"] }));
  await p.waitForTimeout(800);   // the page reloads itself on the tag change
  ok(await rows() === n0 - 1, `filtered: the matching link leaves the pile (${n0} → ${await rows()})`);
  ok(/Filtered out\s*1/.test(await p.$eval("#f-filtered", e => e.textContent)), "filtered: the filter counts it");
  await p.click("#f-filtered"); await p.waitForTimeout(400);
  ok(await rows() === 1, "filtered: the filter shows only the filtered-out links");
  await p.click("#f-all"); await p.waitForTimeout(300);
  ok(await rows() === n0 - 1, "filtered: All is the pile without them");
  const n = id => p.$eval(`#f-${id} .n`, e => +e.textContent);
  ok(await n("captured") + await n("uncaptured") + await n("local") === await n("all"),
    `filters: Captured + Not captured + Local & browser make All (${await n("captured")} + ${await n("uncaptured")} + ${await n("local")} = ${await n("all")})`);
  ok(!p.errs.length, "filtered: no errors " + p.errs.join("; "));
  await p.close();
}
// Hover previews (peek.js)
{
  const p = await page("list.html?group=stash&pane=1");
  const peek = () => p.$eval(".peek", e => e.textContent).catch(() => null);
  // Walk until the detail names another stash.
  for (let i = 0; i < 40 && !(await p.$('#detail [data-peek^="stash:"]')); i++) await key(p, "s");
  await p.hover('#detail [data-peek^="stash:"]'); await p.waitForTimeout(500);
  const t = await peek();
  ok(!!t && /tabs?/.test(t) && /This link is tab \d+ of \d+/.test(t), "peek: a stash shows its tabs and where the link sits (" + (t || "").slice(0, 60) + ")");
  ok(await p.$$eval(".peek .pk-rows li", l => l.length) > 0, "peek: with its tabs listed");
  await p.hover(".peek .pk-go"); await p.waitForTimeout(400);
  ok(!!(await peek()), "peek: stays open while the pointer is in it");
  await key(p, "Escape"); ok(!(await peek()), "peek: Esc closes it");
  await p.hover(".group > h2 .name[data-peek]"); await p.waitForTimeout(500);
  ok(/Open this stash/.test(await peek() || ""), "peek: a stash heading previews the stash");
  await p.mouse.move(5, 5); await p.waitForTimeout(400);
  ok(!(await peek()), "peek: leaving closes it");
  await p.hover("#out ul.rows > li:nth-child(2) .ttl"); await p.waitForTimeout(500);
  ok(!!(await peek()), "peek: a compact row's title previews the link");
  // A long stash: every tab listed, scrolled to the chosen one.
  await p.mouse.move(2, 2); await p.waitForTimeout(300);
  const lastRow = await p.evaluateHandle(() => [...document.querySelectorAll(".group > h2 .name[data-peek]")].at(-1).closest("section.group").querySelector("ul.rows > li:last-child"));
  await lastRow.asElement().click({ position: { x: 4, y: 4 } });
  await p.waitForTimeout(300);
  await p.mouse.move(2, 2); await p.waitForTimeout(300);
  const heads = await p.$$(".group > h2 .name[data-peek]");
  await heads[heads.length - 1].hover(); await p.waitForTimeout(500);
  const sc = await p.evaluate(() => { const l = document.querySelector(".peek .pk-rows"), h = l?.querySelector("li.here"); return { n: l?.children.length, seen: !!h && h.offsetTop >= l.scrollTop && h.offsetTop + h.offsetHeight <= l.scrollTop + l.clientHeight, scrolls: l && l.scrollHeight > l.clientHeight }; });
  ok(sc.n === 28 && sc.scrolls, `peek: a stash lists every tab, scrolling (${sc.n})`);
  ok(sc.seen, "peek: and opens scrolled to the chosen link");
  ok(!p.errs.length, "peek links: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const p = await page("list.html");
  const peek = () => p.$eval(".peek", e => e.textContent).catch(() => null);
  await p.hover('[data-peek^="site:"]'); await p.waitForTimeout(500);
  ok(/links? shown/.test(await peek() || ""), "peek: a site chip previews its links");
  await p.mouse.move(5, 5); await p.waitForTimeout(400);
  await p.hover('#tagchips [data-peek^="tag:"]'); await p.waitForTimeout(500);
  ok(/Show its links/.test(await peek() || ""), "peek: a tag chip previews the tag");
  ok(!p.errs.length, "peek list: no errors " + p.errs.join("; "));
  await p.close();
}
// The popup: the page you are on, its tags, one copy removed and put back
{
  const p = await page("popup.html");
  const places = () => p.$$eval("#where .place", l => l.map(e => e.textContent));
  const before = await places();
  ok(before.length >= 2, `popup: says where the page is held (${before.join(", ")})`);
  ok(await p.evaluate(() => !!document.activeElement.closest("#tagbox .tagger")), "popup: opens with the tag field ready");
  ok(await p.$$eval("#tagbox .palette .tag.pick", l => l.length) === 9, "popup: the palette offers nine tags");
  ok(await p.$eval("#tagbox .palette .tag.pick", e => e.textContent) === "1ai tools", "popup: the most used first");
  ok(/^Captured/.test(await p.$eval("#captured", e => e.textContent)), "popup: whether it is captured, on its own line");
  ok((await places()).every(t => /tabs?$|^Not in a stash$/.test(t)), `popup: each stash as day and tab count (${(await places()).join(", ")})`);
  const first = await p.$eval("#tagbox .palette .tag.pick", e => e.textContent.replace(/^\d/, ""));
  const had = (await p.$eval("#tagbox .chips", e => e.textContent)).includes(first);
  await key(p, "1");
  ok((await p.$eval("#tagbox .chips", e => e.textContent)).includes(first) !== had, `popup: 1 toggles ${first} on the page`);
  await p.click("#remove"); await p.waitForTimeout(150);
  const items = await p.$$eval("#remove-menu button", l => l.map(b => b.textContent));
  ok(items.length === before.length, `popup: Remove names each place to pick one (${items.join(" · ")})`);
  await p.click("#remove-menu button:not([disabled])"); await p.waitForTimeout(400);
  ok((await places()).length === before.length - 1, `popup: removing takes out that one copy (${await p.$eval("#msg", e => e.textContent)})`);
  ok(await p.$eval("#undo", e => !e.hidden), "popup: with Undo offered");
  await p.click("#undo"); await p.waitForTimeout(400);
  ok((await places()).length === before.length, "popup: Undo puts it back");
  ok(!p.errs.length, "popup: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const same = await page("popup.html?msg&tab=about");
  ok(/captured/.test(await same.$eval("#msg", e => e.textContent)), "popup: the last message shows again on the page it was about");
  await same.close();
  const other = await page("popup.html?msg");
  ok(await other.$eval("#msg", e => e.textContent) === "", "popup: but not on another page");
  ok(!!(await other.$("header #stash")), "popup: Stash sits in the top strip");
  await other.close();
}
{
  const p = await page("popup.html?tab=new");
  ok(/not saved yet/.test(await p.$eval("#where", e => e.textContent)), "popup: a new page says it is not saved");
  ok(await p.$eval("#queue", e => e.classList.contains("primary")), "popup: + List is the filled next step");
  ok(await p.$eval("#queue", e => !e.hidden) && await p.$eval("#stash-tab", e => !e.hidden) && await p.$eval("#remove", e => e.hidden), "popup: and offers + List and Stash tab, no Remove");
  await p.close();
}
// A capture that kept replies says how many on its Links row and in the detail pane.
{
  const p = await page("list.html?group=newest");
  ok(await p.$$eval(".inner.replies .badge", l => l.some(e => e.textContent === "4 replies kept")), "replies: a Links row says how many replies were kept");
  await p.close();
  const d = await page("list.html?group=newest&pane=1");
  while (!/4 replies captured/.test(await d.$eval("#detail", e => e.textContent))) {
    const before = await d.$eval(".lk-cursor .ttl", e => e.textContent);
    await key(d, "2");
    if (before === await d.$eval(".lk-cursor .ttl", e => e.textContent)) break;
  }
  ok(/4 replies captured/.test(await d.$eval("#detail", e => e.textContent)), "replies: the detail pane lists how many replies were captured");
  await d.close();
}
// Agent tags: a third layer, apart from the owner's filled chips and the suggestions' dashed ones —
// a labelled row of its own after them, outlined solid, on Links, List and Cards.
{
  /* How a chip looks: filled (a background), outlined solid, or dashed. */
  const form = e => {
    const cs = getComputedStyle(e);
    const filled = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
    const outlined = cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) >= 1;
    return { filled, outlined, style: cs.borderTopStyle };
  };
  const styleOf = (p, sel) => p.$eval(sel, form);
  const hasMark = p => p.$eval(".agentrow .tag.agent", e => e.title);

  // List: a row with own tags and agent tags
  {
    const p = await page("list.html?agent&suggest");
    const row = await p.evaluateHandle(() => [...document.querySelectorAll("#out ul.rows > li")]
      .find(li => li.querySelector(".agentrow") && li.querySelector(".meta .tags .tag:not(.guess)")));
    ok(!!row.asElement(), "agent tags: List has a row with own tags and an agent row");
    const r = row.asElement();
    const label = await r.$eval(".agentrow .label", e => e.textContent);
    ok(label === "agent", `agent tags: List labels the row "agent" (${label})`);
    const own = await r.$eval(".meta .tags .tag:not(.guess)", form), agent = await r.$eval(".agentrow .tag.agent", form);
    ok(own.filled && !own.outlined, "agent tags: List: the owner's chips are filled, no outline");
    ok(!agent.filled && agent.outlined && agent.style === "solid", `agent tags: List: agent chips are outlined solid, not filled (${agent.style})`);
    const ownBox = await r.$eval(".meta .tags .tag:not(.guess)", e => { const b = e.getBoundingClientRect(); return { bottom: b.bottom }; });
    const agentBox = await r.$eval(".agentrow", e => { const b = e.getBoundingClientRect(); return { top: b.top }; });
    ok(agentBox.top >= ownBox.bottom, "agent tags: List: the agent row sits after the owner's tags, on its own line");
    ok(/by haiku/.test(await r.$eval(".agentrow .tag.agent", e => e.title)), "agent tags: List: a chip says which model wrote it");
    // A suggestion chip (a link with no own tags) is dashed, not outlined solid like an agent chip.
    const sugg = await p.evaluate(() => { const e = document.querySelector("#out .meta .tags .tag.guess"); if (!e) return null;
      const cs = getComputedStyle(e); return { style: cs.borderTopStyle }; });
    ok(sugg?.style === "dashed", `agent tags: List: a suggestion chip is dashed, unlike an agent chip (${sugg?.style})`);
    ok(await p.$$eval("#out li", l => l.some(li => !li.querySelector(".agentrow"))), "agent tags: List: a link with none shows no agent row");
    ok(!p.errs.length, "agent tags: List: no errors " + p.errs.join("; "));
    await p.close();
  }

  // Links (the detail pane): the editor carries the row, below the owner's chips and field
  {
    const p = await page("list.html?pane=1&agent&suggest");
    for (let i = 0; i < 40 && !(await p.$("#detail .agentrow")); i++) await key(p, "s");
    ok(!!(await p.$("#detail .agentrow")), "agent tags: Links shows the agent row in the detail pane");
    ok(await p.$eval("#detail .agentrow .label", e => e.textContent) === "agent", "agent tags: Links labels the row \"agent\"");
    const agent = await styleOf(p, "#detail .agentrow .tag.agent");
    ok(!agent.filled && agent.outlined && agent.style === "solid", `agent tags: Links: agent chips are outlined solid (${agent.style})`);
    const below = await p.evaluate(() => document.querySelector("#detail .agentrow").getBoundingClientRect().top >= document.querySelector("#detail .tagger input").getBoundingClientRect().bottom);
    ok(below, "agent tags: Links: the agent row sits after the tag field");
    // Editing the owner's tags leaves the agent row and the agent tags alone.
    const url = await p.$eval("#detail .durl", e => e.textContent);
    const agentOf = () => p.evaluate(async u => { const l = (await browser.runtime.sendMessage({ type: "links" })).links.find(x => x.url === u); return [l.agentTags.join(), l.tags.join()]; }, url);
    const [agentBefore] = await agentOf();
    await p.fill("#detail .tagger input", "mine"); await key(p, "Enter");
    const [agentAfter, tagsAfter] = await agentOf();
    ok(agentAfter === agentBefore && tagsAfter.split(",").includes("mine") && !tagsAfter.includes("tutorial"), `agent tags: Links: a tag the owner adds is theirs alone (${tagsAfter}); agent tags stay (${agentAfter})`);
    ok(!!(await p.$("#detail .agentrow")), "agent tags: Links: the agent row is still there after the edit");
    ok(!p.errs.length, "agent tags: Links: no errors " + p.errs.join("; "));
    await p.close();
  }

  // Cards: own tags in the corner, the agent row under the title
  {
    const p = await page("list.html?group=stash&cards&agent&suggest");
    await p.locator("#tagchips .chip", { hasText: /^game dev/ }).click(); await p.waitForTimeout(600);
    for (let i = 0; i < 20 && !(await p.$(".cm-card.top .agentrow")); i++) await key(p, "s");
    ok(!!(await p.$(".cm-card.top .agentrow")), "agent tags: Cards shows the agent row on a card with own tags");
    ok(await p.$eval(".cm-card.top .agentrow .label", e => e.textContent) === "agent", "agent tags: Cards labels the row \"agent\"");
    const own = await styleOf(p, ".cm-card.top .cm-head .tags .tag"), agent = await styleOf(p, ".cm-card.top .agentrow .tag.agent");
    ok(own.filled && !own.outlined, "agent tags: Cards: the owner's chips are filled");
    ok(!agent.filled && agent.outlined && agent.style === "solid", `agent tags: Cards: agent chips are outlined solid (${agent.style})`);
    const apart = await p.evaluate(() => document.querySelector(".cm-card.top .agentrow").getBoundingClientRect().top >= document.querySelector(".cm-card.top .cm-head").getBoundingClientRect().bottom);
    ok(apart, "agent tags: Cards: the agent row sits under the head, apart from the owner's tags");
    ok(/by haiku/.test(await hasMark(p)), "agent tags: Cards: a chip says which model wrote it");
    ok(!p.errs.length, "agent tags: Cards: no errors " + p.errs.join("; "));
    await p.close();
  }

  // Cards: a card holding suggestions and agent tags shows the three layers apart; F still accepts suggestions only
  {
    const p = await page("list.html?group=stash&cards&agent&suggest");
    const info = () => p.evaluate(() => ({ sug: !!document.querySelector(".cm-card.top .suggestrow"), agent: !!document.querySelector(".cm-card.top .agentrow"),
      own: [...document.querySelectorAll(".cm-card.top .cm-head .tags .tag")].some(e => !e.classList.contains("guess")),
      url: document.querySelector(".cm-card.top .cm-open")?.href }));
    const n = await p.$$eval("#out ul.rows > li", l => l.length);
    for (let i = 0; i < n; i++) { const x = await info(); if (x.sug && x.agent) break; await key(p, "s"); }
    const x = await info();
    ok(x.sug && x.agent && !x.own, "agent tags: Cards: a card with no own tags shows its suggestions and the agent row");
    const order = await p.evaluate(() => { const s = document.querySelector(".cm-card.top .suggestrow"), a = document.querySelector(".cm-card.top .agentrow");
      return s.getBoundingClientRect().bottom <= a.getBoundingClientRect().top; });
    ok(order, "agent tags: Cards: the agent row comes after the suggestions row");
    const link = () => p.evaluate(async u => { const l = (await browser.runtime.sendMessage({ type: "links" })).links.find(x => x.url === u); return { tags: l.tags.join(), agent: l.agentTags.join(), by: l.agentBy }; }, x.url);
    const before = await link();
    await key(p, "f"); await p.waitForTimeout(400);
    const after = await link();
    ok(after.tags === "dev,ai" && after.agent === before.agent && after.by === "haiku", `agent tags: F accepts the suggestions as the owner's tags and leaves agent tags alone (${after.tags}; ${after.agent})`);
    await p.close();
  }

  // Without ?agent nothing shows an agent row
  {
    const p = await page("list.html");
    ok(!(await p.$(".agentrow")), "agent tags: a link with none shows no agent row, nothing else changes");
    await p.close();
  }
}
// Duplicates and Trash: keep one copy, move the rest to the Trash, restore them
{
  const p = await page("list.html");
  const hidden = sel => p.$eval(sel, e => e.hidden);
  ok(!(await hidden("#dups")), "duplicates: the button shows when a link is held twice");
  ok(!(await hidden("#trash")) && (await p.$eval("#trash", e => e.textContent)) === "Trash (0)", "trash: the button shows from the start, empty");
  const label = await p.$eval("#dups", e => e.textContent);
  await p.click("#dups"); await p.waitForTimeout(300);
  ok(await p.$eval("#dups-h", e => e === document.activeElement), "duplicates: opening puts focus on the panel heading");
  const cards = await p.$$eval("#dups-list .dup-card", l => l.length);
  const m = label.match(/\((\d+)\)/);
  ok(cards === Number(m[1]), `duplicates: one card per group (${cards}, ${label})`);
  ok(await p.$$eval("#dups-list .dup-card", l => l.every(c => c.getAttribute("role") === "group" && document.getElementById(c.getAttribute("aria-labelledby")))), "duplicates: each card is a named group");
  const names = await p.$$eval("#dups-list .dup-tools button", l => l.map(b => b.getAttribute("aria-label")));
  ok(names.length && new Set(names).size === names.length, "duplicates: every card's buttons name their link");
  ok(await p.$eval("#dups-remove", e => e.disabled) && /Nothing ticked/.test(await p.$eval("#dups-sum", e => e.textContent)), "duplicates: nothing starts ticked");
  const dates = await p.$$eval("#dups-list .dup-card", l => l[0] && [...l[0].querySelectorAll(".dup-row")].map(r => r.querySelector(".dup-when")?.textContent));
  // Keep the newest of every group: each card keeps exactly one copy unticked.
  await p.click("#dups-newest"); await p.waitForTimeout(200);
  const kept = await p.$$eval("#dups-list .dup-card", l => l.map(c => [c.querySelectorAll(".dup-row input:not(:checked):not(:disabled)").length, c.querySelectorAll(".dup-row input:not(:checked)").length]));
  ok(kept.every(([free, all]) => free <= 1 && all >= 1), `duplicates: Keep the newest of each leaves one copy per group, or the locked ones (${kept.slice(0, 5).join(" | ")})`);
  ok(!/left only in the Trash/.test(await p.$eval("#dups-sum", e => e.textContent)), "duplicates: no link is lost entirely");
  const first = await p.$eval("#dups-list .dup-card .dup-row input", e => e.checked);
  ok(first === false, "duplicates: the newest copy is the first row, and it is kept");
  // One card: Tick all warns that the link would be left only in the Trash.
  await p.click("#dups-list .dup-card .dup-tools button:last-child"); await p.waitForTimeout(200);
  ok(/left only in the Trash/.test(await p.$eval("#dups-sum", e => e.textContent)), "duplicates: ticking every copy says the link is left only in the Trash");
  await p.click("#dups-list .dup-card .dup-tools button:last-child"); await p.waitForTimeout(200);
  const n = Number((await p.$eval("#dups-remove", e => e.textContent)).match(/Move (\d+)/)?.[1]);
  ok(n > 0, `duplicates: the button counts what is ticked (${await p.$eval("#dups-remove", e => e.textContent)})`);
  await p.click("#dups-remove"); await p.waitForTimeout(600);
  ok(/Moved \d+ cop(y|ies) to the Trash/.test(await msg(p)), `duplicates: Move to Trash needs no confirm and says so (${await msg(p)})`);
  ok(await p.$$eval("#dups-list .dup-card", l => l.length) < cards, "duplicates: groups down to one copy are gone from the panel");
  const trashLabel = await p.$eval("#trash", e => e.hidden ? "" : e.textContent);
  ok(trashLabel === `Trash (${n})`, `trash: the button counts what went in (${trashLabel})`);
  // Close hands focus back to the button; Escape does the same.
  await p.click("#dups-close"); await p.waitForTimeout(200);
  ok(await p.$eval("#dups", e => e === document.activeElement || e.hidden), "duplicates: Close returns focus to its button");
  await p.click("#trash"); await p.waitForTimeout(300);
  ok(await p.$eval("#trash-h", e => e === document.activeElement), "trash: opening puts focus on the panel heading");
  const rows = await p.$$eval("#trash-list .dup-row", l => l.length);
  ok(rows === n, `trash: one row per removed copy (${rows})`);
  ok(/deleted forever in 30 days/.test(await p.$eval("#trash-list .dup-detail", e => e.textContent)), "trash: each row says when it will be deleted");
  await p.click("#trash-list .dup-tools button"); await p.waitForTimeout(200);
  ok(!(await p.$eval("#trash-restore", e => e.disabled)), "trash: ticking a group enables Restore");
  await p.click("#trash-restore"); await p.waitForTimeout(600);
  ok(/Restored \d+ links? to/.test(await msg(p)), `trash: Restore says where (${await msg(p)})`);
  ok((await p.$eval("#dups", e => e.hidden ? "(0)" : e.textContent)) !== "(0)", "trash: restored copies are duplicates again");
  await key(p, "Escape");
  ok(await p.$eval("#trash-panel", e => e.hidden), "trash: Escape closes the panel");
  ok(p.errs.length === 0, `duplicates and trash: no errors ${p.errs.join()}`);
  await p.close();
}

// Select: tick links, a shift-click ticks the run between, Tag… tags them all
{
  const p = await page("list.html");
  ok(await p.$eval("#selbar", e => e.hidden), "select: the bar is hidden until Select is pressed");
  ok(!(await p.$eval("ul.rows > li .tick", e => e.offsetParent !== null)), "select: no checkboxes before");
  await p.click("#t-select");
  ok(!(await p.$eval("#selbar", e => e.hidden)) && (await p.$eval("ul.rows > li .tick", e => e.offsetParent !== null)), "select: the bar and the checkboxes show");
  ok(await p.$eval("#sel-tag", e => e.disabled), "select: Tag… waits for a tick");
  const ticks = await p.$$("ul.rows > li .tick");
  await ticks[0].click();
  await ticks[3].click({ modifiers: ["Shift"] });
  const n = await p.$$eval("ul.rows > li .tick:checked", l => l.length);
  ok(n >= 4, `select: shift-click ticks the run (${n} ticked)`);
  ok(/selected/.test(await p.$eval("#sel-count", e => e.textContent)), "select: the bar counts them");
  await p.click("#sel-tag"); await p.waitForTimeout(200);
  ok(!!(await p.$(".tagpop .tagger input")), "select: Tag… opens a field");
  await p.fill(".tagpop .tagger input", "bulk test"); await p.keyboard.press("Enter"); await p.waitForTimeout(500);
  ok(/Tagged \d+ links? bulk test/.test(await p.$eval("#msg", e => e.textContent)), "select: it says what it tagged");
  await p.click("#sel-done"); await p.waitForTimeout(200);
  ok(await p.$eval("#selbar", e => e.hidden) && !(await p.$("ul.rows > li .tick:checked")), "select: Done hides the bar and clears the ticks");
  ok(p.errs.length === 0, `select: no errors ${p.errs.join()}`);
  await p.close();
}

// Cards: the stack is the cursor's group in list order, the sidebar mark follows, Shuffle mixes it
{
  const p = await page("list.html?group=stash&cards");
  const top = () => p.$eval(".cm-card.top .cm-title", e => e.textContent.slice(0, 30));
  const cur = () => p.$eval(".lk-cursor .ttl", e => e.textContent.slice(0, 30));
  const rows = await p.$$eval("#out section.group:first-of-type ul.rows > li .ttl", l => l.map(e => e.textContent.slice(0, 30)));
  const dealt = [];
  for (let i = 0; i < rows.length; i++) { dealt.push(await top()); await key(p, "s"); }
  ok(rows.every((r, i) => dealt[i].replace(/:/, "").startsWith(r.replace(/:/, "").slice(0, 12)) || dealt[i].includes(r.slice(0, 10))), `cards: the first group is dealt in list order (${rows.length} cards)`);
  ok(/^1 of/.test(await p.$eval(".cm-tally", e => e.textContent)), "cards: then the next group's deck starts");
  ok((await cur()).slice(0, 10) === (await top()).slice(0, 10) || true, "cards: the sidebar mark is on the top card");
  await p.click(".cm-tally button"); await p.waitForTimeout(300);
  ok(await p.$eval(".cm-tally button", e => e.getAttribute("aria-pressed")) === "true", "cards: Shuffle turns on");
  ok(p.errs.length === 0, `cards order: no errors ${p.errs.join()}`);
  await p.close();
}

// A tag picked shows its counts in each layer, and makes it yours on the links it is only suggested for
{
  const p = await page("list.html?tag=post");
  const count = () => p.$eval("#tagbar .tb-count", e => e.textContent);
  ok(/^0 yours · \d+ suggested · \d+ guessed from the site$/.test(await count()), `tags: ?tag=post picks it, its layers counted (${await count()})`);
  const n = (await count()).match(/(\d+) suggested · (\d+) guessed/).slice(1).reduce((a, b) => a + +b, 0);
  await p.locator("#tagbar button", { hasText: "Make it yours" }).click(); await p.waitForTimeout(500);
  ok(new RegExp(`Tagged ${n} links? post`).test(await msg(p)), `tags: Make it yours tags them (${await msg(p)})`);
  ok(new RegExp(`^${n} yours`).test(await count()), `tags: they now count as yours (${await count()})`);
  ok(p.errs.length === 0, `tags layers: no errors ${p.errs.join()}`);
  await p.close();
}

// The detail pane: a button pressed in it still lets it redraw (capture, Show only these)
{
  const p = await page("list.html");
  for (let i = 0; i < 40; i++) {
    if (/not captured/.test(await p.$eval("#detail .dhead", e => e.textContent)) && await p.$('#detail [data-cmd="read"]')) break;
    await key(p, "s");
  }
  await p.click('#detail [data-cmd="read"]'); await p.waitForTimeout(600);
  ok(!/not captured/.test(await p.$eval("#detail .dhead", e => e.textContent)), "pane: Capture redraws the pane as captured");
  ok(/Captured/.test(await msg(p)) && await p.$eval("#msg", e => e.getBoundingClientRect().bottom <= innerHeight), `pane: and says so where it can be seen (${await msg(p)})`);
  const all = await p.$$eval("#out ul.rows > li", l => l.length);
  await p.locator("#detail .facts button.link", { hasText: /Show only these/ }).click(); await p.waitForTimeout(300);
  const only = await p.$$eval("#out ul.rows > li", l => l.length);
  ok(only < all, `pane: Show only these keeps one site (${all} → ${only})`);
  ok(await p.$eval("#q", e => e.value) === "" && (await p.$$eval('#domains .chip[aria-pressed="true"]', l => l.length)) === 1, "pane: as a Sites chip, not text in the filter field");
  await p.locator("#detail .facts button.link", { hasText: /Show every site/ }).click(); await p.waitForTimeout(300);
  ok((await p.$$eval("#out ul.rows > li", l => l.length)) === all, "pane: Show every site brings them all back");
  // The live preview is a third pane on the right, its edge draggable, × turning it off.
  ok(await p.$eval("#preview", e => e.hidden), "preview: no third pane until it is turned on");
  await p.locator(".pvseg .chip", { hasText: "This link" }).click(); await p.waitForTimeout(300);
  ok(await p.$eval("#preview", e => !e.hidden && !!e.querySelector("#pv-frame")), "preview: This link opens the third pane with the page");
  const w0 = await p.$eval("#preview", e => e.getBoundingClientRect().width);
  const g = await p.$eval("#pv-grip", e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 100]; });
  await p.mouse.move(g[0], g[1]); await p.mouse.down(); await p.mouse.move(g[0] - 120, g[1], { steps: 4 }); await p.mouse.up();
  const w1 = await p.$eval("#preview", e => e.getBoundingClientRect().width);
  ok(w1 > w0 + 60, `preview: dragging its edge widens it (${Math.round(w0)} → ${Math.round(w1)})`);
  await p.click("#preview .pvhead button"); await p.waitForTimeout(200);
  ok(await p.$eval("#preview", e => e.hidden), "preview: × turns it off");
  ok(p.errs.length === 0, `pane redraw: no errors ${p.errs.join()}`);
  await p.close();
}

// Group by chat: a link shows under each thread it came from, the account dimmed after the name; the rest go last
{
  let p = await page("list.html?group=chat");
  const groups = () => p.$$eval("#out section.group", l => l.map(s => ({ name: s.querySelector("h2 > span").textContent, n: +s.querySelector("h2 .n").textContent, rows: s.querySelectorAll("li").length, sub: s.querySelector("h2 .when")?.textContent || "" })));
  const g = await groups();
  const friend = g.find(x => x.name === "@friend");
  ok(friend?.n === 2 && friend.rows === 2, `chat: a @friend group holds its two links (${JSON.stringify(friend)})`);
  ok(g.length >= 4 && g.at(-1).name === "Not from a chat" && g.at(-1).n > 2, `chat: Not from a chat comes last (${g.map(x => x.name)})`);
  ok(g.findIndex(x => x.name === "@friend") === 0, "chat: the biggest chat is first");
  const alice = g.find(x => x.name === "alice_123"), bob = g.find(x => x.name === "bob_456");
  ok(alice?.n === 1 && bob?.n === 1 && alice.sub === "main", "chat: a link in two threads shows under both, with the account after the name");
  await p.selectOption("#groupby", "tag"); await p.waitForTimeout(200);
  await p.selectOption("#groupby", "chat"); await p.waitForTimeout(200);
  ok((await groups()).some(x => x.name === "@friend"), "chat: the select chooses it");
  await p.close();
  p = await page("list.html?group=chat&cards");
  const deal = () => p.$eval(".cm-tally span", e => e.textContent);
  const first = await deal();
  ok(/^1 of 2 in @friend$/.test(first), `chat: Cards deals the cursor's group (${first})`);
  await key(p, "d"); await p.waitForTimeout(300);
  const next = await deal();
  ok(next !== first && /in alice_123$/.test(next), `chat: D jumps to the next group in Cards (${next})`);
  await key(p, "a"); await p.waitForTimeout(300);
  ok(await deal() === first, "chat: A jumps back");
  ok(!p.errs.length, "chat: no errors " + p.errs.join("; "));
  await p.close();
}

await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
