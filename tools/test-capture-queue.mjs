#!/usr/bin/env node
// DESC: Run the capture queue against a fake capture and clock, and check its turns, pacing and stopping.
//
// Loads extension/capture-queue.js into a VM and drives makeCaptureQueue with fakes: a capture that
// answers from a table, a clock that only moves when the test advances it, and a window counter. It
// checks that two links load at once but never two of one site, that a site waits its gap between pages,
// that a wall or three failures in a row stop a site and set its links aside, that pause, resume, stop,
// retry and dismiss do what Links says they do, and that a queue put to sleep mid-capture resumes.
// tools/test-extractors.zsh runs the real thing in headless Firefox.
//
// Usage: node tools/test-capture-queue.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

const source = readFileSync(new URL("../extension/capture-queue.js", import.meta.url), "utf8");
const ctx = vm.createContext({ URL, setTimeout, clearTimeout, console });
vm.runInContext(`${source}\nthis.makeCaptureQueue = makeCaptureQueue; this.crawlDelayOf = crawlDelayOf;`, ctx);

/* A world for one queue: answers[url] is what capturing it returns (default ok); every capture resolves
 * only when the test lets it, so what is loading at once can be seen. */
function world({ answers = {}, captured = [], saved = null, robots = {} } = {}) {
  const robotsRead = [];   // hosts whose robots.txt was read
  let clock = 1_000_000;
  const timers = [];
  const loading = [];   // [{ url, resolve }]
  const log = [];       // [url, at] per capture started
  const windows = { opened: 0, closed: 0, open: new Set() };
  const recorded = {};   // url → the kind of failure kept on the link
  let store = saved;
  const fx = {
    capture: (url, windowId) => {
      assert.ok(windows.open.has(windowId), `captured ${url} in a window that is not open`);
      log.push([url, clock]);
      return new Promise(resolve => loading.push({ url, resolve: () => resolve(answers[url] || { ok: true }) }));
    },
    isCaptured: async url => captured.includes(url),
    load: async () => (store ? structuredClone(store) : null),
    save: async s => { store = structuredClone(s); },
    openWindow: async () => { const id = ++windows.opened; windows.open.add(id); return id; },
    windowAlive: async id => windows.open.has(id),
    closeWindow: async id => { windows.closed++; windows.open.delete(id); },
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    random: () => 0.5,   // gaps are exactly 1.1 × the site's
    thin: r => !!r.thin,
    crawlDelay: async url => {
      const host = new URL(url).hostname;
      robotsRead.push(host);
      if (robots[host] === "unreadable") throw new Error("robots.txt answered 503");
      return robots[host] || 0;
    },
    recordFail: (url, error, kind) => { recorded[url] = kind; },
  };
  // Its answers come from the VM's realm; structuredClone brings them into this one for deepEqual.
  const q = ctx.makeCaptureQueue(fx);
  const settle = () => new Promise(r => setImmediate(r));
  return {
    q, log, windows, loading, recorded, robotsRead, store: () => store,
    async flush() { for (let i = 0; i < 10; i++) await settle(); },
    // Finishes the oldest loading page (or the one for url).
    async finish(url) {
      const i = url ? loading.findIndex(l => l.url === url) : 0;
      assert.ok(i >= 0, `nothing loading for ${url}`);
      loading.splice(i, 1)[0].resolve();
      await this.flush();
    },
    loadingNow: () => loading.map(l => l.url),
    // Moves the clock on, running each timer that comes due.
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        clock = Math.max(clock, t.at);
        t.fn();
        await this.flush();
      }
      clock = end;
    },
    async drain() {
      await this.flush();
      for (let i = 0; i < 500 && (loading.length || timers.length); i++) {
        if (loading.length) await this.finish();
        else await this.advance(60_000);
      }
    },
  };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
}

const IG = n => `https://www.instagram.com/p/post${n}/`;
const GH = n => `https://github.com/someone/repo${n}`;

await check("two links load at once, never two of one site", async () => {
  const w = world();
  await w.q.start([IG(1), IG(2), GH(1), GH(2)]);
  await w.flush();
  assert.deepEqual(w.loadingNow(), [IG(1), GH(1)]);
  assert.equal(w.windows.opened, 1, "one window for both");
});

await check("a site waits its gap between pages: 10 s for most, 30 s for a login site", async () => {
  const w = world();
  await w.q.start([IG(1), IG(2), GH(1), GH(2)]);
  await w.flush();
  await w.finish(GH(1));
  await w.finish(IG(1));
  assert.deepEqual(w.loadingNow(), [], "both sites wait");
  await w.advance(10_900);
  assert.deepEqual(w.loadingNow(), [], "github not before 11 s");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [GH(2)], "github after 11 s");
  await w.finish();
  await w.advance(21_900);
  assert.deepEqual(w.loadingNow(), [], "instagram not before 33 s");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [IG(2)], "instagram at 33 s");
});

const A = n => `https://a.example/${n}`, B = n => `https://b.example/${n}`, C = n => `https://c.example/${n}`;

