/* Capture on demand, keep it in the extension, hand it over as a file when asked.
 *
 * Manual trigger only: a hotkey press or popup click is a user gesture, which grants
 * activeTab, which is the only host access needed to read the page you are looking at.
 * There are no content scripts — extractors.js is injected into that one tab and nowhere
 * else, so the extension has no way to see a page you did not ask about.
 *
 * Captures live in storage.local until you export them. Nothing is sent anywhere; the one
 * outbound request is a HEAD to t.co to find out where a shortened link actually points.
 *
 * MV3 background scripts are event pages that get suspended when idle, so no state lives in
 * a module variable: the capture list and the sweep cursor are both in storage.local, and an
 * alarm recovers a sweep that suspension interrupted.
 */

const PACE_MS = 2500;
const TAB_TIMEOUT_MS = 20000;
const TICK = "tick";

/* --- store ---------------------------------------------------------------------- */

async function getCaptures() {
  const { captures } = await browser.storage.local.get("captures");
  return Array.isArray(captures) ? captures : [];
}

async function setCaptures(captures) {
  await browser.storage.local.set({ captures });
  await browser.action.setBadgeText({ text: captures.length ? String(captures.length) : "" });
  await browser.action.setBadgeBackgroundColor({ color: "#7a5cff" });
}

async function getSweep() {
  const { sweep } = await browser.storage.local.get("sweep");
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

/* t.co hides the destination, and the destination is half the reason to keep a tweet. */
async function resolveLinks(links) {
  if (!links?.length) return links || [];
  return Promise.all(
    links.map(async link => {
      if (!/^https?:\/\/t\.co\//.test(link.href || "")) {
        return { ...link, resolved: link.resolved || link.href };
      }
      try {
        const res = await fetch(link.href, { method: "HEAD", redirect: "follow" });
        return { ...link, resolved: res.url || null };
      } catch (e) {
        return { ...link, resolved: null };
      }
    })
  );
}

async function store(record) {
  record.links = await resolveLinks(record.links);
  const captures = await getCaptures();
  const key = record.status_id || record.url;
  // Re-capturing the same thing replaces the old copy rather than duplicating it.
  await setCaptures([...captures.filter(r => (r.status_id || r.url) !== key), record]);
  return { ok: true, total: (await getCaptures()).length };
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
    const res = await store(record);
    return { ok: true, record, total: res.total };
  } catch (e) {
    // Usually activeTab not granted for this tab — trigger again from the page itself.
    return { ok: false, error: String(e.message || e) };
  }
}

browser.commands.onCommand.addListener(name => {
  if (name === "capture-page") captureActive();
});

/* --- sweep ----------------------------------------------------------------------
 * Explicitly started from the popup over a pasted list. Each URL opens in a background
 * tab, is read, and closes. This needs host access to those origins, which the popup
 * requests first: reading a tab you are not looking at is exactly what activeTab does not
 * cover.
 */

async function sweepAdvance() {
  const sweep = await getSweep();
  if (!sweep || sweep.stopped || sweep.done) return;

  if (sweep.tabId != null) {
    await browser.tabs.remove(sweep.tabId).catch(() => {});
    sweep.tabId = null;
  }

  if (sweep.index >= sweep.urls.length) {
    sweep.done = true;
    await setSweep(sweep);
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

  const url = sweep.urls[sweep.index - 1];
  try {
    const record = await extractFrom(tabId);
    if (record) {
      record.via = "sweep";
      await store(record);
    } else {
      sweep.errors.push({ url, error: "nothing extractable" });
      await setSweep(sweep);
    }
  } catch (e) {
    sweep.errors.push({ url, error: String(e.message || e) });
    await setSweep(sweep);
  }
  setTimeout(sweepAdvance, PACE_MS);
});

/* Unstick a sweep whose tab never finished loading. */
browser.alarms.create(TICK, { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== TICK) return;
  const sweep = await getSweep();
  if (!sweep || sweep.stopped || sweep.done || !sweep.startedAt) return;
  if (Date.now() - sweep.startedAt > TAB_TIMEOUT_MS) {
    sweep.errors.push({ url: sweep.urls[sweep.index - 1], error: "timed out" });
    await setSweep(sweep);
    await sweepAdvance();
  }
});

/* --- messaging ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener(async msg => {
  switch (msg.type) {
    case "capture-active":
      return captureActive(msg.note);

    case "status": {
      const captures = await getCaptures();
      const sweep = await getSweep();
      return {
        total: captures.length,
        recent: captures.slice(-5).reverse().map(r => ({
          title: r.title, handle: r.author?.handle, url: r.url, kind: r.kind,
          links: r.links?.length || 0,
        })),
        sweep: sweep && {
          index: sweep.index, total: sweep.urls.length,
          errors: sweep.errors.length, done: !!sweep.done, stopped: !!sweep.stopped,
        },
      };
    }

    case "export":
      return { captures: await getCaptures() };

    case "clear":
      await setCaptures([]);
      return { ok: true };

    case "sweep-start":
      await setSweep({ urls: msg.urls, index: 0, tabId: null, errors: [], startedAt: 0 });
      await sweepAdvance();
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

    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
});

getCaptures().then(setCaptures).catch(() => {});
