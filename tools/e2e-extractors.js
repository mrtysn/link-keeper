/* Run by test-extractors.zsh beside the real extension in headless Firefox: x.com captures hold every
 * rendered reply, and a page walk gathers the ones x.com drops while scrolling; a GitHub repo capture holds its README. PORT is filled in by
 * the runner; the pages are tools/extractor-fixtures/. */
const BASE = `http://127.0.0.1:${PORT}/somehandle/status`;
const FLAT = `${BASE}/2009295329057702081`;
const VIRTUAL = `${BASE}/2009295329057702082`;
const DISCOVER = `${BASE}/2009295329057702083`;
const VIRTUAL_DISCOVER = `${BASE}/2009295329057702084`;
const GITHUB_REPO = `http://127.0.0.1:${PORT}/slopus/happy-cli`;
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const loaded = async (url, ready = 'article[data-testid="tweet"]') => {
  const tab = await browser.tabs.create({ url, active: true });
  // A new tab reports "complete" for its initial about:blank before the navigation starts, and
  // scripting into it is then refused; wait until the tab is on the page asked for and loaded.
  for (let waited = 0; waited < 20000; waited += 100) {
    const now = await browser.tabs.get(tab.id);
    if (now.url === url && now.status === "complete") break;
    await new Promise(r => setTimeout(r, 100));
  }
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["extractors.js"] });
  // The virtualised pages draw their articles from the viewport's height, which a fresh headless
  // tab can report as zero for a moment; wait until a post is in the document.
  for (let waited = 0; waited < 10000; waited += 100) {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId: tab.id }, func: sel => !!document.querySelector(sel), args: [ready],
    });
    if (result) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return tab;
};
const extract = async tab => (await browser.scripting.executeScript({
  target: { tabId: tab.id }, func: () => LK.extract("x.com"),
}))[0].result;
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const pick = r => ({ replies: r.replies, reposts: r.reposts, likes: r.likes, views: r.views });
let flat;
await check("a capture holds one entry per reply, not the post", async () => {
  const tab = await loaded(FLAT);
  flat = await extract(tab);
  await browser.tabs.remove(tab.id);
  eq(flat.replies.map(r => r.handle), ["@somehandle", "@fan1", "@fan2", "@fan3"], "reply handles");
  eq(flat.replies_scanned, 4, "replies_scanned");
  eq(flat.text, "A thread about a tool I built. Repo in the comments.", "the post's own text");
});

await check("a reply carries its name, text, time, address and author flag", async () => {
  const [own, fan1] = flat.replies;
  eq([own.name, own.self, own.posted], ["Some One", true, "2026-08-09T14:52:00.000Z"], "author's reply");
  eq(own.url.replace(/^http:\/\/[^/]+/, ""), "/somehandle/status/2009295999999999901", "the address drops the query");
  eq([fan1.name, fan1.self], ["Fan One", false], "another reply");
  eq(fan1.text, "Nice 🔥 build", "emoji come back as characters");
});

await check("reply text keeps its line breaks and is not cut", async () => {
  eq(flat.replies[2].text, "Same repo\nsecond line: github.com/a/b", "multi-line text");
});

await check("counts come from the buttons, the views link and the group label", async () => {
  eq(pick(flat.replies[0]), { replies: 1, reposts: 4, likes: 30, views: 2400 }, "author's reply counts");
  eq(pick(flat.replies[1]), { replies: 0, reposts: 0, likes: 1200, views: 12000 }, "zero counts and abbreviations");
  eq(pick(flat.replies[3]), { replies: 2, reposts: 1, likes: 7, views: 90 }, "group label alone");
  eq(pick(flat.replies[2]), { replies: null, reposts: null, likes: null, views: null }, "nothing exposed");
});

