/* --- sync between Macs ------------------------------------------------------------------------
 * Every change to a synced storage key is turned into record-level operations here, stamped with a
 * hybrid logical clock, encrypted with a key only the Macs hold, and handed to the helper, which
 * queues them on disk and sends them to the sync server (sync-server/). Other Macs' operations come
 * back the same way and are applied when they are newer than what this Mac holds for that record:
 * the last writer wins per record, a tag per link and tag, a deletion is a record of its own.
 *
 * Records: a capture, a reading-list entry or a Trash entry is one record by its link key or id; a
 * link's agent tags, suggestions or capture failure by link key; a stash's or tab's metadata by
 * bookmark id; each tag on a link on its own; small settings (the tag library, filter rules…) whole.
 * Stashes are bookmarks and travel with Firefox Sync. Keys in SYNC_LOCAL never leave this Mac. A key
 * in neither list is not synced, and tools/test-sync.mjs fails until it is put in one of them.
 *
 * Joining: the first sync of a profile takes the server's snapshot as its whole synced state, after
 * saving the current one as a pre-restore backup. With no snapshot on the server, only the Mac set
 * up as the seed (LINK_KEEPER_SYNC_SEED=1) writes the first one; any other Mac waits for it, so a
 * stale copy can never become everyone's data.
 *
 * Races with the pages' own writes: a write of ours that lands over a page's newer one is noticed
 * (the value before ours is not what we read) and the page's change is put back; a page write that
 * lands over ours within SYNC_RACE_MS, restoring what the record was before, is treated as stale and
 * ours is written again. */

const SYNC_SPEC = {
  captures: { kind: "list", id: r => keyOf(r.url), at: "end" },
  items: { kind: "list", id: r => keyOf(r.url), at: "end" },
  trash: { kind: "list", id: e => e.id, at: "start" },
  linkTags: { kind: "set" },
  agentTags: { kind: "map" },
  tagSuggestions: { kind: "map" },
  captureFails: { kind: "map" },
  stashMeta: { kind: "nested", parts: ["stashes", "tabs"] },
  tagDefs: { kind: "value" },
  filterRules: { kind: "value" },
  filteredAuto: { kind: "value" },
  stashSettings: { kind: "value" },
  folder: { kind: "value" },
  chatGrabs: { kind: "value" },
  watchOnCapture: { kind: "value" },
  agentBrowser: { kind: "value" },
  agentWalled: { kind: "value" },
};
// Caches, per-install bookkeeping, this Mac's place in things and the pages' view settings.
const SYNC_LOCAL = new Set(["favicons", "thumbs", "previews", "dataPatches", "current", "pendingShot", "popupUi",
  "inboxPulledAt", "watchCursor", "stashRoot", "stashMigrating", "storageId", "restoredFrom", "sessions",
  "sessions_before_bookmarks", "viewSources", "stashPreview", "captureSpeed", "listGroup", "listCompact",
  "listCompactPane", "listGroupSort", "listFolded", "listCards", "listCardsShuffle", "popupChatRange",
  "syncPending", "syncClock", "syncState", "syncHlc"]);
const SYNC_LOCAL_PREFIX = ["pvimg"];
const SYNC_RACE_MS = 15e3;
const SYNC_EVERY_MS = 3 * 60e3;
const SYNC_BATCH_OPS = 200;
const SYNC_SNAPSHOT_EVERY = 1000;   // batches past the last snapshot before this Mac writes a new one
const SEP = "\u0001";

const sync = {
  cfg: null, key: null, timer: null, running: null, last: null, error: null,
  expected: new Map(),   // key -> [{ hash: what our write leaves, read: what we wrote over }], oldest first
  recent: new Map(),     // "k\u0002r" -> { before, value, at }: records a remote op just wrote
};
const syncQueue = serial();

/* --- clocks ------------------------------------------------------------------------------- */

/* A hybrid logical clock as a string that sorts in time order: milliseconds, a counter, the device. */
function hlcString(ms, c, device) {
  return `${String(ms).padStart(15, "0")}.${String(c).padStart(5, "0")}.${device}`;
}
function hlcParse(t) {
  const [ms, c] = String(t).split(".");
  return { ms: Number(ms) || 0, c: Number(c) || 0 };
}
function hlcNext(last, device, nowMs = Date.now()) {
  const ms = Math.max(nowMs, last.ms);
  const c = ms === last.ms ? last.c + 1 : 0;
  return { clock: { ms, c }, t: hlcString(ms, c, device) };
}
function hlcSeen(last, t) {
  const r = hlcParse(t);
  return r.ms > last.ms || (r.ms === last.ms && r.c > last.c) ? r : last;
}

