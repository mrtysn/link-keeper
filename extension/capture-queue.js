/* The capture queue: many links captured one after another, out of sight.
 *
 * Links' selection bar starts it with the ticked links; everything after runs here, in the background
 * page, so closing Links does not stop it. Each link is read by captureUrl in a minimised window of its
 * own, two at a time, never two of one site at once. A site waits between its pages (SITE_GAPS: half a
 * minute for the sites a login belongs to), so a run looks like a person reading, not a crawler. A site
 * that answers with a wall (a login page, a captcha, a block) or fails three times in a row is stopped:
 * its remaining links are set aside as failed, with the reason, and the rest carry on. Retry failed puts
 * them back.
 *
 * The state lives in storage.session: it outlives the background page being put to sleep and Links being
 * closed, and ends with Firefox, so a queue never starts loading pages by itself at the next launch.
 * Agents can read it (capture-queue-status) but never start one: that stays with the person at the
 * browser, as every tab the add-on opens does.
 *
 * makeCaptureQueue takes its effects as arguments so tools/test-capture-queue.mjs can run it on a clock
 * of its own; the bottom of this file wires it to the browser. */

const CAPTURE_WORKERS = 2;
const SITE_STOP_AFTER = 3;   // failures in a row that stop a site
const SITE_GAPS = [
  // [host pattern, seconds between two pages of that site]
  [/(^|\.)(instagram\.com|x\.com|twitter\.com|linkedin\.com|facebook\.com|threads\.(net|com)|tiktok\.com)$/, 30],
  [/(^|\.)(reddit\.com|youtube\.com|google\.[a-z.]+)$/, 8],
];
const DEFAULT_GAP = 2;

const siteKey = url => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
};
const siteGap = host => (SITE_GAPS.find(([re]) => re.test(host))?.[1] ?? DEFAULT_GAP) * 1000;