await check("sites take turns: the ready site served longest ago goes next, whatever the line's order", async () => {
  const w = world();
  await w.q.start([A(1), A(2), A(3), B(1), B(2), C(1)]);
  await w.flush();
  assert.deepEqual(w.loadingNow(), [A(1), B(1)]);
  await w.finish(A(1));
  assert.deepEqual(w.loadingNow(), [B(1), C(1)], "c, never served, before a waits out its gap");
  await w.finish(B(1));
  await w.finish(C(1));
  await w.advance(12_000);
  assert.deepEqual(w.loadingNow(), [A(2), B(2)], "then a and b again, a first as served longer ago");
});

await check("speed: Gentle loads one at a time and doubles waits, Fast three at a time and halves them", async () => {
  const w = world();
  await w.q.start([A(1), A(2), B(1), C(1)], "gentle");
  await w.flush();
  assert.deepEqual(w.loadingNow(), [A(1)], "gentle: one at a time");
  await w.finish();
  await w.finish();
  await w.finish();
  await w.advance(21_900);
  assert.deepEqual(w.loadingNow(), [], "gentle: a's wait is 22 s, not 11");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(2)]);
  const f = world();
  await f.q.start([A(1), A(2), B(1), C(1)]);
  await f.q.setSpeed("fast");
  await f.flush();
  assert.deepEqual(f.loadingNow(), [A(1), B(1), C(1)], "fast: three at a time");
  await f.finish(A(1));
  await f.advance(5600);
  assert.deepEqual(f.loadingNow(), [B(1), C(1), A(2)], "fast: a's wait is 5.5 s");
  assert.equal((await f.q.setSpeed("warp")).ok, false, "an unknown speed is refused");
});

await check("a site's robots.txt Crawl-delay is read once and is the least it waits, at any speed", async () => {
  const w = world({ robots: { "a.example": 45 } });
  await w.q.start([A(1), A(2), A(3)], "fast");
  await w.flush();
  await w.finish();
  await w.advance(44_900);
  assert.deepEqual(w.loadingNow(), [], "not before 45 s, though fast would wait 5.5");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(2)]);
  await w.drain();
  assert.deepEqual([...w.robotsRead], ["a.example"], "read once");
});

await check("a robots.txt that cannot be read leaves its site at 30 s, not at no floor", async () => {
  const w = world({ robots: { "a.example": "unreadable" } });
  await w.q.start([A(1), A(2)], "fast");
  await w.flush();
  await w.finish();
  await w.advance(29_900);
  assert.deepEqual(w.loadingNow(), [], "not before 30 s");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(2)]);
});

await check("Crawl-delay is taken from the groups for every crawler, and held to 300 s", async () => {
  assert.equal(ctx.crawlDelayOf("User-agent: *\nDisallow: /x?\nCrawl-delay: 30\n"), 30, "Hacker News's");
  assert.equal(ctx.crawlDelayOf("User-agent: Googlebot\nCrawl-delay: 99\n\nUser-agent: *\nDisallow:\n"), 0, "another crawler's only");
  assert.equal(ctx.crawlDelayOf("User-agent: bingbot\nUser-agent: *\nCrawl-delay: 5 # be kind\n"), 5, "a group naming several");
  assert.equal(ctx.crawlDelayOf("User-agent: *\nCrawl-delay: 3600\n"), 300, "held to 300");
  assert.equal(ctx.crawlDelayOf(""), 0, "none");
});

await check("a failure doubles its site's wait and a success halves it back", async () => {
  const bad = { ok: false, error: "the page never finished loading" };
  const w = world({ answers: { [A(1)]: bad, [A(2)]: bad } });
  await w.q.start([A(1), A(2), A(3), A(4)]);
  await w.flush();
  await w.finish();
  await w.advance(21_900);
  assert.deepEqual(w.loadingNow(), [], "not before 22 s: one failure makes 10 s × 2 × 1.1");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(2)], "at 22 s");
  await w.finish();
  await w.advance(43_900);
  assert.deepEqual(w.loadingNow(), [], "not before 44 s after a second failure");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(3)], "at 44 s");
  await w.finish();
  await w.advance(21_900);
  assert.deepEqual(w.loadingNow(), [], "a success halves it to 22 s, not straight back to 11");
  await w.advance(100);
  assert.deepEqual(w.loadingNow(), [A(4)]);
});

await check("a capture that read almost nothing is kept but listed, and does not stop its site", async () => {
  const thin = { ok: true, record: { thin: true } };
  const w = world({ answers: { [A(1)]: thin, [A(2)]: thin, [A(3)]: thin } });
  await w.q.start([A(1), A(2), A(3), A(4)]);
  await w.drain();
  const s = structuredClone(await w.q.status());
  assert.deepEqual([s.captured, s.failed.length, Object.keys(s.stoppedSites).length], [1, 3, 0], "captured, listed, stopped sites");
  assert.match(s.failed[0].error, /almost no text/);
});

