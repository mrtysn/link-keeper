/* Run by test-preview-frames.zsh beside the real extension in headless Firefox: the Links detail
 * pane's live preview frames pages that forbid framing, and only Link Keeper's pages do. PORT is filled in by the runner. */
const BASE = `http://127.0.0.1:${PORT}`;
await new Promise(r => setTimeout(r, 500));   // the preview rule is registered as the background starts

await check("the Links detail pane frames pages that forbid framing: X-Frame-Options and frame-ancestors", async () => {
  // The Links page with its detail pane, where the live preview's frame lives.
  const tab = await browser.tabs.create({ url: browser.runtime.getURL("list.html?pane=1") });
  await new Promise(r => setTimeout(r, 2500));
  const view = browser.extension.getViews({ type: "tab", tabId: tab.id })[0];
  const got = [];
  view.addEventListener("message", e => got.push(e.data));
  for (const p of ["/plain", "/xfo", "/csp"]) {
    const f = view.document.createElement("iframe");
    // The preview's own sandbox (stash-cards.js previewBox).
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
    f.src = BASE + p;
    view.document.body.append(f);
  }
  for (let i = 0; i < 30 && got.length < 3; i++) await new Promise(r => setTimeout(r, 200));
  await browser.tabs.remove(tab.id);
  if (got.sort().join() !== "framed:/csp,framed:/plain,framed:/xfo") throw new Error(`framed only ${JSON.stringify(got)}`);
});

await check("an ordinary web page still cannot frame them", async () => {
  const tab = await browser.tabs.create({ url: `${BASE}/outer` });
  await new Promise(r => setTimeout(r, 2500));
  const { title } = await browser.tabs.get(tab.id);
  await browser.tabs.remove(tab.id);
  if (title !== "outer") throw new Error(`the framed page ran: title is ${title}`);
});