/* --- records ------------------------------------------------------------------------------ */

function syncHash(value) {
  const s = JSON.stringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
}

/* Every record of one key's value: Map of record id -> value (true for a tag on a link). */
function syncRecords(k, value) {
  const spec = SYNC_SPEC[k], out = new Map();
  if (value === undefined) return out;
  switch (spec.kind) {
    case "list": for (const r of Array.isArray(value) ? value : []) { try { out.set(spec.id(r), r); } catch { /* not a record */ } } break;
    case "map": for (const [r, v] of Object.entries(value || {})) out.set(r, v); break;
    case "set": for (const [link, tags] of Object.entries(value || {})) for (const tag of tags || []) out.set(link + SEP + tag, true); break;
    case "nested": for (const part of spec.parts) for (const [id, v] of Object.entries(value?.[part] || {})) out.set(part + SEP + id, v); break;
    case "value": out.set("", value); break;
  }
  return out;
}

/* What changed between two values of a key, as [record id, value or undefined for a deletion]. */
function syncDiff(k, before, after) {
  const a = syncRecords(k, before), b = syncRecords(k, after), out = [];
  for (const [r, v] of b) if (!a.has(r) || syncHash(a.get(r)) !== syncHash(v)) out.push([r, v]);
  for (const r of a.keys()) if (!b.has(r)) out.push([r, undefined]);
  return out;
}

/* A key's value with records set or removed: `changes` is [[record id, value or undefined]]. */
function syncPut(k, value, changes) {
  const spec = SYNC_SPEC[k];
  switch (spec.kind) {
    case "list": {
      const list = Array.isArray(value) ? [...value] : [];
      for (const [r, v] of changes) {
        const i = list.findIndex(x => { try { return spec.id(x) === r; } catch { return false; } });
        if (v === undefined) { if (i >= 0) list.splice(i, 1); }
        else if (i >= 0) list[i] = v;
        else if (spec.at === "start") list.unshift(v);
        else list.push(v);
      }
      return list;
    }
    case "map": {
      const map = { ...(value || {}) };
      for (const [r, v] of changes) { if (v === undefined) delete map[r]; else map[r] = v; }
      return map;
    }
    case "set": {
      const map = Object.fromEntries(Object.entries(value || {}).map(([l, t]) => [l, [...(t || [])]]));
      for (const [r, v] of changes) {
        const [link, tag] = r.split(SEP);
        const tags = map[link] || [];
        if (v === undefined) {
          const left = tags.filter(t => t !== tag);
          if (left.length) map[link] = left; else delete map[link];
        } else if (!tags.includes(tag)) map[link] = [...tags, tag];
      }
      return map;
    }
    case "nested": {
      const out = { ...(value || {}) };
      for (const part of spec.parts) out[part] = { ...(out[part] || {}) };
      for (const [r, v] of changes) {
        const [part, id] = r.split(SEP);
        if (!spec.parts.includes(part)) continue;
        if (v === undefined) delete out[part][id]; else out[part][id] = v;
      }
      return out;
    }
    case "value": {
      const last = changes[changes.length - 1];
      return last ? last[1] : value;
    }
  }
  return value;
}

const clockId = (k, r) => `${k}\u0002${r}`;

/* Writes of ours that storage.onChanged has not reported yet. Each write that changes a key is one
 * event, so each mark is taken by exactly one; a write that changes nothing is never marked. */
function expectWrite(k, value, read) {
  if (!sync.expected.has(k)) sync.expected.set(k, []);
  sync.expected.get(k).push({ hash: syncHash(value), read });
}
function takeExpected(k, newValue) {
  const list = sync.expected.get(k);
  if (!list?.length) return null;
  const h = syncHash(newValue);
  const i = list.findIndex(e => e.hash === h);
  if (i < 0) return null;
  const [mark] = list.splice(0, i + 1).slice(-1);
  if (!list.length) sync.expected.delete(k);
  return mark;
}

/* Write a key's new value unless it is what storage already holds, marking it as ours. */
async function writeOurs(k, value, read) {
  if (syncHash(value) === syncHash(read)) return false;
  expectWrite(k, value, read);
  if (value === undefined) await browser.storage.local.remove(k); else await browser.storage.local.set({ [k]: value });
  return true;
}

/* Operations from other Macs (or a snapshot), applied where newer than what this Mac holds.
 * Returns how many records changed. */
