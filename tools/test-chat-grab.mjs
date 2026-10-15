// Check extension/chat-grab.js against a stand-in x.com Chat page: the shape the page survey found
// (docs/chat-pages/x-chat-react-data-2026-10-15.md) — a shadow root, a list component handed
// chatItems, message objects with getters and Kotlin-style lists, and a hook-held callback that sends
// ScrolledToTop and loads an older page. No browser, no network.
//
//   node tools/test-chat-grab.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SOURCE = fs.readFileSync(path.join(REPO, "extension/chat-grab.js"), "utf8");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = 1; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// Page arrays as a Firefox content script meets them: reading length and items works, but any method
// that would call back into the extension (map, filter, find…) is refused.
const pageArray = arr => new Proxy(arr, { get(t, k) {
  if (["map", "filter", "find", "forEach", "some", "every", "reduce", "flatMap", "concat", "slice", "reverse"].includes(k)) throw new Error("Permission denied to access object");
  return Reflect.get(t, k);
} });
const kotlin = arr => ({ toArray: () => pageArray(arr.slice()) });
const FAST = { pauseMs: [0, 0] };
const E_ = ms => ({ epochSeconds: Math.floor(ms / 1000), nanosecondsOfSecond: (ms % 1000) * 1e6 });
const T0 = Date.parse("2026-09-01T10:00:00Z");
const DAY = 86_400_000;

/* One message as the page holds it: getters over hidden fields, as the minified classes do. */
function message(i, { mine = false, attachment = null, text = null, entities = [] } = {}) {
  const hidden = { i };
  return Object.defineProperties({}, {
    id: { get: () => `uuid-${hidden.i}`, enumerable: true },
    created: { get: () => E_(T0 + hidden.i * DAY) },
    alignsToViewerSide: { get: () => mine },
    senderInfo: { get: () => ({ user: { screenName: mine ? "me" : "friend", name: mine ? "Me" : "Friend" } }) },
    attachment: { get: () => attachment },
    attachments: { get: () => kotlin(attachment ? [attachment] : []) },
    fullText: { get: () => text },
    textEntities: { get: () => ({ urls: kotlin(entities) }) },
  });
}
const separator = i => ({ id: `dateBoundary-uuid-${i}`, created: E_(T0 + i * DAY) });
const post = (handle, id, extra = {}) => ({
  url: `https://x.com/${handle}/status/${id}/video/1`,
  postState: { post: { url: `https://x.com/${handle}/status/${id}`, text: `post ${id}`, createdAt: E_(T0 - DAY),
    author: { screenName: handle, name: handle.toUpperCase() },
    entityList: { urls: kotlin([{ url: "https://t.co/abc", expandedUrl: `https://example.com/from-${id}` }]) }, ...extra } },
});
const card = url => ({ urlToOpen: url, displayTitle: "A page", source: { urlToOpen: url } });

