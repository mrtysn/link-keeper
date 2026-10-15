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
    // x.com marks a refused load on the list's state (a rate limit, a network error).
    failed() {
      const items = tryGet(() => X.state()?.chatItems);
      if (!tryGet(() => items?.didPullFail)) return null;
      // The reason's shape was never seen on a real failure: keep it only if it reads as words.
      const why = str(tryGet(() => items.pullFailureReason?.name)) || str(tryGet(() => items.pullFailureReason));
      return why && !why.startsWith("[object") && why.length <= 60 ? why : "x.com refused the load";
    },
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

  // Instagram keeps every loaded message in its Relay store (docs/chat-pages/instagram-relay-data-
  // 2026-10-15.md). The list component above the scroller holds the handler that loads older ones.
  const INSTAGRAM = {
    label: "Instagram",
    match: loc => /^(www\.)?instagram\.com$/.test(loc.hostname) && /^\/direct\/t\/[^/]+/.test(loc.pathname),
    // The list component: handed elements and hasMoreAbove. Reached from a message on screen, or from
    // the scroller's first child when none is drawn.
    triggers() {
      const isIt = f => Array.isArray(f?.memoizedProps?.elements) && "hasMoreAbove" in f.memoizedProps;
      const art = document.querySelector('[role="article"][aria-roledescription="message"]');
      for (let f = fiberOf(art), i = 0; f && i < 120; f = f.return, i++) if (isIt(f)) return INSTAGRAM.newer(f);
      for (const el of document.querySelectorAll("main div")) {
        const f = fiberOf(el.firstElementChild)?.child;
        if (isIt(f)) return INSTAGRAM.newer(f);
      }
      return null;
    },
    newer: f => (f.alternate && list(f.alternate.memoizedProps?.elements).length > list(f.memoizedProps.elements).length ? f.alternate : f),
    source() {
      for (let g = INSTAGRAM.triggers(), i = 0; g && i < 200; g = g.return, i++) {
        for (let c = g.dependencies?.firstContext; c; c = c.next) {
          const env = tryGet(() => c.memoizedValue?.environment);
          if (env && typeof env.getStore === "function") return env.getStore().getSource();
        }
      }
      return null;
    },
    ref(src, v) { const id = tryGet(() => v?.__ref); return id ? src.get(id) : v; },
    threadRecord(src, msgs) {
      const fbid = str(tryGet(() => msgs[0]?.thread_fbid));
      return fbid ? src.get(`XFBIGDirectViewerThread:${fbid}`) : null;
    },
    // Every loaded message, oldest first: the store's connection when it can be found, else the
    // list component's elements.
    items() {
      const src = INSTAGRAM.source();
      if (!src) return [];
      const fromElements = list(INSTAGRAM.triggers()?.memoizedProps?.elements)
        .map(e => src.get(str(tryGet(() => e.currentMessage.__id)))).filter(Boolean);
      const fbid = str(tryGet(() => fromElements[0]?.thread_fbid));
      const conn = fbid && src.get(`client:XFBIGDirectViewerThread:${fbid}:__IGDMessagesList_slide_messages_connection`);
      const fromStore = list(tryGet(() => conn?.edges?.__refs)).map(id => INSTAGRAM.ref(src, tryGet(() => src.get(id)?.node))).filter(Boolean).reverse();
      INSTAGRAM.cache = { src, thread: INSTAGRAM.threadRecord(src, fromElements.length ? fromElements : fromStore) };
      return fromStore.length > fromElements.length ? fromStore : fromElements;
    },
    ready: () => !!INSTAGRAM.source(),
    thread() {
      INSTAGRAM.items();
      const { src, thread } = INSTAGRAM.cache || {};
      if (!thread) return { id: location.pathname.split("/")[3] || null, name: null, handle: null };
      const other = INSTAGRAM.ref(src, list(tryGet(() => thread.users?.__refs)).map(id => ({ __ref: id }))[0]);
      const name = str(tryGet(() => other?.full_name)) || str(tryGet(() => thread.thread_title));
      const username = str(tryGet(() => other?.username));
      // The export names a thread <name>_<thread_fbid> (instagram.py); the same label here lets
      // Group by chat put grabbed and exported links together.
      const fbid = str(tryGet(() => thread.thread_fbid)) || str(tryGet(() => thread.id));
      const slug = name && fbid ? `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}_${fbid}` : null;
      return { id: str(tryGet(() => thread.thread_key)) || location.pathname.split("/")[3] || null, name, handle: username ? `@${username}` : null, label: slug };
    },
    hasOlder: () => !!tryGet(() => INSTAGRAM.triggers()?.memoizedProps?.hasMoreAbove),
    loading: () => !!tryGet(() => INSTAGRAM.triggers()?.memoizedProps?.isLoadingAbove),
    loadOlder() {
      const fn = tryGet(() => INSTAGRAM.triggers()?.memoizedProps?.onLoadMoreAboveExternal);
      if (typeof fn !== "function") return false;
      fn();
      return true;
    },
    canonical(url) {
      const m = url.match(/^https:\/\/(?:www\.)?instagram\.com\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      return m ? `https://www.instagram.com/${m[1] === "p" ? "p" : "reel"}/${m[2]}/` : url;
    },
    message(m) {
      const { src, thread } = INSTAGRAM.cache || {};
      const id = str(tryGet(() => m.id));
      if (!id) return null;
      const at = Number(tryGet(() => m.timestamp_ms));
      const me = str(tryGet(() => INSTAGRAM.ref(src, thread?.viewer)?.interop_messaging_user_fbid));
      const sender = INSTAGRAM.ref(src, tryGet(() => m.sender));
      const links = [];
      const content = INSTAGRAM.ref(src, tryGet(() => m.content));
      const xma = INSTAGRAM.ref(src, tryGet(() => content?.xma));
      const target = str(tryGet(() => xma?.target_url));
      if (target) {
        const url = INSTAGRAM.canonical(target);
        const caption = str(tryGet(() => xma.title_text)) || str(tryGet(() => xma.caption_body_text));
        links.push({ url, kind: /\/reel\//.test(url) ? "reel" : "ig-post",
          author: { name: null, handle: str(tryGet(() => xma.header_title_text)) }, ...(caption ? { text: caption } : {}) });
      }
      const text = str(tryGet(() => m.text_body)) || str(tryGet(() => content?.text_body)) || "";
      for (let url of text.match(/https?:\/\/[^\s<>"')\]]+/g) || []) {
        const wrapped = url.match(/^https?:\/\/l\.instagram\.com\/\?u=([^&]+)/);
        if (wrapped) url = decodeURIComponent(wrapped[1]);
        const canon = INSTAGRAM.canonical(url);
        links.push({ url: canon, kind: /instagram\.com\/reel\//.test(canon) ? "reel" : /instagram\.com\/p\//.test(canon) ? "ig-post" : "page" });
      }
      return { key: id, at: Number.isFinite(at) && at > 0 ? at : null, mine: !!me && str(tryGet(() => m.sender_fbid)) === me,
        sender: str(tryGet(() => sender?.name)) || str(tryGet(() => INSTAGRAM.ref(src, sender?.user_dict)?.full_name)), links: dedupe(links) };
    },
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
    return { platform, site: r.label, thread: tryGet(() => r.thread()) || null, ready, locked: !ready };
  }

  /* range: { mode: "last", n } | { mode: "since", since (ms) } | { mode: "after", after (ms) } | { mode: "all" }
   * Returns { messages (oldest first), stopped, loads }. stopped says why loading older pages ended:
   * "range" (the range is covered), "start" (the chat's first message is loaded), or an early stop —
   * "failed: <reason>" (the site refused the load), "no-loader" (the page's loader was not found),
   * "nothing-new" (a load brought nothing within 20 s), "time" or "limit".
   *
   * Older pages load at a person's scrolling pace, a pause of 1.5–3 s between them: the requests are
   * the ones the page makes when you scroll up, and a burst of them is what a site rate-limits. */
  async function grab(range, { maxLoads = 2000, maxMs = 15 * 60_000, pauseMs = [1500, 3000], control = {} } = {}) {
    const found = readerHere();
    if (!found) return { ok: false, error: "this page is not a chat Link Keeper can read" };
    const [, r] = found;
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

    // control: { paused, stop, cancel } set from outside (the panel, the popup); progress is written
    // back to it after every load. Time spent paused does not count against maxMs.
    const report = () => {
      const times = messages.map(m => m.at).filter(Number.isFinite);
      control.progress = { messages: messages.length, links: new Set(messages.flatMap(m => m.links.map(l => l.url))).size,
        oldest: times.length ? Math.min(...times) : null, loads, paused: !!control.paused };
    };
    let loads = 0, stopped = null, lastWasFailed = false;
    report();
    let started = Date.now();
    while (!stopped) {
      while (control.paused && !control.stop && !control.cancel) {
        const t0 = Date.now();
        report();
        await sleep(300);
        started += Date.now() - t0;
      }
      if (control.cancel) return { ok: false, cancelled: true, error: "cancelled: nothing was saved" };
      if (control.stop) { stopped = "by-you"; break; }
      if (enough()) { stopped = "range"; break; }
      // A refusal counts only after this grab's own load: a flag left from an earlier failure must
      // not stop every later grab before it tries.
      const failed = loads && !lastWasFailed ? tryGet(() => r.failed?.()) : null;
      if (failed) { stopped = `failed: ${failed}`; break; }
      if (!r.hasOlder()) { stopped = "start"; break; }
      if (loads >= maxLoads) { stopped = "limit"; break; }
      if (Date.now() - started >= maxMs) { stopped = "time"; break; }
      if (loads) await sleep(pauseMs[0] + Math.random() * (pauseMs[1] - pauseMs[0]));
      // Pressed during the pause between loads: honoured before the next one goes out.
      if (control.cancel) return { ok: false, cancelled: true, error: "cancelled: nothing was saved" };
      if (control.stop) { stopped = "by-you"; break; }
      if (control.paused) continue;
      const before = r.items().length;
      // A flag already up before this load says nothing about it.
      const failedNow = () => (wasFailed ? null : tryGet(() => r.failed?.()));
      const wasFailed = !!tryGet(() => r.failed?.());
      if (!r.loadOlder()) { stopped = "no-loader"; break; }
      loads++;
      // Wait for the page to fetch and decrypt the next page of messages.
      const end = Date.now() + 20_000;
      while (Date.now() < end && r.items().length === before && !failedNow()) await sleep(250);
      while (Date.now() < end && r.loading()) await sleep(250);
      if (r.items().length === before) {
        const why = failedNow();
        stopped = why ? `failed: ${why}` : r.hasOlder() ? "nothing-new" : "start";
      }
      lastWasFailed = wasFailed;
      messages = read();
      report();
    }

    messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (range.mode === "last") messages = messages.slice(-range.n);
    if (range.mode === "since") messages = messages.filter(m => !Number.isFinite(m.at) || m.at >= range.since);
    if (range.mode === "after") messages = messages.filter(m => !Number.isFinite(m.at) || m.at > range.after);
    // Plain copies: page objects must not cross into the extension.
    return JSON.parse(JSON.stringify({
      ok: true, messages, stopped, loads,
      unread: messages.filter(m => !Number.isFinite(m.at)).length,
    }));
  }

  /* The extension drives a grab in short calls rather than one long one: start() sets it going and
   * returns at once, poll() reports its progress and, at the end, its result, control() pauses, resumes,
   * stops (keeping what it has) or cancels it. A grab takes minutes, and a script call that waits on a
   * promise that long is not something to rely on. Any error is kept as its own text. */
  let run = null;
  function start(range, opts = {}) {
    if (run && !run.done) return { ok: false, error: "a grab is already running on this page" };
    run = { done: false, result: null, started: Date.now(), control: {}, chat: tryGet(() => readerHere()?.[1].thread()) || null };
    const mine = run;
    grab(range, { ...opts, control: mine.control })
      .then(res => { mine.result = res; }, e => { mine.result = { ok: false, error: `the grab broke: ${e?.message || e}` }; })
      .finally(() => { mine.done = true; tryGet(Panel.draw); });
    tryGet(Panel.show);   // a page that cannot draw it still runs the grab
    return { ok: true };
  }
  const poll = () => (run
    ? { done: run.done, saved: !!run.saved, result: run.done ? run.result : null, progress: run.control.progress || null, paused: !!run.control.paused, ms: Date.now() - run.started }
    : { done: true, none: true, result: { ok: false, error: "no grab was started on this page" } });
  function control(action) {
    if (!run || run.done) return { ok: false, error: "no grab is running" };
    if (action === "pause") run.control.paused = true;
    if (action === "resume") run.control.paused = false;
    if (action === "stop") run.control.stop = true;
    if (action === "cancel") run.control.cancel = true;
    tryGet(Panel.draw);
    return { ok: true };
  }
  // The extension's word on what was saved, once the links are in: shown in the panel.
  function finish(text, ok) {
    if (run) Object.assign(run, { saved: true, summary: text, summaryOk: ok });
    tryGet(Panel.draw);
    return { ok: true };
  }

  /* The panel: a corner of the chat page while a grab runs, since the popup closes once you click. It
   * sits in a closed shadow root, so the page's styles do not reach it and its script cannot read it;
   * the page can only see that an element is there. */
  const Panel = {
    host: null, root: null, timer: null,
    show() {
      if (!Panel.host) {
        Panel.host = document.createElement("link-keeper-grab");
        Panel.root = Panel.host.attachShadow({ mode: "closed" });
        Panel.root.innerHTML = `<style>
          :host { all: initial; }
          .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 300px; padding: 12px 14px;
            font: 13px/1.45 -apple-system, "Helvetica Neue", sans-serif; color: #e8e6e3; background: #24272c;
            border: 1px solid #3a3f46; border-radius: 12px; box-shadow: 0 10px 30px rgb(0 0 0 / .45); }
          .head { display: flex; align-items: center; gap: 8px; font-weight: 650; }
          .head span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .x { background: none; border: 0; color: #c0bdb9; font-size: 16px; cursor: pointer; padding: 0 2px; }
          .line { margin-top: 6px; color: #d8d5d1; }
          .msg.err { margin-top: 6px; color: #ffa693; white-space: pre-wrap; overflow-wrap: anywhere; }
          .msg.ok { margin-top: 6px; color: #4fcf95; white-space: pre-wrap; }
          .msg.wait { margin-top: 6px; color: #c0bdb9; }
          .acts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
          button.b { font: inherit; padding: 4px 10px; border-radius: 8px; border: 1px solid #3a3f46; background: #2b2f35; color: #e8e6e3; cursor: pointer; }
          button.b.primary { background: #c1b4fe; border-color: #c1b4fe; color: #16171a; font-weight: 600; }
          button.b.danger { color: #ffa693; }
        </style><div class="box" role="status" aria-live="polite"><div class="head"><span></span><button class="x" title="Close" aria-label="Close">×</button></div>
          <div class="line"></div><div class="msg"></div><div class="acts"></div></div>`;
        Panel.root.querySelector(".x").onclick = () => { if (!run || run.done) Panel.hide(); else control("cancel"); };
      }
      if (!Panel.host.isConnected) document.documentElement.append(Panel.host);
      clearInterval(Panel.timer);
      Panel.timer = setInterval(Panel.draw, 500);
      Panel.draw();
    },
    hide() { clearInterval(Panel.timer); Panel.host?.remove(); },
    button(text, cls, fn) {
      const b = document.createElement("button");
      b.className = `b ${cls}`;
      b.textContent = text;
      b.onclick = fn;
      return b;
    },
    draw() {
      if (!Panel.root || !run) return;
      const $ = s => Panel.root.querySelector(s);
      const who = run.chat?.handle || run.chat?.name || "this chat";
      const p = run.control.progress || {};
      const back = p.oldest ? new Date(p.oldest).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
      const counts = `${p.messages || 0} messages${back ? `, back to ${back}` : ""} · ${p.links || 0} links`;
      const acts = $(".acts");
      acts.textContent = "";
      $(".x").hidden = !run.done;   // while it runs, Cancel says what closing would do
      const msg = $(".msg");
      msg.textContent = "";
      msg.className = "msg";
      if (!run.done) {
        $(".head span").textContent = `Link Keeper · grabbing ${who}`;
        $(".line").textContent = run.control.cancel ? "Cancelling…" : run.control.stop ? `Stopping… ${counts}`
          : run.control.paused ? `Paused. ${counts}` : `Loading older messages… ${counts}`;
        if (!run.control.stop && !run.control.cancel) {
          acts.append(run.control.paused ? Panel.button("Resume", "primary", () => control("resume")) : Panel.button("Pause", "", () => control("pause")),
            Panel.button("Stop and save", "", () => control("stop")), Panel.button("Cancel", "danger", () => control("cancel")));
        }
        return;
      }
      clearInterval(Panel.timer);
      const res = run.result || {};
      $(".head span").textContent = `Link Keeper · ${who}`;
      $(".line").textContent = counts;
      if (run.saved) {
        msg.className = `msg ${run.summaryOk ? "ok" : "err"}`;
        msg.textContent = run.summary || "";
      } else if (!res.ok) {
        msg.className = "msg err";
        msg.textContent = res.error || "the chat could not be read";
      } else {
        msg.className = "msg wait";
        msg.textContent = "Saving the links…";
      }
      const text = msg.textContent;
      if (text && (run.saved || !res.ok)) {
        acts.append(Panel.button("Copy", "", () => navigator.clipboard?.writeText(text).catch(() => {})), Panel.button("Close", "primary", Panel.hide));
      }
    },
  };

  return { info, grab, start, poll, control, finish, READERS };
})();
