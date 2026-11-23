#!/usr/bin/env node
// DESC: Check sync between Macs: two simulated Macs run the real extension/sync.js against an in-memory server.
//
// Each simulated Mac is a vm context holding extension/links.js and extension/sync.js with a fake
// browser.storage (onChanged fires after each write, as Firefox's does) and a fake helper that talks to
// one in-memory sync server with the real server's rules. Encryption and gzip are the real WebCrypto and
// CompressionStream. Also checks that every storage key the extension uses is either synced or local.
//
// Usage: node tools/test-sync.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "..", "extension");
const src = f => fs.readFileSync(path.join(ext, f), "utf8");
const clone = v => (v === undefined ? undefined : structuredClone(v));
const tick = () => new Promise(r => setTimeout(r, 5));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, what) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what}: ${x.slice(0, 300)} != ${y.slice(0, 300)}`);
}

/* The server, with sync-server/server.py's rules. */
function makeServer() {
  return { ops: [], seq: 0, snap: null,
    push(device, batches) {
      for (const b of batches) if (!this.ops.some(o => o.batch === b.id)) this.ops.push({ seq: ++this.seq, batch: b.id, device, blob: b.blob });
      return { ok: true, pushed: batches.length, queued: 0, seq: this.seq };
    },
    pull(since, limit) {
      const floor = this.snap?.upto || 0;
      if (since < floor) return { ok: false, behind: true, floor };
      const rows = this.ops.filter(o => o.seq > since).slice(0, limit + 1);
      return { ok: true, ops: rows.slice(0, limit), more: rows.length > limit, last: this.seq };
    },
    put(device, upto, blob) {
      if (upto > this.seq || upto < (this.snap?.upto || 0)) return { ok: false, error: "bad upto" };
      this.snap = { upto, device, blob, at: new Date().toISOString() };
      this.ops = this.ops.filter(o => o.seq > upto);
      return { ok: true, upto };
    },
  };
}

const KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64");

/* One Mac: its storage, its helper, and the extension's sync code. */
async function makeMac(device, server, { seed = false, storage = {} } = {}) {
  const data = clone(storage);
  const listeners = [];
  const fire = changes => { if (Object.keys(changes).length) setTimeout(() => listeners.forEach(l => l(clone(changes), "local")), 0); };
  const local = {
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        if (JSON.stringify(data[k]) !== JSON.stringify(v)) changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      fire(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) if (k in data) { changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
      fire(changes);
    },
  };
  const helper = async (op, f = {}) => {
    switch (op) {
      case "sync-config": return { ok: true, enabled: true, device, url: "mem:", key: KEY, seed };
      case "sync-push": return server.push(device, f.batches);
      case "sync-pull": return server.pull(f.since, f.limit);
      case "sync-snapshot-get": return server.snap ? { ok: true, ...server.snap } : { ok: true, none: true };
      case "sync-snapshot-put": return server.put(device, f.upto, f.blob);
      case "sync-status": return { ok: true, device, queued: 0 };
    }
    throw new Error(`unknown op ${op}`);
  };
  function serial() { let tail = Promise.resolve(); return fn => { const run = tail.then(fn); tail = run.catch(() => {}); return run; }; }
  const ctx = {
    browser: { storage: { local, onChanged: { addListener: l => listeners.push(l) } }, runtime: { onStartup: { addListener() {} } } },
    crypto: webcrypto, CompressionStream, DecompressionStream, Response, Blob, TextEncoder, TextDecoder, URL, btoa, atob, console,
    setTimeout: () => 0, clearTimeout: () => {}, structuredClone,
    serial, bridge: { state: "on", port: {}, folder: null }, bridgeConnect() {}, hostCall: helper,
    backupNow: async () => ({ ok: true }), applyFilterRules: async () => {},
  };
  ctx.filterQueue = serial(); ctx.tagQueue = serial(); ctx.metaQueue = serial();
  vm.createContext(ctx);
  vm.runInContext(src("links.js"), ctx, { filename: "links.js" });
  vm.runInContext(src("sync.js"), ctx, { filename: "sync.js" });
  const run = code => vm.runInContext(code, ctx);
  const mac = {
    data, ctx, run, local,
    async settle() { for (let i = 0; i < 6; i++) { await tick(); await run("syncQueue(() => 0)"); } },
    async sync() { await mac.settle(); const r = await run("syncNow()"); await mac.settle(); return r; },
    async edit(fn) { await fn(data, local); await mac.settle(); },
    synced() {
      const out = {};
      for (const k of Object.keys(ctx.SYNC_SPEC_KEYS ?? run("Object.keys(SYNC_SPEC)"))) if (k in data) out[k] = normal(k, data[k], run);
      return out;
    },
  };
  return mac;
}
// A key's records sorted, so two Macs holding the same records in another order compare equal.
function normal(k, value, run) {
  const recs = run(`[...syncRecords(${JSON.stringify(k)}, ${JSON.stringify(value)}).entries()]`);
  return recs.map(([r, v]) => [r, JSON.stringify(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const seedData = () => ({
  captures: [
    { kind: "tweet", url: "https://x.com/a/status/1", text: "one" },
    { kind: "page", url: "https://example.org/two", text: "two" },
  ],
  items: [{ url: "https://example.org/item", added_at: "2026-11-01T00:00:00Z" }],
  linkTags: { "x.com/a/status/1": ["ai"] },
  agentTags: { "example.org/two": { at: "2026-11-01", by: "haiku", tags: ["dev"] } },
  stashMeta: { stashes: { S1: { created_at: "2026-09-28" } }, tabs: { T1: { container: "firefox-container-7" } } },
  tagDefs: { seeded: true, list: [{ name: "ai", hue: null }] },
  favicons: { "example.org": { icon: "data:", src: "x", at: "now" } },
  storageId: "seed-profile",
});

await check("every storage key the extension uses is synced or kept local", async () => {
  const mac = await makeMac("probe", makeServer());
  const known = new Set([...mac.run("Object.keys(SYNC_SPEC)"), ...mac.run("[...SYNC_LOCAL]")]);
  const prefixes = mac.run("SYNC_LOCAL_PREFIX");
  const used = new Set();
  for (const f of fs.readdirSync(ext).filter(f => f.endsWith(".js"))) {
    const text = src(f);
    for (const m of text.matchAll(/\bread\("([A-Za-z_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/storage\.local\.(?:get|set|remove)\(\s*\{?\s*\[?\s*"([A-Za-z_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/storage\.local\.set\(\{\s*([A-Za-z_]+)\s*[,}:]/g)) used.add(m[1]);
    for (const m of text.matchAll(/const [A-Z_]*KEY\s*=\s*"([A-Za-z_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/[A-Z_]+_KEY\s*=\s*"([A-Za-z_]+)",\s*[A-Z_]+_KEY\s*=\s*"([A-Za-z_]+)"/g)) { used.add(m[1]); used.add(m[2]); }
  }
  const unknown = [...used].filter(k => !known.has(k) && !prefixes.some(p => k.startsWith(p)));
  if (unknown.length) throw new Error(`classify these in extension/sync.js (SYNC_SPEC or SYNC_LOCAL): ${unknown.join(", ")}`);
});

await check("records: a diff applied to the old value gives the new one, for every kind", async () => {
  const mac = await makeMac("probe", makeServer());
  const cases = {
    captures: [[{ url: "https://a.org/1", t: 1 }, { url: "https://a.org/2", t: 2 }], [{ url: "https://a.org/2", t: 3 }, { url: "https://a.org/3", t: 1 }]],
    linkTags: [{ a: ["x", "y"], b: ["z"] }, { a: ["y", "w"], c: ["z"] }],
    agentTags: [{ a: { tags: ["x"] } }, { a: { tags: ["y"] }, b: { tags: [] } }],
    stashMeta: [{ stashes: { s: { n: 1 } }, tabs: { t: { c: 1 } } }, { stashes: {}, tabs: { t: { c: 2 }, u: { c: 3 } } }],
    tagDefs: [{ list: [1] }, { list: [1, 2] }],
  };
  for (const [k, [a, b]] of Object.entries(cases)) {
    const got = mac.run(`syncPut(${JSON.stringify(k)}, ${JSON.stringify(a)}, syncDiff(${JSON.stringify(k)}, ${JSON.stringify(a)}, ${JSON.stringify(b)}))`);
    eq(normal(k, got, mac.run), normal(k, b, mac.run), k);
  }
  eq(mac.run(`syncPut("tagDefs", {list: [1]}, syncDiff("tagDefs", {list: [1]}, undefined))`), undefined, "a removed value");
});

await check("clocks order by time, then counter, then device", async () => {
  const mac = await makeMac("m", makeServer());
  const t = mac.run(`(() => { const a = hlcNext({ms: 0, c: 0}, "m", 1000); const b = hlcNext(a.clock, "m", 1000); const c = hlcNext(b.clock, "m", 999);
    return [a.t < b.t, b.t < c.t, hlcString(5, 0, "a") < hlcString(5, 0, "b"), hlcString(5, 9, "z") < hlcString(6, 0, "a")]; })()`);
  eq(t, [true, true, true, true], "order");
});

const server = makeServer();
const A = await makeMac("mac-a", server, { seed: true, storage: seedData() });
const B = await makeMac("mac-b", server, { storage: { captures: [{ url: "https://stale.org/x", text: "stale" }], storageId: "other" } });

await check("a Mac that is not the seed waits while the server is empty", async () => {
  const r = await B.sync();
  if (!r.ok || !r.waiting) throw new Error(JSON.stringify(r));
  eq(server.snap, null, "no snapshot written");
});

await check("the seed writes the first snapshot; the other Mac takes it whole", async () => {
  const a = await A.sync();
  if (!a.ok || !server.snap) throw new Error(JSON.stringify(a));
  const b = await B.sync();
  if (!b.ok) throw new Error(JSON.stringify(b));
  eq(B.synced(), A.synced(), "synced keys");
  eq(B.data.storageId, "other", "local keys stay");
  eq("favicons" in B.data, false, "a cache is not carried");
  eq(B.data.syncPending, [], "taking the snapshot records nothing to send");
});

await check("edits on both Macs reach the other", async () => {
  await A.edit(async (d, s) => s.set({ linkTags: { ...d.linkTags, "example.org/two": ["dev"] } }));
  await B.edit(async (d, s) => s.set({ captures: [...d.captures, { url: "https://example.org/three", text: "three" }] }));
  await A.sync(); await B.sync(); await A.sync();
  eq(A.synced(), B.synced(), "converged");
  if (!A.data.captures.some(c => c.url === "https://example.org/three")) throw new Error("A lacks B's capture");
  eq(B.data.linkTags["example.org/two"], ["dev"], "B has A's tag");
});

await check("applying another Mac's changes sends nothing back", async () => {
  eq(A.data.syncPending, [], "A's queue");
  eq(B.data.syncPending, [], "B's queue");
});

await check("the same record changed on both: the later change wins on both", async () => {
  await A.edit(async (d, s) => s.set({ captures: d.captures.map(c => (c.url.endsWith("/two") ? { ...c, note: "from a" } : c)) }));
  await new Promise(r => setTimeout(r, 3));
  await B.edit(async (d, s) => s.set({ captures: d.captures.map(c => (c.url.endsWith("/two") ? { ...c, note: "from b" } : c)) }));
  await A.sync(); await B.sync(); await A.sync();
  eq(A.data.captures.find(c => c.url.endsWith("/two")).note, "from b", "A");
  eq(B.data.captures.find(c => c.url.endsWith("/two")).note, "from b", "B");
});

await check("tags added to one link on both Macs are both kept", async () => {
  await A.edit(async (d, s) => s.set({ linkTags: { ...d.linkTags, "x.com/a/status/1": [...d.linkTags["x.com/a/status/1"], "p"] } }));
  await B.edit(async (d, s) => s.set({ linkTags: { ...d.linkTags, "x.com/a/status/1": [...d.linkTags["x.com/a/status/1"], "q"] } }));
  await A.sync(); await B.sync(); await A.sync();
  eq([...A.data.linkTags["x.com/a/status/1"]].sort(), ["ai", "p", "q"], "A");
  eq([...B.data.linkTags["x.com/a/status/1"]].sort(), ["ai", "p", "q"], "B");
});

await check("a deletion travels, and a later edit of the same record brings it back", async () => {
  await A.edit(async (d, s) => s.set({ items: [] }));
  await A.sync(); await B.sync();
  eq(B.data.items, [], "B lost the item");
  await B.edit(async (d, s) => s.set({ items: [{ url: "https://example.org/item", added_at: "2026-11-02T00:00:00Z" }] }));
  await B.sync(); await A.sync();
  eq(A.data.items.length, 1, "A has it again");
});

await check("a page write that lands over a just-applied change does not delete it", async () => {
  const stale = clone(B.data.captures);
  await B.run(`syncApply([{ k: "captures", r: "example.org/race", v: { url: "https://example.org/race", text: "remote" }, t: hlcString(Date.now() + 5000, 0, "mac-a") }])`);
  await B.edit(async (d, s) => s.set({ captures: [...stale, { url: "https://example.org/page", text: "page" }] }));
  const urls = B.data.captures.map(c => c.url);
  if (!urls.includes("https://example.org/race")) throw new Error("the remote capture was lost");
  if (!urls.includes("https://example.org/page")) throw new Error("the page's capture was lost");
  if ((B.data.syncPending || []).some(op => op.r === "example.org/race" && op.d)) throw new Error("a deletion of the remote capture was queued");
});

await check("a Mac behind a newer snapshot merges it", async () => {
  await B.sync(); await A.sync();
  for (let i = 0; i < 3; i++) {
    await A.edit(async (d, s) => s.set({ agentTags: { ...d.agentTags, [`example.org/n${i}`]: { tags: [`t${i}`] } } }));
    await A.sync();
  }
  // A folds everything it has applied into a new snapshot; the batches before it are dropped.
  const cursor = A.data.syncState.cursor;
  const put = await A.run(`(async () => hostCall("sync-snapshot-put", { upto: ${cursor}, blob: await syncSeal(await syncSnapshotBody()) }))()`);
  if (!put.ok) throw new Error(JSON.stringify(put));
  const r = await B.sync();
  if (!r.ok) throw new Error(JSON.stringify(r));
  eq(B.synced(), A.synced(), "converged through the snapshot");
});

await check("the server holds only ciphertext", async () => {
  const all = JSON.stringify([server.ops, server.snap]);
  for (const word of ["example.org", "status", "haiku", "from b"]) if (all.includes(word)) throw new Error(`"${word}" is readable on the server`);
});

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