async function syncApply(ops) {
  if (!ops.length) return 0;
  const byKey = new Map();
  const got = await browser.storage.local.get(["syncClock", "syncHlc"]);
  const clock = got.syncClock || {};
  let hlc = got.syncHlc || { ms: 0, c: 0 };
  for (const op of ops) {
    hlc = hlcSeen(hlc, op.t);
    if (!SYNC_SPEC[op.k]) continue;
    const id = clockId(op.k, op.r);
    if (clock[id] && clock[id] >= op.t) continue;
    clock[id] = op.t;
    if (!byKey.has(op.k)) byKey.set(op.k, []);
    byKey.get(op.k).push([op.r, op.d ? undefined : op.v]);
  }
  let changed = 0;
  for (const [id, rec] of sync.recent) if (Date.now() - rec.at > SYNC_RACE_MS) sync.recent.delete(id);
  // The same queues the pages edit tags, filters and stash metadata in, so no edit already under way
  // writes back what it read before this.
  await filterQueue(() => tagQueue(() => metaQueue(async () => {
    const now = await browser.storage.local.get([...byKey.keys()]);
    for (const [k, changes] of byKey) {
      const before = syncRecords(k, now[k]);
      for (const [r, v] of changes) {
        sync.recent.set(clockId(k, r), { before: syncHash(before.get(r)), value: v, at: Date.now() });
      }
      if (await writeOurs(k, syncPut(k, now[k], changes), now[k])) changed += changes.length;
    }
    await browser.storage.local.set({ syncClock: clock, syncHlc: hlc });
  })));
  return changed;
}

/* --- recording this Mac's changes ------------------------------------------------------------ */

async function syncRecord(changes) {
  const state = (await browser.storage.local.get("syncState")).syncState;
  if (!state?.joined || !sync.cfg?.enabled) {
    // Not syncing yet: nothing is recorded, but our own writes (a join) still take their marks.
    for (const [k, ch] of Object.entries(changes)) if (SYNC_SPEC[k]) takeExpected(k, ch.newValue);
    return;
  }
  const got = await browser.storage.local.get(["syncPending", "syncClock", "syncHlc"]);
  const pending = got.syncPending || [], clock = got.syncClock || {};
  let hlc = got.syncHlc || { ms: 0, c: 0 };
  const redo = new Map();   // key -> [[r, v]] to write again
  let n = pending.length ? pending[pending.length - 1].n : 0;
  for (const [k, ch] of Object.entries(changes)) {
    if (!SYNC_SPEC[k]) continue;
    const ours = takeExpected(k, ch.newValue);
    if (ours) {
      // Our own write. If a page wrote in between our read and our write, its change was lost under
      // ours: it was recorded when it happened, so only this Mac needs it back.
      if (syncHash(ch.oldValue) !== syncHash(ours.read)) {
        const lost = syncDiff(k, ours.read, ch.oldValue);
        if (lost.length) redo.set(k, [...(redo.get(k) || []), ...lost]);
      }
      continue;
    }
    for (const [r, v] of syncDiff(k, ch.oldValue, ch.newValue)) {
      const id = clockId(k, r), rec = sync.recent.get(id);
      // A page wrote back what the record was before a remote change landed: a stale read, not an edit.
      if (rec && Date.now() - rec.at < SYNC_RACE_MS && syncHash(v) === rec.before) {
        redo.set(k, [...(redo.get(k) || []), [r, rec.value]]);
        continue;
      }
      const next = hlcNext(hlc, sync.cfg.device);
      hlc = next.clock;
      clock[id] = next.t;
      pending.push(v === undefined ? { n: ++n, k, r, d: 1, t: next.t } : { n: ++n, k, r, v, t: next.t });
    }
  }
  await browser.storage.local.set({ syncPending: pending, syncClock: clock, syncHlc: hlc });
  for (const [k, changes] of redo) {
    await filterQueue(() => tagQueue(() => metaQueue(async () => {
      const now = (await browser.storage.local.get(k))[k];
      await writeOurs(k, syncPut(k, now, changes), now);
    })));
  }
  if (pending.length) syncSoon(5e3);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some(k => SYNC_SPEC[k])) return;
  syncQueue(() => syncRecord(changes)).catch(e => { sync.error = `recording a change: ${e.message || e}`; });
});

/* --- encryption ------------------------------------------------------------------------------ */

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(text) {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function syncSeal(obj) {
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream()
    .pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sync.key, gz));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64encode(out);
}
async function syncOpen(blob) {
  const raw = b64decode(blob);
  const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) }, sync.key, raw.subarray(12));
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