await check("images are rewritten to the original size, and a video keeps its poster", async () => {
  eq(flat.replies[1].images, ["https://pbs.twimg.com/media/AAAA?format=jpg&name=orig", "https://pbs.twimg.com/media/BBBB?format=png&name=orig"], "images");
  eq([flat.replies[1].video, flat.replies[1].video_posters], [false, []], "no video");
  eq([flat.replies[2].video, flat.replies[2].video_posters, flat.replies[2].images],
    [true, ["https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/poster.jpg"], []], "video");
  eq([flat.replies[3].text, flat.replies[3].images], [null, ["https://pbs.twimg.com/media/CCCC?format=jpg&name=orig"]], "media-only reply");
});

await check("a reply's links leave out in-app navigation", async () => {
  eq(flat.replies[0].links.map(l => l.href), ["https://t.co/repo1", "https://t.co/docs"], "links of the author's reply");
  eq(flat.replies[2].links.map(l => l.href), ["https://t.co/repo1"], "links of a repeat");
});

await check("reply_links and replies_scanned keep their shape: deduped, the author's first, with context", async () => {
  eq(flat.reply_links.map(l => [l.href, l.from, l.self]), [["https://t.co/repo1", "@somehandle", true], ["https://t.co/docs", "@somehandle", true]], "reply_links");
  eq(Object.keys(flat.reply_links[0]).sort(), ["context", "display", "from", "href", "resolved", "self"], "link fields");
  eq(flat.reply_links[0].context, "Repo: github.com/a/b and docs a.dev/docs thanks to @fan1", "context");
});

let plain;
await check("a plain read of a virtualised page holds only the replies on screen", async () => {
  const tab = await loaded(VIRTUAL);
  plain = await extract(tab);
  await browser.tabs.remove(tab.id);
  if (!plain.replies.length || plain.replies.length >= 14) throw new Error(`${plain.replies.length} replies on screen`);
});

await check("Capture with a screenshot collects every reply the walk rendered, once each", async () => {
  const tab = await loaded(VIRTUAL);
  // The page is on 127.0.0.1, not x.com, so the injected extraction is told which site to read it as.
  // Reading pixels needs the all-sites permission, which only a click grants; each tile is a 1x1 PNG instead.
  const real = { runExtractor, captureVisibleTab: browser.tabs.captureVisibleTab };
  runExtractor = async function () { return LK.extract("x.com"); };
  browser.tabs.captureVisibleTab = async () => PIXEL;
  let res;
  try {
    res = await captureActive("", true);
  } finally {
    runExtractor = real.runExtractor;
    browser.tabs.captureVisibleTab = real.captureVisibleTab;
    await browser.tabs.remove(tab.id);
  }
  if (!res.ok) throw new Error(JSON.stringify(res));
  const r = res.record;
  const texts = r.replies.map(x => x.text);
  eq(texts, Array.from({ length: 14 }, (_, i) => `reply number ${i + 1}${i === 13 ? " repo.dev/final" : ""}`), "replies in page order");
  eq(new Set(r.replies.map(x => x.url)).size, 14, "distinct addresses");
  eq(r.replies_scanned, 14, "replies_scanned");
  eq(r.replies.filter(x => x.self).map(x => x.handle), ["@somehandle"], "the author's reply, found after the post scrolled away");
  eq(r.reply_links.map(l => [l.href, l.self]), [["https://repo.dev/final", true]], "reply_links from the walk");
  eq(r.replies[13].links[0].resolved, "https://repo.dev/final", "the reply's own link carries what was resolved");
  report("     walk saw", r.replies.length, "replies; plain read saw", plain.replies.length, "; screenshot:", r.screenshot ? `${r.screenshot.tiles} tiles` : r.screenshot_error);
});

/* The recommendation section under a thread ("Discover more") uses the same article elements as the
 * replies, and none of its posts may reach `replies`, `reply_links` or `replies_scanned`. */
const RECOMMENDED = /stranger|recommended post|elsewhere\.dev/i;
const noRecommended = (r, what) => {
  const leaked = [...r.replies.map(x => `${x.handle} ${x.text}`), ...r.reply_links.map(l => `${l.from} ${l.href}`)]
    .filter(s => RECOMMENDED.test(s));
  if (leaked.length) throw new Error(`${what}: recommended posts among the replies: ${JSON.stringify(leaked)}`);
  eq(r.replies_scanned, r.replies.length, `${what}: replies_scanned`);
};

