/* Capture on demand, queue durably, POST to the local sink.
 *
 * Manual trigger only: a hotkey press or popup click is a user gesture, which grants
 * activeTab, which is the only host access needed to read the page you are looking at.
 * There are no content scripts — extractors.js is injected into that one tab and nowhere
 * else, so the extension cannot see a page you did not ask about.
 *
 * MV3 background scripts are event pages that get suspended when idle, so nothing lives in
 * a module variable across steps: the queue and the backfill cursor are both in
 * storage.local, and an alarm recovers a sweep that suspension interrupted.
 */

const DEFAULTS = { sinkUrl: "http://127.0.0.1:8788/capture", token: "" };
const TICK = "tick";
const PACE_MS = 2500;
const TAB_TIMEOUT_MS = 20000;

/* --- state ---------------------------------------------------------------------- */

async function get(keys) {
  return browser.storage.local.get(keys);
}

async function config() {
  return { ...DEFAULTS, ...(await get(["sinkUrl", "token"])) };
}

async function getQueue() {
  const { queue } = await get("queue");
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await browser.storage.local.set({ queue });
  await browser.action.setBadgeText({ text: queue.length ? String(queue.length) : "" });
  await browser.action.setBadgeBackgroundColor({ color: queue.length ? "#c2422f" : "#17915c" });
}

async function getSweep() {
  const { sweep } = await get("sweep");
  return sweep || null;
}

async function setSweep(sweep) {
  await browser.storage.local.set({ sweep });
}

/* --- extraction ----------------------------------------------------------------- */

/* Injected into the target tab. extractors.js returns null while a single-page app is
 * still hydrating, so poll briefly rather than capture an empty shell. */
async function runExtractor() {
  for (let i = 0; i < 12; i++) {
    const record = LK.extract();
    if (record) return record;
    await new Promise(r => setTimeout(r, 250));
  }
  return { kind: "page", title: document.title || null, url: location.href, incomplete: true };
}

async function extractFrom(tabId) {
  await browser.scripting.executeScript({ target: { tabId }, files: ["extractors.js"] });
  const [result] = await browser.scripting.executeScript({ target: { tabId }, func: runExtractor });
  const record = result?.result;
  if (!record) return null;
  record.url = (record.url || record.canonical || "").split("#")[0] || null;
  record.captured_at = record.captured_at || new Date().toISOString();
  return record.url ? record : null;
}

/* --- sending -------------------------------------------------------------------- */

/* t.co hides the destination, and the destination is half the reason to keep a tweet. */
async function resolveLinks(links) {
  if (!links?.length) return links || [];
  return Promise.all(
    links.map(async link => {
      if (!/^https?:\/\/t\.co\//.test(link.href || "")) return { ...link, resolved: link.resolved || link.href };
      try {
        const res = await fetch(link.href, { method: "HEAD", redirect: "follow" });
        return { ...link, resolved: res.url || null };
      } catch (e) {
        return { ...link, resolved: null };
      }
    })
  );
}

async function enqueue(record) {
  record.links = await resolveLinks(record.links);
  const queue = await getQueue();
  const key = record.status_id || record.url;
  // Re-capturing the same thing replaces the pending copy rather than duplicating it.
  await setQueue([...queue.filter(r => (r.status_id || r.url) !== key), record]);
  return flush();
}

async function flush() {
  const queue = await getQueue();
  if (!queue.length) return { ok: true, sent: 0 };

  const { sinkUrl, token } = await config();
  if (!token) return { ok: false, error: "no token set — see Sink settings" };

  try {
    const res = await fetch(sinkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sink-Token": token },
      body: JSON.stringify(queue),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const error = `sink ${res.status} ${detail.slice(0, 120)}`;
      await browser.storage.local.set({ lastError: error });
      return { ok: false, error };
    }
    const { sent = 0 } = await get("sent");
    await setQueue([]);
    await browser.storage.local.set({ sent: sent + queue.length, lastError: "" });
    return { ok: true, sent: queue.length };
  } catch (e) {
    const error = String(e.message || e);
    await browser.storage.local.set({ lastError: error });
    return { ok: false, error };
  }
}

async function captureActive(note = "") {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "no active tab" };
  if (/^(about|moz-extension|view-source):/.test(tab.url || "")) {
    return { ok: false, error: "nothing to capture on a browser page" };
  }
  try {
    const record = await extractFrom(tab.id);
    if (!record) return { ok: false, error: "could not read that page" };
    if (note) record.note = note;
    const res = await enqueue(record);
    return { ok: true, record, sent: res.ok, error: res.ok ? "" : res.error };
  } catch (e) {
    // Almost always activeTab not being granted for this tab — re-trigger from the page.
    return { ok: false, error: String(e.message || e) };
  }
}