/* The page: newest page of messages first loaded; each ScrolledToTop prepends the next older page. */
function makePage({ pages, locked = false, path: pathname = "/i/chat/111-222", refuse = false, noLoader = false, staleFail = false, reason = { name: "RateLimited" } }) {
  const state = { chatItems: { items: null, hasOlderItems: pages.length > 1, isLoading: false }, toolbarState: {
    title: "Friend", otherParticipant: { user: { screenName: "friend", name: "Friend" } } } };
  let loaded = pages.length - 1;
  state.chatItems.items = pageArray(pages[loaded].slice());
  if (staleFail) Object.assign(state.chatItems, { didPullFail: true, pullFailureReason: { name: "Old" } });
  const component = { state: { state } };
  let calls = 0;
  const onTop = function () { void "ScrolledToTop"; calls++; setTimeout(() => {
    if (refuse) { state.chatItems.didPullFail = true; state.chatItems.pullFailureReason = reason; return; }
    state.chatItems.didPullFail = false;
    if (loaded === 0) return;
    loaded--;
    state.chatItems.items = pageArray(pages[loaded].concat([...state.chatItems.items]));
    state.chatItems.hasOlderItems = loaded > 0;
    fiber.memoizedProps = { ...fiber.memoizedProps, chatItems: state.chatItems.items };
  }, 30); };
  // The hooks: unrelated ones first, then the callback in a ref, as the survey found at hook #24.
  const hooks = [{ memoizedState: 1 }, { memoizedState: { current: () => "other" } }, ...(noLoader ? [] : [{ memoizedState: { current: onTop } }])];
  hooks.forEach((h, i) => { h.next = hooks[i + 1] || null; });
  const fiber = { memoizedProps: { chatItems: state.chatItems.items, component }, memoizedState: hooks[0], return: null, alternate: null };
  const scroller = { "__reactFiber$x": { memoizedProps: {}, return: fiber } };
  const root = { querySelector: sel => (sel.includes("dm-message-scroller") && !locked ? scroller : null) };
  const document = { querySelector: sel => (sel.includes("xchatEmbedRoute") ? { shadowRoot: root } : null) };
  const window = {};
  const ctx = vm.createContext({ window, document, location: { hostname: "x.com", pathname }, setTimeout, Date, JSON, Math, Number, Array, Object, Promise, String, RegExp, Function });
  vm.runInContext(SOURCE, ctx);
  return { LK: window.LKChat, calls: () => calls };
}

// Three pages, oldest first: days 0-3, 4-7, 8-11.
const pages = [
  [separator(0), message(0, { attachment: post("alice", 100) }), message(1, { mine: true, attachment: card("https://example.org/a") }),
    message(2, { text: "see https://example.net/x and more" }), message(3, { entities: [{ expandedUrl: "https://example.net/entity" }] })],
  [separator(4), message(4, { attachment: post("bob", 200, { displayQuotedPost: { url: "https://x.com/carol/status/300" } }) }),
    message(5, { mine: true, attachment: card("https://x.com/dave/status/400") }), message(6), message(7, { attachment: { url: "https://x.com/eve/status/500", postState: { id: 1 } } })],
  [separator(8), message(8, { attachment: post("alice", 100) }), message(9, { mine: true }), message(10), message(11, { attachment: card("https://example.org/b") })],
];

await check("info names the chat and the other person from the page's data", () => {
  const { LK } = makePage({ pages });
  const i = LK.info();
  assert.deepEqual([i.platform, i.ready, i.thread.id, i.thread.handle, i.thread.name], ["x", true, "111-222", "@friend", "Friend"]);
});

await check("a page with no chat list loaded says it is not ready, and grab says what to do", async () => {
  const { LK } = makePage({ pages, locked: true });
  assert.equal(LK.info().ready, false);
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.equal(res.ok, false);
  assert.match(res.error, /passcode/);
});

await check("not a chat page: info is null", () => {
  const { LK } = makePage({ pages, path: "/home" });
  assert.equal(LK.info(), null);
});

await check("the last N messages come from what is loaded, without loading older pages", async () => {
  const { LK, calls } = makePage({ pages });
  const res = await LK.grab({ mode: "last", n: 3 }, FAST);
  assert.equal(res.ok, true);
  assert.deepEqual(res.messages.map(m => m.key), ["uuid-9", "uuid-10", "uuid-11"]);
  assert.equal(calls(), 0);
});

await check("the whole chat loads every older page, oldest first, and reaches the start", async () => {
  const { LK, calls } = makePage({ pages });
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.equal(res.messages.length, 12);
  assert.equal(res.messages[0].key, "uuid-0");
  assert.deepEqual([res.stopped, calls()], ["start", 2]);
});

await check("since a date loads only as far back as needed", async () => {
  const { LK, calls } = makePage({ pages });
  const res = await LK.grab({ mode: "since", since: T0 + 5 * DAY }, FAST);
  assert.deepEqual(res.messages.map(m => m.key), ["uuid-5", "uuid-6", "uuid-7", "uuid-8", "uuid-9", "uuid-10", "uuid-11"]);
  assert.equal(calls(), 1);
});

