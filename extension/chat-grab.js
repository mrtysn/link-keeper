/* Reads the links out of a direct-message chat open in the page: x.com Chat (end-to-end encrypted, so
 * only the page itself ever holds the text) and Instagram's direct threads.
 *
 * Injected by background.js (scripting.executeScript, files) and then driven through window.LKChat:
 *   LKChat.info()        which chat this is and whether it can be read, or null when the page is no chat;
 *   LKChat.grab(range)   collect every message in the range, loading older ones as needed, and return
 *                        them with their links, sender and time.
 *
 * Both sites draw only the few messages on screen, and x.com keeps every programmatic scroll pinned to
 * the bottom, so the readers do not read the screen: they read the page's own message objects (React's
 * props, reached through wrappedJSObject), which hold exact times, senders and real URLs. What each
 * site exposes is written up in docs/chat-pages/. Each site is one reader in READERS; the loop that
 * loads older messages until the range is covered is shared. Nothing here throws on a missing field:
 * a redesign should cost the field it touched.
 */

window.LKChat = window.LKChat || (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Page objects, read through the Xray waiver in a Firefox content script; plain objects elsewhere.
  const page = o => (o && o.wrappedJSObject) || o;
  const fiberOf = el => {
    const w = page(el);
    if (!w) return null;
    const k = Object.keys(w).find(k => k.startsWith("__reactFiber$"));
    return k ? w[k] : null;
  };
  const list = l => {
    if (!l) return [];
    if (Array.isArray(l)) return l;
    try { return typeof l.toArray === "function" ? Array.from(l.toArray()) : Array.from(l); } catch (e) { return []; }
  };
  const str = v => (typeof v === "string" ? v : v == null ? null : String(v));
  const tryGet = fn => { try { return fn(); } catch (e) { return undefined; } };

  /* --- x.com Chat ------------------------------------------------------------------------------- */

  const X = {
    label: "X",
    match: loc => /^(www\.)?(x|twitter)\.com$/.test(loc.hostname) && /^\/i\/chat\/[^/]+/.test(loc.pathname),
    root: () => document.querySelector('[data-testid="xchatEmbedRoute"]')?.shadowRoot || null,
    scroller: () => X.root()?.querySelector('[data-testid="dm-message-scroller"]') || null,
    // The list component: the first fiber above the scroller that is handed chatItems. React keeps two
    // copies of a fiber (current and alternate); the one with the longer list is the newer.
    fiber() {
      for (let f = fiberOf(X.scroller()), i = 0; f && i < 12; f = f.return, i++) {
        if (!f.memoizedProps?.chatItems) continue;
        const alt = f.alternate;
        return alt?.memoizedProps?.chatItems && list(alt.memoizedProps.chatItems).length > list(f.memoizedProps.chatItems).length ? alt : f;
      }
      return null;
    },
    state: () => tryGet(() => X.fiber()?.memoizedProps?.component?.state?.state) || null,
    thread() {
      const id = location.pathname.split("/")[3] || null;
      const other = tryGet(() => X.state()?.toolbarState?.otherParticipant?.user);
      const screen = str(tryGet(() => other?.screenName));
      return { id, name: str(tryGet(() => other?.name)) || str(tryGet(() => X.state()?.toolbarState?.title)), handle: screen ? `@${screen}` : null };
    },
    ready: () => !!X.fiber(),
    items() {
      const fromProps = list(X.fiber()?.memoizedProps?.chatItems);
      const fromState = list(tryGet(() => X.state()?.chatItems?.items));
      return fromState.length > fromProps.length ? fromState : fromProps;
    },
    hasOlder: () => !!tryGet(() => X.state()?.chatItems?.hasOlderItems),
    loading: () => !!tryGet(() => X.state()?.chatItems?.isLoading),
    // The page asks for older messages when its list reaches the top: a callback the list component
    // keeps in a hook, which sends ScrolledToTop. Found by what it sends, not by its hook's position.
    loadOlder() {
      for (let h = X.fiber()?.memoizedState, i = 0; h && i < 80; h = h.next, i++) {
        for (const cand of [h.memoizedState, tryGet(() => h.memoizedState?.current)]) {
          if (typeof cand !== "function") continue;
          if (!/ScrolledToTop/.test(tryGet(() => Function.prototype.toString.call(cand)) || "")) continue;
          cand();
          return true;
        }
      }
      return false;
    },
    message(it) {
      const id = str(tryGet(() => it.id));
      if (!id || id.startsWith("dateBoundary-")) return null;
      const created = tryGet(() => it.created);
      const at = created ? Number(created.epochSeconds) * 1000 + Math.floor(Number(created.nanosecondsOfSecond || 0) / 1e6) : null;
      const screen = str(tryGet(() => it.senderInfo?.user?.screenName));
      const links = [];
      for (const a of list(tryGet(() => it.attachments)).concat(tryGet(() => it.attachment) || [])) X.attachment(a, links);
      // Plain text: entities if they carry the real address, else the URLs written in it.
      for (const u of list(tryGet(() => it.textEntities?.urls))) {
        const url = str(tryGet(() => u.expandedUrl)) || str(tryGet(() => u.url));
        if (url) links.push({ url, kind: X.isPost(url) ? "tweet" : "page" });
      }
      const text = str(tryGet(() => it.fullText)) || str(tryGet(() => it.textContent)) || "";
      for (const url of text.match(/https?:\/\/[^\s<>"')\]]+/g) || []) links.push({ url, kind: X.isPost(url) ? "tweet" : "page" });
      return { key: id, at: Number.isFinite(at) ? at : null, mine: !!tryGet(() => it.alignsToViewerSide), sender: screen ? `@${screen}` : null, links: dedupe(links) };
    },
    isPost: url => /^https:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url),
    // One post, one address: x.com, without /video/1, /photo/1 or share parameters.
    postUrl(url) {
      const m = url.match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
      return m ? `https://x.com/${m[1]}/status/${m[2]}` : url;
    },
    attachment(a, links) {
      if (!a) return;
      const open = str(tryGet(() => a.urlToOpen)) || str(tryGet(() => a.source?.urlToOpen));
      if (open) {
        links.push({ url: open, kind: X.isPost(open) ? "tweet" : "page", title: str(tryGet(() => a.displayTitle)) || null });
        return;
      }
      const url = str(tryGet(() => a.url));
      if (!url || !X.isPost(url)) return;
      const post = tryGet(() => a.postState?.post);
      const rec = { url: X.postUrl(url), kind: "tweet" };
      if (post) {
        const author = tryGet(() => post.author);
        rec.author = { name: str(tryGet(() => author?.name)), handle: tryGet(() => author?.screenName) ? `@${author.screenName}` : null };
        rec.text = str(tryGet(() => post.text));
        const made = tryGet(() => post.createdAt);
        if (made) rec.posted = new Date(Number(made.epochSeconds) * 1000).toISOString();
        // The post's own links, with their real addresses, and the post it quotes.
        const inner = list(tryGet(() => post.entityList?.urls)).map(u => str(tryGet(() => u.expandedUrl))).filter(Boolean);
        const quoted = str(tryGet(() => post.displayQuotedPost?.url));
        if (quoted) inner.push(X.isPost(quoted) ? X.postUrl(quoted) : quoted);
        if (inner.length) rec.links = inner;
      }
      links.push(rec);
    },
  };

  /* --- Instagram direct ------------------------------------------------------------------------- */

  // Waits on the second page survey (docs/chat-pages/instagram-survey-2026-10-15.md has the first):
  // where the thread's loaded messages sit as one list.
  const INSTAGRAM = {
    label: "Instagram",
    match: loc => /^(www\.)?instagram\.com$/.test(loc.hostname) && /^\/direct\/t\/[^/]+/.test(loc.pathname),
    thread: () => ({ id: location.pathname.split("/")[3] || null, name: null, handle: null }),
    ready: () => false,
    notYet: "Instagram chats cannot be read yet",
  };

  const READERS = { x: X, instagram: INSTAGRAM };

  function dedupe(links) {
    const seen = new Map();
    for (const l of links) if (l.url && !seen.has(l.url)) seen.set(l.url, l);
    return [...seen.values()];
  }

  const readerHere = () => Object.entries(READERS).find(([, r]) => r.match(location)) || null;

  function info() {
    const found = readerHere();
    if (!found) return null;
    const [platform, r] = found;
    const ready = !!tryGet(() => r.ready());
    return { platform, site: r.label, thread: tryGet(() => r.thread()) || null, ready, locked: !ready && !r.notYet, notYet: r.notYet || null };
  }

  /* range: { mode: "last", n } | { mode: "since", since (ms) } | { mode: "after", after (ms) } | { mode: "all" }
   * Returns { messages (oldest first), reachedStart, loads, timedOut }. */
  async function grab(range, { maxLoads = 2000, maxMs = 15 * 60_000 } = {}) {
    const found = readerHere();
    if (!found) return { ok: false, error: "this page is not a chat Link Keeper can read" };
    const [, r] = found;
    if (r.notYet) return { ok: false, error: r.notYet };
    if (!r.ready()) return { ok: false, error: "the chat's messages are not on the page: open the chat, enter your passcode if asked, and wait for it to load" };

    const read = () => r.items().map(it => tryGet(() => r.message(it))).filter(Boolean);
    let messages = read();
    const oldest = () => Math.min(...messages.map(m => m.at).filter(Number.isFinite));
    const enough = () => {
      if (range.mode === "last") return messages.length >= range.n;
      if (range.mode === "since") return oldest() < range.since;
      if (range.mode === "after") return oldest() <= range.after;
      return false;
    };

    const started = Date.now();
    let loads = 0, reachedStart = false;
    while (!enough() && loads < maxLoads && Date.now() - started < maxMs) {
      if (!r.hasOlder()) { reachedStart = true; break; }
      const before = r.items().length;
      if (!r.loadOlder()) break;
      loads++;
      // Wait for the page to fetch and decrypt the next page of messages.
      const end = Date.now() + 20_000;
      while (Date.now() < end && r.items().length === before) await sleep(250);
      while (Date.now() < end && r.loading()) await sleep(250);
      if (r.items().length === before) { reachedStart = !r.hasOlder(); break; }
      messages = read();
    }

    messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (range.mode === "last") messages = messages.slice(-range.n);
    if (range.mode === "since") messages = messages.filter(m => !Number.isFinite(m.at) || m.at >= range.since);
    if (range.mode === "after") messages = messages.filter(m => !Number.isFinite(m.at) || m.at > range.after);
    // Plain copies: page objects must not cross into the extension.
    return JSON.parse(JSON.stringify({
      ok: true, messages, reachedStart, loads,
      unread: messages.filter(m => !Number.isFinite(m.at)).length,
      timedOut: Date.now() - started >= maxMs,
    }));
  }

  return { info, grab, READERS };
})();