function makeCaptureQueue(fx) {
  // fx: capture(url, windowId) → { ok, error, wall }, isCaptured(url), load(), save(state), openWindow() → id,
  //     windowAlive(id), closeWindow(id), now(), setTimer(fn, ms), random()
  let state = null;
  const busy = new Set();   // sites with a page loading now
  let timer = null;

  const blank = () => ({ status: "idle", total: 0, captured: 0, skipped: 0, pending: [], active: [], failed: [], stoppedSites: {}, streaks: {}, nextAt: {}, windowId: null, started_at: null });
  const save = () => fx.save(state);
  const view = () => ({ ...state, pending: state.pending.length, next: nextWait() });

  // The soonest moment a waiting link may start, with its site, for the progress line.
  function nextWait() {
    let best = null;
    for (const url of state.pending) {
      const host = siteKey(url);
      if (busy.has(host)) continue;
      const at = state.nextAt[host] || 0;
      if (!best || at < best.at) best = { host, at };
    }
    return best;
  }

  async function init() {
    if (state) return;
    state = (await fx.load()) || blank();
    // A page put to sleep mid-capture: what was loading goes back to the front of the line.
    if (state.active.length) { state.pending.unshift(...state.active); state.active = []; await save(); }
    if (state.status === "running") pump();
  }

  // Both workers may ask at once; they share one window.
  let opening = null;
  function ensureWindow() {
    return opening ||= (async () => {
      if (state.windowId == null || !await fx.windowAlive(state.windowId)) state.windowId = await fx.openWindow();
      return state.windowId;
    })().finally(() => { opening = null; });
  }

  async function closeWindow() {
    if (state.windowId == null) return;
    const id = state.windowId;
    state.windowId = null;
    await fx.closeWindow(id);
  }

  // Sets a site aside: its waiting links fail with the reason, and nothing more of it is loaded.
  function stopSite(host, reason) {
    state.stoppedSites[host] = reason;
    const left = state.pending.filter(u => siteKey(u) === host);
    state.pending = state.pending.filter(u => siteKey(u) !== host);
    for (const url of left) state.failed.push({ url, error: `not tried: ${reason}` });
  }

  function pump() {
    clearTimeout(timer);
    timer = null;
    if (state.status !== "running") return;
    while (state.active.length < CAPTURE_WORKERS) {
      const now = fx.now();
      const i = state.pending.findIndex(u => { const h = siteKey(u); return !busy.has(h) && (state.nextAt[h] || 0) <= now; });
      if (i === -1) break;
      const [url] = state.pending.splice(i, 1);
      work(url);
    }
    if (!state.active.length && !state.pending.length) { finish(); return; }
    const next = nextWait();
    if (next && state.active.length < CAPTURE_WORKERS) timer = fx.setTimer(pump, Math.max(50, next.at - fx.now()));
  }

  async function work(url) {
    const host = siteKey(url);
    busy.add(host);
    state.active.push(url);
    save();   // Links shows what is loading; a page put to sleep now picks it up again
    let res;
    let loaded = true;
    try {
      if (await fx.isCaptured(url)) { res = { ok: true, skipped: true }; loaded = false; }
      else res = await fx.capture(url, await ensureWindow());
    } catch (e) {
      res = { ok: false, error: String(e.message || e) };
    }
    busy.delete(host);
    state.active = state.active.filter(u => u !== url);
    if (state.status === "idle") return;   // dismissed while it loaded
    if (loaded) state.nextAt[host] = fx.now() + siteGap(host) * (0.8 + 0.6 * fx.random());
    if (res.ok) {
      res.skipped ? state.skipped++ : state.captured++;
      delete state.streaks[host];
    } else {
      state.failed.push({ url, error: res.error || "failed" });
      state.streaks[host] = (state.streaks[host] || 0) + 1;
      if (res.wall) stopSite(host, res.error || `${host} put up a ${res.wall} page`);
      else if (state.streaks[host] >= SITE_STOP_AFTER) stopSite(host, `${host} failed ${SITE_STOP_AFTER} times in a row`);
    }
    pump();
    // Paused or stopped: the window goes once its last page is read.
    if (state.status !== "running" && !state.active.length) await closeWindow();
    await save();
  }

  async function finish() {
    state.status = "done";
    await closeWindow();
    await save();
  }

  return {
    init,
    status: async () => { await init(); return view(); },

    // Adds links to the line, starting it if it is not running. A finished queue starts its counts over.
    async start(urls) {
      await init();
      if (!["running", "paused"].includes(state.status)) state = { ...blank(), windowId: state.windowId, started_at: new Date(fx.now()).toISOString() };
      const held = new Set([...state.pending, ...state.active]);
      let added = 0;
      for (const url of urls || []) {
        if (!/^https?:\/\//.test(url) || held.has(url)) continue;
        held.add(url);
        state.pending.push(url);
        added++;
      }
      state.total += added;
      if (state.status !== "paused") state.status = "running";
      await save();
      pump();
      return { ok: true, added, ...view() };
    },

    // Lets the pages loading now finish, then waits; the window closes until it resumes.
    async pause() {
      await init();
      if (state.status !== "running") return { ok: false, error: "the capture queue is not running" };
      state.status = "paused";
      clearTimeout(timer);
      if (!state.active.length) await closeWindow();
      await save();
      return { ok: true, ...view() };
    },

    async resume() {
      await init();
      if (state.status !== "paused") return { ok: false, error: "the capture queue is not paused" };
      state.status = "running";
      await save();
      pump();
      return { ok: true, ...view() };
    },

    // Drops what is still waiting; what was captured stays captured.
    async stop() {
      await init();
      clearTimeout(timer);
      state.pending = [];
      state.status = state.active.length || state.captured || state.failed.length ? "stopped" : "idle";
      if (!state.active.length) await closeWindow();
      await save();
      return { ok: true, ...view() };
    },

    // The failed links go back in line, their sites no longer stopped.
    async retry() {
      await init();
      const urls = state.failed.map(f => f.url);
      if (!urls.length) return { ok: false, error: "nothing failed" };
      state.failed = [];
      state.stoppedSites = {};
      state.streaks = {};
      if (!["running", "paused"].includes(state.status)) state.status = "running";
      state.pending.push(...urls.filter(u => !state.pending.includes(u)));
      await save();
      pump();
      return { ok: true, ...view() };
    },

    // Clears a finished or stopped queue's line from Links.
    async dismiss() {
      await init();
      if (["running", "paused"].includes(state.status)) return { ok: false, error: "stop the capture queue first" };
      clearTimeout(timer);
      await closeWindow();
      state = blank();
      await save();
      return { ok: true, ...view() };
    },
  };
}

if (typeof browser !== "undefined" && typeof captureUrl === "function") {
  var captureQueue = makeCaptureQueue({
    capture: (url, windowId) => captureUrl(url, "", windowId),
    isCaptured: async url => (await getCaptures()).some(c => keyOf(c.url) === keyOf(url)),
    load: async () => (await browser.storage.session.get("captureQueue")).captureQueue || null,
    save: state => browser.storage.session.set({ captureQueue: state }),
    // Minimised from the start, so it never takes focus; its blank tab keeps it open between pages.
    openWindow: async () => (await browser.windows.create({ url: "about:blank", state: "minimized" })).id,
    windowAlive: id => browser.windows.get(id).then(() => true, () => false),
    closeWindow: id => browser.windows.remove(id).catch(() => {}),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    random: Math.random,
  });
  captureQueue.init();
}