browser.commands.onCommand.addListener(name => {
  if (name === "capture-page") captureActive();
});

/* --- backfill sweep -------------------------------------------------------------
 * Explicitly started from the popup over a pasted list. Each URL opens in a background
 * tab, is scraped, and closes. This needs host access to those origins, which the popup
 * requests before starting; injection into a tab you are not looking at is exactly what
 * activeTab does not cover.
 */

async function sweepAdvance(reason) {
  const sweep = await getSweep();
  if (!sweep || sweep.stopped || sweep.done) return;

  if (sweep.tabId != null) {
    await browser.tabs.remove(sweep.tabId).catch(() => {});
    sweep.tabId = null;
  }

  if (sweep.index >= sweep.urls.length) {
    sweep.done = true;
    await setSweep(sweep);
    await flush();
    return;
  }

  const url = sweep.urls[sweep.index++];
  try {
    const tab = await browser.tabs.create({ url, active: false });
    sweep.tabId = tab.id;
    sweep.startedAt = Date.now();
  } catch (e) {
    sweep.errors.push({ url, error: String(e.message || e) });
  }
  await setSweep(sweep);
}

/* Driven by page-load rather than a timer, so a suspended event page cannot lose the
 * thread — onUpdated wakes it back up. */
browser.tabs.onUpdated.addListener(async (tabId, changed) => {
  if (changed.status !== "complete") return;
  const sweep = await getSweep();
  if (!sweep || sweep.stopped || sweep.done || sweep.tabId !== tabId) return;

  try {
    const record = await extractFrom(tabId);
    if (record) {
      record.via = "backfill";
      await enqueue(record);
    } else {
      sweep.errors.push({ url: sweep.urls[sweep.index - 1], error: "nothing extractable" });
      await setSweep(sweep);
    }
  } catch (e) {
    sweep.errors.push({ url: sweep.urls[sweep.index - 1], error: String(e.message || e) });
    await setSweep(sweep);
  }
  setTimeout(() => sweepAdvance("captured"), PACE_MS);
});

/* Retry the queue, and unstick a sweep whose tab never finished loading. */
browser.alarms.create(TICK, { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== TICK) return;
  await flush();
  const sweep = await getSweep();
  if (sweep && !sweep.stopped && !sweep.done && sweep.startedAt) {
    if (Date.now() - sweep.startedAt > TAB_TIMEOUT_MS) {
      sweep.errors.push({ url: sweep.urls[sweep.index - 1], error: "timed out" });
      await setSweep(sweep);
      await sweepAdvance("timeout");
    }
  }
});

/* --- messaging ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener(async msg => {
  switch (msg.type) {
    case "capture-active":
      return captureActive(msg.note);

    case "status": {
      const { sent = 0, lastError = "" } = await get(["sent", "lastError"]);
      const { sinkUrl, token } = await config();
      const sweep = await getSweep();
      let reachable = false, captures = null;
      try {
        const res = await fetch(sinkUrl.replace(/\/capture$/, "/health"));
        if (res.ok) { reachable = true; captures = (await res.json()).captures; }
      } catch (e) { /* sink not running */ }
      return {
        queued: (await getQueue()).length,
        sent, lastError, reachable, captures, sinkUrl, hasToken: !!token,
        sweep: sweep && {
          index: sweep.index, total: sweep.urls.length,
          errors: sweep.errors.length, done: !!sweep.done, stopped: !!sweep.stopped,
        },
      };
    }

    case "save-config":
      await browser.storage.local.set({
        sinkUrl: msg.sinkUrl || DEFAULTS.sinkUrl,
        token: msg.token || (await config()).token,
      });
      return flush();

    case "flush":
      return flush();

    case "sweep-start":
      await setSweep({ urls: msg.urls, index: 0, tabId: null, errors: [], startedAt: 0 });
      await sweepAdvance("start");
      return { ok: true, total: msg.urls.length };

    case "sweep-stop": {
      const sweep = await getSweep();
      if (sweep) {
        sweep.stopped = true;
        if (sweep.tabId != null) await browser.tabs.remove(sweep.tabId).catch(() => {});
        sweep.tabId = null;
        await setSweep(sweep);
      }
      return { ok: true };
    }

    case "sweep-errors": {
      const sweep = await getSweep();
      return { errors: sweep?.errors || [] };
    }

    case "export-queue":
      return { queue: await getQueue() };

    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
});

getQueue().then(setQueue).catch(() => {});