await check("a capture stops at the Discover more heading: recommended posts are not replies", async () => {
  const tab = await loaded(DISCOVER);
  const r = await extract(tab);
  await browser.tabs.remove(tab.id);
  eq(r.text, "A short thread. Repo in the comments.", "the post's own text");
  eq(r.replies.map(x => x.handle), ["@somehandle", "@fan1"], "reply handles");
  eq(r.replies_scanned, 2, "replies_scanned");
  eq(r.reply_links.map(l => [l.href, l.self]), [["https://t.co/mine", true]], "reply_links");
  noRecommended(r, "plain read");
});

await check("a plain read above the heading holds replies only", async () => {
  const tab = await loaded(VIRTUAL_DISCOVER);
  const r = await extract(tab);
  await browser.tabs.remove(tab.id);
  if (!r.replies.length) throw new Error("no replies on screen");
  noRecommended(r, "plain read at the top");
});

await check("a screenshot walk ignores everything after a heading that appears only once scrolled to", async () => {
  const tab = await loaded(VIRTUAL_DISCOVER);
  const real = { runExtractor, captureVisibleTab: browser.tabs.captureVisibleTab };
  runExtractor = async function () { return LK.extract("x.com"); };
  browser.tabs.captureVisibleTab = async () => PIXEL;
  let res;
  try {
    res = await captureActive("", true);
  } finally {
    runExtractor = real.runExtractor;
    browser.tabs.captureVisibleTab = real.captureVisibleTab;
    await browser.tabs.remove(tab.id);
  }
  if (!res.ok) throw new Error(JSON.stringify(res));
  const r = res.record;
  eq(r.replies.map(x => x.text), Array.from({ length: 8 }, (_, i) => `reply number ${i + 1}${i === 7 ? " repo.dev/mine" : ""}`), "replies in page order");
  eq(r.replies_scanned, 8, "replies_scanned");
  eq(r.reply_links.map(l => [l.href, l.self]), [["https://repo.dev/mine", true]], "reply_links from the walk");
  noRecommended(r, "walk");
});

await check("a GitHub repo in the 2026 layout: its About text, then its README, its links and its stars", async () => {
  const tab = await loaded(GITHUB_REPO, "article.markdown-body");
  const r = (await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => LK.extract("github.com") }))[0].result;
  await browser.tabs.remove(tab.id);
  eq([r.kind, r.title, r.author.handle, r.stars], ["repo", "slopus/happy-cli", "slopus", "553"], "kind, title, owner, stars");
  if (!r.text.startsWith("Happy Coder CLI to connect your local Claude Code to mobile device\n\n")) throw new Error(`text starts ${JSON.stringify(r.text.slice(0, 120))}`);
  for (const want of ["npm install -g happy-coder", "happy gemini"]) if (!r.text.includes(want)) throw new Error(`README text lacks ${want}`);
  if (r.text.length > 6100) throw new Error(`text is ${r.text.length} characters`);
  eq(r.links.map(l => l.href).slice(0, 3), ["https://github.com/slopus/happy", "https://api.cluster-fluster.com/", "https://app.happy.engineering/"], "README links, no in-page anchors");
});

const plainPage = async path => {
  const tab = await loaded(`http://127.0.0.1:${PORT}${path}`, "h1");
  const r = (await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => LK.extract("plain.example") }))[0].result;
  await browser.tabs.remove(tab.id);
  return r;
};
const has = (text, want, what) => { for (const w of want) if (!text.includes(w)) throw new Error(`${what} lacks ${JSON.stringify(w)}: ${JSON.stringify(text.slice(0, 300))}`); };
const lacks = (text, unwanted, what) => { for (const w of unwanted) if (text.includes(w)) throw new Error(`${what} holds ${JSON.stringify(w)}`); };