/* --- snapshots ------------------------------------------------------------------------------- */

async function syncSnapshotBody() {
  const got = await browser.storage.local.get([...Object.keys(SYNC_SPEC), "syncClock"]);
  const storage = {};
  for (const k of Object.keys(SYNC_SPEC)) if (k in got) storage[k] = got[k];
  return { format: "link-keeper-sync-snapshot", v: 1, at: new Date().toISOString(), storage, clock: got.syncClock || {} };
}

/* A snapshot's records as operations, tombstones included, so merging it is applying them. */
function syncSnapshotOps(snap) {
  const ops = [];
  for (const [id, t] of Object.entries(snap.clock || {})) {
    const [k, r] = id.split("\u0002");
    if (!SYNC_SPEC[k]) continue;
    const recs = syncRecords(k, snap.storage?.[k]);
    ops.push(recs.has(r) ? { k, r, v: recs.get(r), t } : { k, r, d: 1, t });
  }
  return ops;
}

/* Stamps every record this Mac holds, for the first snapshot. */
async function syncStampAll() {
  const got = await browser.storage.local.get([...Object.keys(SYNC_SPEC), "syncHlc"]);
  let hlc = got.syncHlc || { ms: 0, c: 0 };
  const clock = {};
  for (const k of Object.keys(SYNC_SPEC)) {
    for (const r of syncRecords(k, got[k]).keys()) {
      const next = hlcNext(hlc, sync.cfg.device);
      hlc = next.clock;
      clock[clockId(k, r)] = next.t;
    }
  }
  await browser.storage.local.set({ syncClock: clock, syncHlc: hlc, syncPending: [] });
}

/* Take the server's snapshot as this profile's whole synced state, after a pre-restore backup. */
async function syncAdopt(snapRes) {
  const snap = await syncOpen(snapRes.blob);
  if (snap.format !== "link-keeper-sync-snapshot") throw new Error("the server's snapshot is not a Link Keeper sync snapshot");
  const saved = await backupNow("pre-restore").catch(e => ({ ok: false, error: String(e.message || e) }));
  if (!saved.ok && bridge.folder) throw new Error(`the current data could not be saved first: ${saved.error}`);
  await filterQueue(() => tagQueue(() => metaQueue(async () => {
    const keys = Object.keys(SYNC_SPEC);
    const now = await browser.storage.local.get(keys);
    for (const k of keys) await writeOurs(k, snap.storage?.[k], now[k]);
    let hlc = { ms: 0, c: 0 };
    for (const t of Object.values(snap.clock || {})) hlc = hlcSeen(hlc, t);
    await browser.storage.local.set({ syncClock: snap.clock || {}, syncHlc: hlc, syncPending: [] });
  })));
  applyFilterRules().catch(() => {});
  return snap;
}

/* --- the loop ------------------------------------------------------------------------------- */

async function syncConfigure() {
  const cfg = await hostCall("sync-config");
  sync.cfg = cfg;
  sync.key = cfg.enabled
    ? await crypto.subtle.importKey("raw", b64decode(cfg.key), "AES-GCM", false, ["encrypt", "decrypt"])
    : null;
  return cfg;
}

async function syncJoin(state) {
  const snap = await hostCall("sync-snapshot-get");
  if (!snap.ok) throw new Error(snap.error);
  if (snap.none) {
    if (!sync.cfg.seed) return { ...state, waiting: "the server has no data yet: waiting for the Mac set up as the seed" };
    await syncStampAll();
    const put = await hostCall("sync-snapshot-put", { upto: 0, blob: await syncSeal(await syncSnapshotBody()) });
    if (!put.ok) throw new Error(`writing the first snapshot: ${put.error}`);
    return { joined: true, cursor: 0, snapUpto: 0, at: new Date().toISOString(), seeded: true };
  }
  await syncAdopt(snap);
  return { joined: true, cursor: snap.upto, snapUpto: snap.upto, at: new Date().toISOString(), adopted: snap.at };
}