await check("start and poll: the grab runs on, poll reports it done with the result; an error keeps its text", async () => {
  const { LK } = makePage({ pages });
  assert.equal(LK.start({ mode: "all" }, FAST).ok, true);
  assert.equal(LK.start({ mode: "all" }).ok, false, "one grab at a time");
  let state;
  for (let i = 0; i < 200 && !(state = LK.poll()).done; i++) await new Promise(r => setTimeout(r, 25));
  assert.deepEqual([state.done, state.result.ok, state.result.messages.length], [true, true, 12]);
  const broken = makePage({ pages });
  broken.LK.READERS.x.items = () => { throw new Error("boom"); };
  broken.LK.start({ mode: "all" }, FAST);
  for (let i = 0; i < 200 && !(state = broken.LK.poll()).done; i++) await new Promise(r => setTimeout(r, 25));
  assert.deepEqual([state.result.ok, state.result.error], [false, "the grab broke: boom"]);
});

const until = async (LK, ok) => { let s; for (let i = 0; i < 400 && !ok(s = LK.poll()); i++) await new Promise(r => setTimeout(r, 10)); return s; };

await check("pause holds the next load, resume carries on, and progress is reported", async () => {
  const { LK, calls } = makePage({ pages });
  // The first load goes out as the grab starts; pause holds every one after it.
  LK.start({ mode: "all" }, { pauseMs: [50, 50] });
  LK.control("pause");
  await new Promise(r => setTimeout(r, 300));
  const held = LK.poll();
  assert.deepEqual([held.done, held.paused, held.progress.messages, held.progress.loads], [false, true, 8, 1]);
  const n = calls();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(calls(), n, "no load while paused");
  LK.control("resume");
  const end = await until(LK, s => s.done);
  assert.deepEqual([end.result.ok, end.result.stopped, end.result.messages.length], [true, "start", 12]);
});

await check("stop keeps what is loaded; cancel keeps nothing", async () => {
  const a = makePage({ pages });
  a.LK.start({ mode: "all" }, { pauseMs: [200, 200] });
  await until(a.LK, s => s.progress?.loads >= 1);
  a.LK.control("stop");
  const stopped = await until(a.LK, s => s.done);
  assert.deepEqual([stopped.result.ok, stopped.result.stopped], [true, "by-you"]);
  assert.ok(stopped.result.messages.length >= 8 && stopped.result.messages.length < 12, `${stopped.result.messages.length} messages`);
  const b = makePage({ pages });
  b.LK.start({ mode: "all" }, { pauseMs: [200, 200] });
  b.LK.control("cancel");
  const cancelled = await until(b.LK, s => s.done);
  assert.deepEqual([cancelled.result.ok, cancelled.result.cancelled], [false, true]);
  assert.equal(b.LK.control("pause").ok, false, "no controls once it is over");
});

await check("a covered range says so; the last N stop without loading", async () => {
  const { LK } = makePage({ pages });
  assert.equal((await LK.grab({ mode: "last", n: 2 }, FAST)).stopped, "range");
});

await check("older pages load a pause apart, not back to back", async () => {
  const { LK } = makePage({ pages });
  const t0 = Date.now();
  const res = await LK.grab({ mode: "all" }, { pauseMs: [150, 150] });
  assert.equal(res.loads, 2);
  assert.ok(Date.now() - t0 >= 150, `took ${Date.now() - t0} ms`);
});

await check("a load the site refuses stops the grab and says why", async () => {
  const { LK, calls } = makePage({ pages, refuse: true });
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.deepEqual([res.ok, res.stopped, calls(), res.messages.length], [true, "failed: RateLimited", 1, 4]);
});

await check("a failure flag left from before the grab does not stop it", async () => {
  const { LK, calls } = makePage({ pages, staleFail: true });
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.deepEqual([res.stopped, calls(), res.messages.length], ["start", 2, 12]);
});

await check("a refusal whose reason is no words reads as a plain refusal", async () => {
  const { LK } = makePage({ pages, refuse: true, reason: { code: 7 } });
  assert.equal((await LK.grab({ mode: "all" }, FAST)).stopped, "failed: x.com refused the load");
});

