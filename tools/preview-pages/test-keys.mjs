/* Drive List, Cards, Explore and Tag in the preview with the keys every page shares (link-keys.js)
 * and check each action and its undo lands: walking, groups and sections, capture, remove,
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
  // The four actions, and no judging.
  const cmds = await p.$$eval("#detail .lk-bar > button[data-cmd]", l => l.map(b => b.dataset.cmd).join());
  ok(cmds === "open,tags,read,remove", `explore: Open, Tags, Capture, Remove (${cmds})`);
  ok(!(await p.$('#detail [data-cmd="keep"], #detail [data-cmd="drop"]')), "explore: no Keep or Drop");
  ok(!(await p.$("#side li.keep, #side li.drop")), "explore: no ✓ or ✕ marks");
  while (!(await cur()).includes("Companion")) await key(p, "2");
  const rows0 = await p.$$eval("#side li", l => l.length);
  await key(p, "q");
  ok(/Removed from/.test(await msg(p)), "explore: Q removes this copy (" + await msg(p) + ")");
  ok(!(await cur()).includes("Companion") && await p.$$eval("#side li", l => l.length) === rows0 - 1, "explore: and moves on");
  await key(p, "Meta+z");
  ok(await p.$$eval("#side li", l => l.length) === rows0, "explore: ⌘Z puts it back (" + await msg(p) + ")");
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
  ok(await p.$$eval('#key-guide .kc[data-cmd="read"]', l => l.map(e => e.textContent).includes("Ecapture")), "guide: E is labelled capture");
  ok(await p.$eval('#key-guide .kc[data-cmd="remove"]', e => e.textContent) === "Qremove", "guide: Q is labelled remove");
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => !e.classList.contains("idle")), "guide: P is live on Explore");
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
  const group = () => p.$eval("#side button[aria-current]", b => b.closest("ul").previousElementSibling?.textContent);
  const g0 = await group(); await key(p, "d"); const g1 = await group();
  ok(g0 !== g1, `explore: D jumps to the next stash (${g0} → ${g1})`);
  await key(p, "a"); ok(await group() === g0, "explore: A jumps back");
  ok(!(await p.$(".lk-pane-on")), "explore: no panes");
  // The Not captured chip shows only links whose text is not saved.
  await p.click('.chip[data-f="uncaptured"]'); await p.waitForTimeout(200);
  ok(await p.$$eval("#side li", l => l.length > 0 && l.every(li => !li.querySelector(".rd.on"))), "explore: Not captured shows uncaptured links only");
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
  const removed = () => p.$eval("#t-removed", e => e.textContent);
  const skipped = () => p.$eval("#t-skipped", e => e.textContent);
  // The deck is shuffled, and a locked stash refuses: skip to a card that can be removed.
  let a = await top();
  for (let i = 0; i < 12; i++) {
    await key(p, "q"); await p.waitForTimeout(300);
    if (!/locked/.test(await msg(p))) break;
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
// Tagging one link after another, from any page: Explore's Untagged chip, T, Enter on an empty field
{
  const p = await page("stash-cards.html");
  await p.click('.chip[data-f="untagged"]'); await p.waitForTimeout(200);
  const n0 = await p.$$eval("#side li", l => l.length);
  ok(n0 > 0, `untagged: the chip narrows Explore to links with no tags (${n0})`);
  const cur = () => p.$eval("#side button[aria-current]", e => e.textContent);
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
  ok(await p.$eval('#key-guide [data-cmd="preview"]', e => e.classList.contains("idle")), "guide: P is faint where it does nothing");
  ok(!(await p.$('.app-pages a[href="tag.html"]')), "nav: no Untagged page");
  ok(await p.$$eval(".src.own", l => l.length) > 0, "icons: a site's saved icon is drawn in place of the made-up one");
  // List's editor is a popover: Enter on it empty closes it and opens the next row's.
  const cur = () => p.$eval(".lk-cursor .ttl", e => e.textContent).catch(() => null);
  await key(p, "s"); const r0 = await cur();
  await key(p, "t");
  ok(!!(await p.$(".tagpop .tagger input")), "untagged: T opens List's tag popover");
  await key(p, "Enter"); await p.waitForTimeout(250);
  ok((await cur()) !== r0 && !!(await p.$(".tagpop .tagger input")), "untagged: Enter on it empty opens the next row's");
  ok(await p.evaluate(() => !!document.activeElement.closest(".tagpop")), "untagged: with the keyboard in it");
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
// Hover previews (peek.js)
{
  const p = await page("stash-cards.html");
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
  await p.hover("#side h2[data-peek]"); await p.waitForTimeout(500);
  ok(/Explore this stash/.test(await peek() || ""), "peek: a sidebar stash heading previews the stash");
  await p.mouse.move(5, 5); await p.waitForTimeout(400);
  ok(!(await peek()), "peek: leaving closes it");
  await p.hover("#side li:nth-child(2) button"); await p.waitForTimeout(500);
  ok(!!(await peek()), "peek: a sidebar link previews the link");
  // A long stash: every tab listed, scrolled to the chosen one.
  await p.mouse.move(2, 2); await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll("#side h2[data-peek]")].at(-1).nextElementSibling.lastElementChild.querySelector("button").click());
  await p.waitForTimeout(300);
  const heads = await p.$$("#side h2[data-peek]");
  await heads[heads.length - 1].hover(); await p.waitForTimeout(500);
  const sc = await p.evaluate(() => { const l = document.querySelector(".peek .pk-rows"), h = l?.querySelector("li.here"); return { n: l?.children.length, seen: !!h && h.offsetTop >= l.scrollTop && h.offsetTop + h.offsetHeight <= l.scrollTop + l.clientHeight, scrolls: l && l.scrollHeight > l.clientHeight }; });
  ok(sc.n === 28 && sc.scrolls, `peek: a stash lists every tab, scrolling (${sc.n})`);
  ok(sc.seen, "peek: and opens scrolled to the chosen link");
  ok(!p.errs.length, "peek explore: no errors " + p.errs.join("; "));
  await p.close();
}
{
  const p = await page("list.html");
  const peek = () => p.$eval(".peek", e => e.textContent).catch(() => null);
  await p.hover('[data-peek^="site:"]'); await p.waitForTimeout(500);
  ok(/links? shown/.test(await peek() || ""), "peek: a site chip previews its links");
  await p.mouse.move(5, 5); await p.waitForTimeout(400);
  await p.hover('.rows [data-peek^="tag:"]'); await p.waitForTimeout(500);
  ok(/Open in Tags/.test(await peek() || ""), "peek: a tag chip previews the tag");
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
  ok((await places()).every(t => /tabs?$|^Reading list$/.test(t)), `popup: each stash as day and tab count (${(await places()).join(", ")})`);
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
  const p = await page("popup.html?tab=new");
  ok(/not saved yet/.test(await p.$eval("#where", e => e.textContent)), "popup: a new page says it is not saved");
  ok(await p.$eval("#queue", e => e.classList.contains("primary")), "popup: + List is the filled next step");
  ok(await p.$eval("#queue", e => !e.hidden) && await p.$eval("#stash-tab", e => !e.hidden) && await p.$eval("#remove", e => e.hidden), "popup: and offers + List and Stash tab, no Remove");
  await p.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
