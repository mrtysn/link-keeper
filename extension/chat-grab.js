/* Reads the links out of a direct-message chat open in the page: x.com Chat (end-to-end encrypted, so
 * only the page itself ever holds the text) and Instagram's direct threads.
 *
 * Injected by background.js (scripting.executeScript, files) and then driven through window.LKChat:
 *   LKChat.info()        which chat this is, whether it is locked, or null when the page is no chat;
 *   LKChat.grab(range)   scroll up through the chat, collecting every message in the range, and
 *                        return them with their links, sender and time.
 *
 * Chats render lazily and may drop messages that scroll out of view, so the engine collects as it
 * scrolls, keyed per message, and never reads the whole history at the end. Each site is one reader
 * in READERS: where the messages are, and how to read one. Everything else is shared. Nothing here
 * throws on a missing node: a redesign should cost the field it touched, and the grab says what it
 * could not read.
 */

window.LKChat = window.LKChat || (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = node => (node ? node.textContent.replace(/\s+/g, " ").trim() || null : null);

  /* --- readers, one per site -------------------------------------------------------------------
   * match(location)   this page is one of its chats
   * thread()          { id, name, handle } of the chat: id stable per conversation
   * locked()          the chat is behind a passcode or not loaded yet
   * scroller()        the element that scrolls the messages
   * messages()        the messages rendered now, in page order, each
   *                   { key, at (ms or null), mine, sender, links: [{ url, kind, author, text }] }
   */
  const READERS = {
    x: {
      label: "X",
      match: loc => /^(www\.)?(x|twitter)\.com$/.test(loc.hostname) && /^\/(i\/chat|messages)\/[^/]+/.test(loc.pathname),
      thread: () => null,
      locked: () => false,
      scroller: () => null,
      messages: () => [],
    },
    instagram: {
      label: "Instagram",
      match: loc => /^(www\.)?instagram\.com$/.test(loc.hostname) && /^\/direct\/t\/[^/]+/.test(loc.pathname),
      thread: () => null,
      locked: () => false,
      scroller: () => null,
      messages: () => [],
    },
  };

  const readerHere = () => Object.entries(READERS).find(([, r]) => r.match(location)) || null;

  function info() {
    const found = readerHere();
    if (!found) return null;
    const [platform, r] = found;
    const thread = r.thread();
    return { platform, site: r.label, thread, locked: r.locked(), ready: !!r.scroller() && !r.locked() };
  }

  /* Wait until fn() changes from `before`, or the time runs out. */
  async function settle(fn, before, ms = 2500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(150);
      if (fn() !== before) {
        await sleep(250);   // let the batch finish rendering
        return true;
      }
    }
    return false;
  }

  /* range: { mode: "last", n } | { mode: "since", since (ms) } | { mode: "after", after (ms) } | { mode: "all" }
   * Returns { messages (oldest first), reachedStart, scrolls, unread (messages with no time) }. */
  async function grab(range, { maxScrolls = 3000, maxMs = 15 * 60_000 } = {}) {
    const found = readerHere();
    if (!found) return { ok: false, error: "this page is not a chat Link Keeper can read" };
    const [, r] = found;
    if (r.locked()) return { ok: false, error: "the chat is locked: enter your passcode on the page first" };
    const box = r.scroller();
    if (!box) return { ok: false, error: "could not find the chat's messages on this page" };

    const seen = new Map();
    const collect = () => { for (const m of r.messages()) if (m.key && !seen.has(m.key)) seen.set(m.key, m); };
    const oldestAt = () => Math.min(...[...seen.values()].map(m => m.at).filter(Number.isFinite));
    const enough = () => {
      if (range.mode === "last") return seen.size >= range.n;
      if (range.mode === "since") return oldestAt() < range.since;
      if (range.mode === "after") return oldestAt() <= range.after;
      return false;
    };
    const firstKey = () => r.messages()[0]?.key || "";

    // Start from the newest message.
    box.scrollTop = box.scrollHeight;
    await settle(() => box.scrollHeight, box.scrollHeight, 1200);
    collect();

    const started = Date.now();
    let scrolls = 0, stuck = 0, reachedStart = false;
    while (!enough() && scrolls < maxScrolls && Date.now() - started < maxMs) {
      const before = firstKey();
      box.scrollTop = Math.max(0, box.scrollTop - box.clientHeight * 0.8);
      scrolls++;
      const moved = await settle(firstKey, before);
      collect();
      if (!moved && box.scrollTop <= 0) {
        // At the top with nothing new: wait once more for a slow load, then call it the start.
        if (++stuck >= 3) { reachedStart = true; break; }
      } else stuck = 0;
    }

    let messages = [...seen.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (range.mode === "last") messages = messages.slice(-range.n);
    if (range.mode === "since") messages = messages.filter(m => !Number.isFinite(m.at) || m.at >= range.since);
    if (range.mode === "after") messages = messages.filter(m => !Number.isFinite(m.at) || m.at > range.after);
    box.scrollTop = box.scrollHeight;   // leave the chat where it was opened: at the newest message
    return {
      ok: true, messages, reachedStart, scrolls,
      unread: messages.filter(m => !Number.isFinite(m.at)).length,
      timedOut: Date.now() - started >= maxMs,
    };
  }

  return { info, grab, READERS, _txt: txt };
})();