await check("no loader on the page: what is loaded, and an early stop named", async () => {
  const { LK } = makePage({ pages, noLoader: true });
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.deepEqual([res.stopped, res.messages.length], ["no-loader", 4]);
});

await check("after the last grab takes only newer messages", async () => {
  const { LK } = makePage({ pages });
  const res = await LK.grab({ mode: "after", after: T0 + 9 * DAY }, FAST);
  assert.deepEqual(res.messages.map(m => m.key), ["uuid-10", "uuid-11"]);
});

await check("each message: exact time, sender, mine, and its links", async () => {
  const { LK } = makePage({ pages });
  const res = await LK.grab({ mode: "all" }, FAST);
  const by = k => res.messages.find(m => m.key === k);
  assert.equal(by("uuid-0").at, T0);
  assert.deepEqual([by("uuid-0").sender, by("uuid-0").mine, by("uuid-1").sender, by("uuid-1").mine], ["@friend", false, "@me", true]);
  const p = by("uuid-0").links[0];
  assert.deepEqual([p.url, p.kind, p.text, p.author.handle, p.links], ["https://x.com/alice/status/100", "tweet", "post 100", "@alice", ["https://example.com/from-100"]],
    "a shared post: its canonical address (no /video/1), text, author and its own real links");
  assert.deepEqual(by("uuid-1").links.map(l => [l.url, l.kind, l.title]), [["https://example.org/a", "page", "A page"]], "a link card: its real URL");
  assert.deepEqual(by("uuid-2").links.map(l => l.url), ["https://example.net/x"], "a URL typed into the text");
  assert.deepEqual(by("uuid-3").links.map(l => l.url), ["https://example.net/entity"], "a text entity's real address");
  assert.ok(by("uuid-4").links[0].links.includes("https://x.com/carol/status/300"), "a quoted post rides along with the post");
  assert.equal(by("uuid-5").links[0].kind, "tweet", "a card to a post is a tweet");
  assert.deepEqual(by("uuid-6").links, [], "a message with nothing in it has no links");
  const unloaded = by("uuid-7").links[0];
  assert.deepEqual([unloaded.url, unloaded.text], ["https://x.com/eve/status/500", undefined], "a post the page did not load keeps its address");
});

/* An Instagram thread as its Relay store holds it: message records, the thread record, a connection
 * of edges newest first, and the list component with elements and onLoadMoreAboveExternal. */
