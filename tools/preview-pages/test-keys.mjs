/* Drive List, Cards, Explore and Tag in the preview with the keys every page shares (link-keys.js)
 * and check each action and its undo lands: walking, groups and sections, keep and drop, remove,
 * move, to the reading list, the key list, and the tag field's Escape. Run by test-keys.zsh, which
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

// Explore
{
  const p = await page("stash-cards.html");
  const cur = () => p.$eval("#side button[aria-current]", e => e.textContent);
  const a = await cur(); await key(p, "2"); const b2 = await cur();
  ok(a !== b2, "explore: 2 walks the sidebar");
  await key(p, "1"); ok(await cur() === a, "explore: 1 walks back");
  await key(p, "s"); ok(await cur() === b2, "explore: S walks down, judging nothing");
  await key(p, "w"); ok(await cur() === a, "explore: W walks up");
  // find an undecided row: walk to Companion Link Report (no verdict)
  while (!(await cur()).includes("Companion")) await key(p, "2");
  await key(p, "e");
  ok(/Kept/.test(await msg(p)), "explore: E keeps (" + await msg(p) + ")");
  ok(!(await cur()).includes("Companion"), "explore: keep moves on");
  const keptNow = await p.$$eval("#side li", lis => lis.find(li => li.textContent.includes("Companion"))?.className);
  ok(/keep/.test(keptNow), "explore: row marked kept");
  await key(p, "Meta+z");
  ok(/Undone: keep/.test(await msg(p)), "explore: ⌘Z undoes (" + await msg(p) + ")");
  const after = await p.$$eval("#side li", lis => lis.find(li => li.textContent.includes("Companion"))?.className);
  ok(!/keep/.test(after), "explore: verdict cleared after undo");
  // remove + undo
  const rowsBefore = await p.$$eval("#side li", l => l.length);
  await key(p, "Meta+Backspace");
  ok(/Removed from/.test(await msg(p)), "explore: ⌘⌫ removes (" + await msg(p) + ")");
  ok(await p.$$eval("#side li", l => l.length) === rowsBefore - 1, "explore: one row fewer");
  await key(p, "Meta+z");
  ok(await p.$$eval("#side li", l => l.length) === rowsBefore, "explore: undo puts it back");
  // move + undo
  await key(p, "m");
  ok(!!(await p.$(".mover")), "explore: M opens the stash picker");
  await p.keyboard.type("aug"); await key(p, "Enter");
  ok(/Moved to/.test(await msg(p)), "explore: move (" + await msg(p) + ")");
  await key(p, "Meta+z");
  ok(/Undone: move/.test(await msg(p)), "explore: undo move (" + await msg(p) + ")");
  ok(!!(await p.$("#key-guide")), "guide: shown on a first visit");
  ok(await p.$eval('#key-guide [data-cmd="keep"]', e => e.textContent) === "Ekeep", "guide: E is labelled keep");
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => !e.classList.contains("idle")), "guide: P is live on Explore");
  await key(p, "Shift+?"); ok(!(await p.$("#key-guide")), "guide: ? hides it");
  await key(p, "Shift+?"); ok(!!(await p.$("#key-guide")), "guide: ? shows it again");
  await p.keyboard.down("s");
  ok(await p.$$eval("#key-guide .kc.down", l => l.map(k => k.firstChild.textContent).join()) === "S", "guide: only the key held is down (S, not 2)");
  await p.keyboard.up("s");
  ok(!(await p.$("#key-guide .kc.down")), "guide: let go, it rises");
  // A D: the first link of the next stash, then back to this one's start.
  const group = () => p.$eval("#side button[aria-current]", b => b.closest("ul").previousElementSibling?.textContent);
  const g0 = await group(); await key(p, "d"); const g1 = await group();
  ok(g0 !== g1, `explore: D jumps to the next stash (${g0} → ${g1})`);
  await key(p, "a"); ok(await group() === g0, "explore: A jumps back");
  ok(!(await p.$(".lk-pane-on")), "explore: no panes");
  // Keeps pressed faster than they are saved all land, and none is painted back by a reload.
  await p.click('.chip[data-f="open"]'); await p.waitForTimeout(200);
  const undecided = () => p.$$eval("#side li", l => l.length);
  const u0 = await undecided();
  for (let i = 0; i < 4; i++) await p.keyboard.press("e");
  await p.waitForTimeout(900);
  ok(await undecided() === u0 - 4, `explore: four quick keeps all stick (${u0} → ${await undecided()})`);
  ok(!p.errs.length, "explore: no errors " + p.errs.join("; "));
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
  ok(/Dropped|Cleared/.test(await msg(p)), "list: Q drops (" + await msg(p) + ")");
  ok((await cur()) !== c4, "list: cursor moved on");
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
  // to the reading list from section c (unlocked, web)
  await key(p, "d"); await key(p, "d"); await key(p, "2");
  const t = await cur();
  await key(p, "l"); ok(/reading list/.test(await msg(p)), `list: L on ${t} (${await msg(p)})`);
  await key(p, "Meta+z"); ok(/Undone/.test(await msg(p)), "list: undo to-list (" + await msg(p) + ")");
  ok(!p.errs.length, "list: no errors " + p.errs.join("; "));
  await p.close();
}
// Cards
{
  const p = await page("cards.html");
  const top = () => p.$eval(".card.top .title", e => e.textContent.slice(0, 40));
  const kept = () => p.$eval("#t-kept", e => e.textContent);
  const a = await top(); const k = await kept();
  await key(p, "e"); await p.waitForTimeout(250);
  ok((await top()) !== a && (await kept()) === String(+k + 1), `cards: E keeps (${k}→${await kept()})`);
  await key(p, "Meta+z"); await p.waitForTimeout(200);
  ok((await top()) === a && (await kept()) === k, "cards: undo brings it back");
  await key(p, "2"); await p.waitForTimeout(250);
  ok((await top()) !== a, "cards: 2 = later");
  await key(p, "Meta+z"); await p.waitForTimeout(200);
  ok((await top()) === a, "cards: undo later");
  const before = await top();
  await key(p, "d"); await p.waitForTimeout(200);
  ok((await top()) !== before, "cards: D deals from the next stash in the sidebar");
  ok(!p.errs.length, "cards: no errors " + p.errs.join("; "));
  await p.close();
}
// Tag
{
  const p = await page("tag.html");
  await key(p, "2");
  ok(!!(await p.$(".lk-cursor")), "tag: 2 places the cursor");
  await key(p, "t");
  ok(await p.evaluate(() => !!document.activeElement.closest(".lk-cursor .tagger")), "tag: T focuses the row's tag field");
  await key(p, "Escape");
  ok(await p.evaluate(() => document.activeElement === document.body), "tag: Esc leaves the field");
  await key(p, "q"); ok(/Dropped/.test(await msg(p)), "tag: Q drops (" + await msg(p) + ")");
  await key(p, "Meta+z"); ok(/Undone/.test(await msg(p)), "tag: undo");
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => e.classList.contains("idle")), "guide: P is faint where it does nothing");
  ok(!p.errs.length, "tag: no errors " + p.errs.join("; "));
  await p.close();
}
// Tags: the library, a tag's links, and the editor's palette
{
  const p = await page("tags.html");
  const names = () => p.$$eval("#lib li .t", l => l.map(e => e.textContent));
  ok((await names()).slice(0, 3).join() === "to-read,to-watch,to-try", "tags: presets listed first");
  const chosen = () => p.$eval("#lib [aria-current] .t", e => e.textContent);
  ok(await chosen() === "ai tools", "tags: opens on the first tag with links (" + await chosen() + ")");
  ok(await p.$$eval("#coll ul.rows > li", l => l.length) > 0, "tags: the chosen tag's links show");
  await key(p, "d"); ok(await chosen() !== "ai tools", "tags: D picks the next tag");
  await key(p, "a"); ok(await chosen() === "ai tools", "tags: A picks the previous one");
  const row = () => p.$eval("#coll .lk-cursor .ttl", e => e.textContent).catch(() => null);
  const r0 = await row(); await key(p, "s");
  ok(r0 && (await row()) !== r0, "tags: S walks the tag's links");
  await p.fill("#new-name", "Read Later"); await p.click("#new-hues button:nth-child(3)"); await p.click("#maker button.primary");
  await p.waitForTimeout(300);
  ok(await chosen() === "read later", "tags: Create makes the tag and opens it (" + await chosen() + ")");
  ok(await p.$eval("#lib [aria-current]", e => e.style.getPropertyValue("--h")) === "25", "tags: its colour is the one picked");
  await p.click(".coll-head .hues button:nth-child(6)"); await p.waitForTimeout(300);
  ok(await p.$eval("#lib [aria-current]", e => e.style.getPropertyValue("--h")) === "140", "tags: recolour");
  await p.click(".coll-head .tools button:not(.danger)");
  await p.fill(".coll-head input", "later"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  ok(await chosen() === "later" && !(await names()).includes("read later"), "tags: rename");
  await p.click(".coll-head .danger"); await p.click(".coll-head .danger"); await p.waitForTimeout(300);
  ok(!(await names()).includes("later"), "tags: Delete, clicked twice, removes it (" + await msg(p) + ")");
  ok(!p.errs.length, "tags: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const p = await page("stash-cards.html");
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
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