async function syncPush() {
  const { syncPending: pending = [] } = await browser.storage.local.get("syncPending");
  if (!pending.length) return { pushed: 0 };
  const batches = [];
  for (let i = 0; i < pending.length; i += SYNC_BATCH_OPS) {
    const ops = pending.slice(i, i + SYNC_BATCH_OPS).map(({ n, ...op }) => op);
    batches.push({ id: `${sync.cfg.device}.${ops[0].t.split(".").slice(0, 2).join("-")}.${crypto.randomUUID().slice(0, 8)}`,
      blob: await syncSeal({ ops }) });
  }
  const res = await hostCall("sync-push", { batches });
  // The helper wrote them to its outbox before sending, so they are safe on disk either way.
  const upto = pending[pending.length - 1].n;
  await syncQueue(async () => {
    const now = (await browser.storage.local.get("syncPending")).syncPending || [];
    await browser.storage.local.set({ syncPending: now.filter(op => op.n > upto) });
  });
  if (!res.ok) throw new Error(`sending: ${res.error} (${res.queued} batches wait in the helper's outbox)`);
  return { pushed: res.pushed };
}

async function syncPull(state) {
  let cursor = state.cursor || 0, applied = 0;
  for (let page = 0; page < 1000; page++) {
    const res = await hostCall("sync-pull", { since: cursor, limit: 200 });
    if (res.behind) {
      // Batches this Mac had not seen were folded into a newer snapshot: merge it record by record.
      const snapRes = await hostCall("sync-snapshot-get");
      if (!snapRes.ok || snapRes.none) throw new Error(snapRes.error || "the server lost its snapshot");
      applied += await syncApply(syncSnapshotOps(await syncOpen(snapRes.blob)));
      cursor = snapRes.upto;
      continue;
    }
    if (!res.ok) throw new Error(`fetching: ${res.error}`);
    // This device's own batches are applied too: a fresh profile on the same Mac never had them, and
    // for the profile that made them each record's clock already holds that change, so it is skipped.
    for (const b of res.ops) {
      applied += await syncApply((await syncOpen(b.blob)).ops || []);
      cursor = b.seq;
    }
    await browser.storage.local.set({ syncState: { ...state, cursor, last: res.last } });
    if (!res.more) break;
  }
  return { cursor, applied };
}

async function syncNow() {
  if (sync.running) return sync.running;
  sync.running = (async () => {
    try {
      if (bridge.state !== "on") return { ok: false, error: bridge.error || "the helper is not running" };
      const cfg = await syncConfigure();
      if (!cfg.enabled) return { ok: true, enabled: false, missing: cfg.missing };
      let state = (await browser.storage.local.get("syncState")).syncState || {};
      if (!state.joined) {
        state = await syncJoin(state);
        await browser.storage.local.set({ syncState: state });
        if (!state.joined) return { ok: true, enabled: true, waiting: state.waiting };
      }
      const pushed = await syncPush();
      const pulled = await syncPull(state);
      state = (await browser.storage.local.get("syncState")).syncState;
      if (pulled.cursor - (state.snapUpto || 0) >= SYNC_SNAPSHOT_EVERY) {
        const put = await hostCall("sync-snapshot-put", { upto: pulled.cursor, blob: await syncSeal(await syncSnapshotBody()) });
        if (put.ok) state = { ...state, snapUpto: pulled.cursor };
      }
      state = { ...state, at: new Date().toISOString() };
      await browser.storage.local.set({ syncState: state });
      sync.error = null;
      sync.last = { at: state.at, pushed: pushed.pushed, applied: pulled.applied, cursor: pulled.cursor };
      return { ok: true, enabled: true, ...sync.last };
    } catch (e) {
      sync.error = String(e.message || e);
      return { ok: false, error: sync.error };
    } finally {
      sync.running = null;
      syncSoon(SYNC_EVERY_MS);
    }
  })();
  return sync.running;
}

function syncSoon(ms) {
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow().catch(() => {}), ms);
}

/* Links opening, a wake from sleep, a new start: reach the helper if it is not up, then sync. */
function syncWake() {
  if (!bridge.port) { clearTimeout(bridge.retryTimer); bridgeConnect(); }
  else if (bridge.state === "on") syncSoon(1e3);
}

async function syncStatus() {
  const got = await browser.storage.local.get(["syncState", "syncPending"]);
  const helper = bridge.state === "on" ? await hostCall("sync-status").catch(e => ({ ok: false, error: String(e.message || e) })) : null;
  return {
    ok: true, device: sync.cfg?.device || helper?.device || null, enabled: !!sync.cfg?.enabled,
    missing: sync.cfg?.missing || helper?.missing || null, state: got.syncState || null,
    pending: (got.syncPending || []).length, outbox: helper?.queued ?? null, last: sync.last, error: sync.error,
  };
}

browser.runtime.onStartup.addListener(() => syncWake());