function makeInstagram({ pages }) {
  const records = new Map();
  const put = (id, rec) => { records.set(id, rec); return { __ref: id }; };
  put("XDTUserDict:me", { username: "me", full_name: "Me", interop_messaging_user_fbid: "900" });
  put("XDTUserDict:fr", { username: "friend", full_name: "Friend Name", interop_messaging_user_fbid: "901" });
  put("XFBIGDirectViewerThread:555", { thread_fbid: "555", thread_key: "777", thread_title: "Friend Name",
    users: { __refs: pageArray(["XDTUserDict:fr"]) }, viewer: { __ref: "XDTUserDict:me" } });
  const msg = (i, mine, content, text = "") => {
    const id = `SlideMessage:mid.$${i}`;
    const sender = put(`SlideUser:${mine ? "me" : "fr"}`, { name: mine ? "Me" : "Friend Name", user_dict: { __ref: mine ? "XDTUserDict:me" : "XDTUserDict:fr" } });
    put(id, { id: `mid.$${i}`, timestamp_ms: String(T0 + i * DAY), sender_fbid: mine ? "900" : "901", thread_fbid: "555", text_body: text,
      sender, content: content ? put(`${id}:content`, { xma: put(`${id}:xma`, content) }) : null });
    return id;
  };
  const all = pages.map(pg => pg.map(([i, mine, content, text]) => msg(i, mine, content, text)));
  let loaded = all.length - 1;
  let ids = all[loaded].slice();
  const conn = () => ({ edges: { __refs: pageArray(ids.slice().reverse().map((id, n) => (records.set(`edge${n}${id}`, { node: { __ref: id } }), `edge${n}${id}`)) ) } });
  let calls = 0;
  const triggers = { memoizedProps: null, dependencies: null, return: null };
  const env = { getStore: () => ({ getSource: () => ({ get: id => (id.endsWith("_connection") ? conn() : records.get(id)) }) }) };
  const props = () => ({ elements: pageArray(ids.map(id => ({ currentMessage: { __id: id } }))), hasMoreAbove: loaded > 0, isLoadingAbove: false,
    onLoadMoreAboveExternal: () => { calls++; setTimeout(() => { if (loaded > 0) { loaded--; ids = all[loaded].concat(ids); triggers.memoizedProps = props(); } }, 30); } });
  triggers.memoizedProps = props();
  triggers.return = { dependencies: { firstContext: { memoizedValue: { environment: env }, next: null } }, return: null };
  const article = { "__reactFiber$y": { return: { return: triggers } } };
  const document = { querySelector: sel => (sel.includes("article") ? article : null), querySelectorAll: () => [] };
  const window = {};
  const ctx = vm.createContext({ window, document, location: { hostname: "www.instagram.com", pathname: "/direct/t/777/" }, setTimeout, Date, JSON, Math, Number, Array, Object, Promise, String, RegExp, Function, decodeURIComponent });
  vm.runInContext(SOURCE, ctx);
  return { LK: window.LKChat, calls: () => calls };
}

const reel = code => ({ target_url: `https://www.instagram.com/reel/${code}/?id=1&is_sponsored=0`, header_title_text: "author" });
const igPages = [
  [[0, false, reel("AAA")], [1, true, { target_url: "https://www.instagram.com/p/BBB/?carousel_share_child_media_id=1_2", header_title_text: "poster", title_text: "poster a caption" }]],
  [[2, false, null, "look https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2Fpage&e=x"], [3, true, reel("AAA")]],
];

await check("Instagram: the thread, its other person, and the label the export import uses", () => {
  const { LK } = makeInstagram({ pages: igPages });
  const i = LK.info();
  assert.deepEqual([i.platform, i.ready, i.thread.id, i.thread.handle, i.thread.name, i.thread.label], ["instagram", true, "777", "@friend", "Friend Name", "friendname_555"]);
});

await check("Instagram: every message from the store, older pages loaded, with time, sender and links", async () => {
  const { LK, calls } = makeInstagram({ pages: igPages });
  const res = await LK.grab({ mode: "all" }, FAST);
  assert.deepEqual(res.messages.map(m => m.key), ["mid.$0", "mid.$1", "mid.$2", "mid.$3"]);
  assert.deepEqual([res.stopped, calls()], ["start", 1]);
  const by = k => res.messages.find(m => m.key === k);
  assert.deepEqual([by("mid.$0").at, by("mid.$0").sender, by("mid.$0").mine, by("mid.$1").mine], [T0, "Friend Name", false, true]);
  assert.deepEqual(by("mid.$0").links.map(l => [l.url, l.kind, l.author.handle]), [["https://www.instagram.com/reel/AAA/", "reel", "author"]], "a reel: its canonical address");
  assert.deepEqual(by("mid.$1").links.map(l => [l.url, l.kind, l.text]), [["https://www.instagram.com/p/BBB/", "ig-post", "poster a caption"]], "a post: its caption");
  assert.deepEqual(by("mid.$2").links.map(l => l.url), ["https://example.com/page"], "a typed link, unwrapped from l.instagram.com");
});

await check("Instagram: the last N take only what is loaded", async () => {
  const { LK, calls } = makeInstagram({ pages: igPages });
  const res = await LK.grab({ mode: "last", n: 2 }, FAST);
  assert.deepEqual([res.messages.map(m => m.key), calls()], [["mid.$2", "mid.$3"], 0]);
});

if (failed) { console.log("\nsome checks failed"); process.exit(1); }
console.log("all passed");