await check("a finished queue counts its captures and closes its window", async () => {
  const w = world({ captured: [GH(3)] });
  await w.q.start([GH(1), GH(2), GH(3), "file:///tmp/notes.txt"]);
  await w.drain();
  const s = structuredClone(await w.q.status());
  assert.equal(s.status, "done");
  assert.deepEqual([s.total, s.captured, s.skipped, s.failed.length], [3, 2, 1, 0], "total, captured, captured already, failed");
  assert.equal(w.windows.closed, 1);
  assert.equal(w.windows.open.size, 0);
});

await check("a wall stops its site: the site's other links are set aside, other sites carry on", async () => {
  const w = world({ answers: { [IG(1)]: { ok: false, wall: "login", error: "www.instagram.com asked to log in" } } });
  await w.q.start([IG(1), IG(2), IG(3), GH(1), GH(2)]);
  await w.drain();
  const s = structuredClone(await w.q.status());
  assert.deepEqual(w.log.map(([u]) => u), [IG(1), GH(1), GH(2)], "instagram tried once");
  assert.deepEqual(s.failed.map(f => f.url), [IG(1), IG(2), IG(3)]);
  assert.match(s.failed[1].error, /^not tried: www.instagram.com asked to log in/);
  assert.deepEqual(Object.keys(s.stoppedSites), ["instagram.com"]);
  assert.equal(s.captured, 2);
  assert.deepEqual({ ...w.recorded }, { [IG(1)]: "wall", [IG(2)]: "skipped", [IG(3)]: "skipped" }, "each failure kept on its link");
});

await check("three failures in a row stop a site; one success in between does not", async () => {
  const bad = { ok: false, error: "the page never finished loading" };
  const w = world({ answers: { [GH(1)]: bad, [GH(2)]: bad, [GH(4)]: bad, [GH(5)]: bad, [GH(6)]: bad } });
  await w.q.start([1, 2, 3, 4, 5, 6, 7].map(GH));
  await w.drain();
  const s = structuredClone(await w.q.status());
  assert.deepEqual(w.log.map(([u]) => u), [1, 2, 3, 4, 5, 6].map(GH), "the seventh is never loaded");
  assert.deepEqual(s.failed.map(f => f.url), [1, 2, 4, 5, 6, 7].map(GH));
  assert.match(s.stoppedSites["github.com"], /failed 3 times in a row/);
});

await check("retry puts the failed links back and lifts the stop", async () => {
  const answers = { [IG(1)]: { ok: false, wall: "captcha", error: "captcha" } };
  const w = world({ answers });
  await w.q.start([IG(1), IG(2)]);
  await w.drain();
  delete answers[IG(1)];
  await w.q.retry();
  await w.drain();
  const s = structuredClone(await w.q.status());
  assert.deepEqual([s.status, s.captured, s.failed.length], ["done", 2, 0]);
  assert.deepEqual({ ...s.stoppedSites }, {});
});

await check("pause lets the loading pages finish, then waits with its window closed; resume carries on", async () => {
  const w = world();
  await w.q.start([GH(1), GH(2), IG(1)]);
  await w.flush();
  await w.q.pause();
  assert.equal(w.windows.open.size, 1, "open while pages load");
  await w.finish();
  await w.finish();
  assert.equal(w.windows.open.size, 0, "closed once they are read");
  await w.advance(60_000);
  assert.deepEqual(w.loadingNow(), [], "nothing starts while paused");
  await w.q.resume();
  await w.flush();
  assert.deepEqual(w.loadingNow(), [GH(2)]);
  assert.equal(w.windows.opened, 2, "a new window");
  await w.drain();
  assert.equal((structuredClone(await w.q.status())).captured, 3);
});

await check("stop drops the waiting links and keeps what was captured; dismiss clears the line", async () => {
  const w = world();
  await w.q.start([GH(1), GH(2), GH(3)]);
  await w.flush();
  await w.finish();
  await w.q.stop();
  await w.advance(60_000);
  const s = structuredClone(await w.q.status());
  assert.deepEqual([s.status, s.captured, s.pending], ["stopped", 1, 0]);
  assert.equal(w.windows.open.size, 0);
  assert.equal((await w.q.dismiss()).status, "idle");
});

await check("links added to a running queue join its line once each", async () => {
  const w = world();
  await w.q.start([GH(1), GH(2)]);
  const res = await w.q.start([GH(2), GH(3), IG(1)]);
  assert.equal(res.added, 2);
  assert.equal(res.total, 4);
});

await check("a queue put to sleep mid-capture starts again with the page it was reading", async () => {
  const w = world();
  await w.q.start([GH(1), GH(2), IG(1)]);
  await w.flush();
  const saved = w.store();
  assert.equal(saved.active.length, 2);
  const again = world({ saved });
  await again.q.init();
  await again.flush();
  assert.deepEqual(again.loadingNow(), [GH(1), IG(1)]);
  await again.drain();
  assert.equal((structuredClone(await again.q.status())).captured, 3);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