await check("a plain page with no description is kept by its own text: a Wikipedia article without its boxes, edit links and references", async () => {
  const r = await plainPage("/wiki/Suspension_bridge");
  if (!r.text.startsWith("A suspension bridge is a type of bridge")) throw new Error(`text starts ${JSON.stringify(r.text.slice(0, 80))}`);
  has(r.text, ["Structure\n", "The main cables", "• Main cables\n• Towers"], "text");
  lacks(r.text, ["[1]", "[edit]", "Infobox", "Navbox", "Reference text", "Footer", "Random article"], "text");
  eq(r.links.map(l => l.href), ["https://www.britannica.com/technology/suspension-bridge"], "links to other sites only");
});

await check("a blog post: its description, then the post's own text and code, without its title, share bar, sidebar, newsletter or comments", async () => {
  const r = await plainPage("/blog/rewrote-build");
  if (!r.text.startsWith("A short story about a long Makefile.\n\nFor three years")) throw new Error(`text starts ${JSON.stringify(r.text.slice(0, 120))}`);
  has(r.text, ["nine hundred lines", 'build() {\n  print -- "building $1"\n}', "a third of the size"], "text");
  lacks(r.text, ["Share on", "Sidebar paragraph", "Subscribe", "A comment", "©"], "text");
  eq(r.links.map(l => l.href), ["https://github.com/example/difftool"], "links");
});

await check("a docs page with no article or main: the block holding its paragraphs, not the menu or a hidden menu", async () => {
  const r = await plainPage("/docs/getting-started");
  has(r.text, ["Install the tool", "Run tool init."], "text");
  lacks(r.text, ["Hidden mobile menu", "Configure", "First run\nFirst run"], "text");
});

const igPage = async path => {
  const tab = await loaded(`http://127.0.0.1:${PORT}${path}`, "video");
  const r = (await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => LK.extract("www.instagram.com") }))[0].result;
  await browser.tabs.remove(tab.id);
  return r;
};

await check("an Instagram reel: its caption, author, posted day, counts and cover from its preview tags, under /reel/ID/", async () => {
  const r = await igPage("/reel/DedGyALCUWi/");
  eq([r.kind, r.url, r.author, r.posted, r.likes, r.comments],
    ["reel", "https://www.instagram.com/reel/DedGyALCUWi/", { handle: "gittrend.io", name: "Trending OpenSource Projects" }, "2026-10-13", "998", "167"], "fields");
  eq(r.title, "Gumroad's own code is open — run your own online store and sell straight to your buyers. More like t", "title: the caption's first line, cut at 100");
  if (!r.text.startsWith("Gumroad's own code is open") || !r.text.endsWith("#webdev")) throw new Error(`text ${JSON.stringify(r.text)}`);
  if (!/^https:\/\/scontent\.cdninstagram\.com\//.test(r.images[0])) throw new Error(`images ${JSON.stringify(r.images)}`);
});

await check("...the same from the reels feed", async () => {
  eq((await igPage("/reels/DedGyALCUWi/")).url, "https://www.instagram.com/reel/DedGyALCUWi/", "url");
});

await check("...and nothing while the tags still name another post", async () => {
  eq(await igPage("/reel/SomeOtherReel/"), null, "a stale page");
});

await check("a capture made on a page says so on the page: a toast that reads captured, or failed with the reason", async () => {
  const tab = await loaded(`http://127.0.0.1:${PORT}/blog/rewrote-build`, "h1");
  const state = async () => (await browser.scripting.executeScript({ target: { tabId: tab.id },
    func: () => document.getElementById("link-keeper-toast")?.dataset.state || null }))[0].result;
  try {
    await confirmCapture(await captureActive());
    eq(await state(), "captured", "after a capture");
    await confirmCapture({ ok: false, error: "could not read that page" });
    eq(await state(), "failed", "after a failed one, replacing the first");
    await handleMessage({ type: "capture-active", note: "" });
    for (let i = 0; i < 20 && await state() !== "captured"; i++) await new Promise(r => setTimeout(r, 50));
    eq(await state(), "captured", "after the popup's capture button");
  } finally {
    await browser.tabs.remove(tab.id);
  }
});

/* --- walls and the capture queue ---------------------------------------------------- */

const at = path => `http://127.0.0.1:${PORT}${path}`;
const wallOf = async path => {
  const tab = await loaded(at(path), "h1");
  const r = (await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => LK.wall() }))[0].result;
  await browser.tabs.remove(tab.id);
  return r;
};

await check("a wall is told from a page: a login redirect and a Cloudflare challenge are walls, an article is not", async () => {
  eq((await wallOf("/reel/Walled/"))?.kind, "login", "redirected to a login page");
  eq((await wallOf("/cdn-cgi/challenge"))?.kind, "captcha", "a challenge page");
  for (const path of ["/blog/rewrote-build", "/wiki/Suspension_bridge", "/docs/getting-started"]) eq(await wallOf(path), null, path);
});

await check("a capture of a link behind a wall is refused, says why, and stores nothing", async () => {
  const before = (await getCaptures()).length;
  const res = await captureUrl(at("/reel/Walled/"));
  eq([res.ok, res.wall], [false, "login"], `refused as a login (${res.error})`);
  if (!/asked to log in/.test(res.error)) throw new Error(`error ${JSON.stringify(res.error)}`);
  eq((await getCaptures()).length, before, "captures");
});

await check("a capture out of sight waits for an app to draw its text, and keeps all of it", async () => {
  const res = await captureUrl(at("/app/late"));
  if (!res.ok) throw new Error(res.error);
  if (!/patient reader waits/.test(res.record.text || "")) throw new Error(`text ${JSON.stringify(res.record.text)}`);
});

await check("an app or listing with no paragraphs is kept by its visible text, without its menu and footer", async () => {
  const res = await captureUrl(at("/app/listing"));
  if (!res.ok) throw new Error(res.error);
  has(res.record.text || "", ["Hollow Lantern", "Squad Weapon Skins", "free until Thursday"], "text");
  lacks(res.record.text || "", ["Sign in", "Privacy"], "text");
});

const queueDone = async () => {
  for (let waited = 0; waited < 60000; waited += 250) {
    const s = await handleMessage({ type: "capture-queue-status" });
    if (!["running", "paused"].includes(s.status)) return s;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("the capture queue never finished");
};

await check("the capture queue reads each link in a minimised window of its own, then closes it", async () => {
  const windowsBefore = (await browser.windows.getAll()).length;
  const urls = ["/wiki/Suspension_bridge", "/docs/getting-started"].map(at);
  const started = await handleMessage({ type: "capture-queue-start", urls });
  eq([started.ok, started.added], [true, 2], "started");
  let sawWindow = false;
  for (let i = 0; i < 40 && !sawWindow; i++) {
    sawWindow = (await browser.windows.getAll()).some(w => w.state === "minimized");
    if (!sawWindow) await new Promise(r => setTimeout(r, 100));
  }
  if (!sawWindow) throw new Error("no minimised window while capturing");
  const s = await queueDone();
  eq([s.status, s.captured, s.failed.length], ["done", 2, 0], `status, captured, failed (${JSON.stringify(s.failed)})`);
  const keys = new Set((await getCaptures()).map(c => keyOf(c.url)));
  for (const u of urls) if (!keys.has(keyOf(u))) throw new Error(`${u} not captured`);
  eq((await browser.windows.getAll()).length, windowsBefore, "windows after");
  await handleMessage({ type: "capture-queue-dismiss" });
});

await check("a wall in the queue stops its site: the site's other links are set aside, not loaded", async () => {
  const urls = ["/reel/Walled/", "/blog/rewrote-build"].map(at);
  await handleMessage({ type: "capture-queue-start", urls });
  const s = await queueDone();
  eq(s.failed.map(f => f.url), urls, "failed");
  if (!/^not tried: /.test(s.failed[1].error)) throw new Error(`second error ${JSON.stringify(s.failed[1].error)}`);
  eq(Object.keys(s.stoppedSites), ["127.0.0.1"], "stopped sites");
  await handleMessage({ type: "capture-queue-dismiss" });
});
