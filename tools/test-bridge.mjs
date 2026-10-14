#!/usr/bin/env node
// DESC: Check the native bridge and the link-keeper CLI against a stand-in extension, no Firefox needed.
/* Starts native/link-keeper-bridge.py as Firefox would, speaking native messaging on its stdin and
 * stdout, with its backup folder and socket in a temporary directory. This script plays the
 * extension: it answers the requests the bridge forwards, so tools/link-keeper.mjs is exercised
 * end to end, live and then — once the bridge has gone — from the backup.
 *
 * Usage: node tools/test-bridge.mjs */

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lk-bridge-"));
const env = { ...process.env, LINK_KEEPER_BACKUP_DIR: path.join(work, "backups"), LINK_KEEPER_STATE_DIR: path.join(work, "state") };

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", `${name}: ${e.message}`); }
}
function assert(cond, why) { if (!cond) throw new Error(why); }

/* --- the stand-in extension ---------------------------------------------------------- */

const LINKS = vm.createContext({ URL, console });
vm.runInContext(fs.readFileSync(path.join(REPO, "extension/links.js"), "utf8"), LINKS);
const storage = {
  items: [{ url: "https://example.org/a", status: "pending", added_at: "2026-10-01T10:00:00Z" }],
  captures: [{ url: "https://example.org/b", title: "Bee", text: "the text of b", captured_at: "2026-10-02T10:00:00Z",
    replies: [{ handle: "@author", name: "A", text: "repo is github.com/a/b", posted: "2026-10-02T09:00:00.000Z", url: "https://x.com/author/status/2",
      replies: 0, reposts: 1, likes: 12, views: 340, self: true, images: [], video: false, video_posters: [],
      links: [{ href: "https://t.co/x", display: "github.com/a/b", resolved: "https://github.com/a/b" }] }] }],
  linkTags: { [LINKS.keyOf("https://example.org/b")]: ["ai"] },
  tagDefs: { seeded: true, list: [{ name: "ai", hue: null }, { name: "dev", hue: null }] },
  tagSuggestions: {},
};
const sessions = [{ id: "s1", name: "Oct 6", created_at: "2026-10-06T09:00:00Z", source: "tabs", tabs: [
  { id: "t1", url: "https://example.org/c", title: "Sea" }, { id: "t2", url: "https://example.org/b", title: "Bee" }] }];
const joined = () => JSON.parse(JSON.stringify(LINKS.joinLinks({ items: storage.items, captures: storage.captures, sessions, tags: storage.linkTags, suggestions: storage.tagSuggestions })));
const sent = [];   // the pages' messages agents sent through "call"

const bridge = spawn("/usr/bin/python3", [path.join(REPO, "native/link-keeper-bridge.py")], { env, stdio: ["pipe", "pipe", "inherit"] });
const post = obj => {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  bridge.stdin.write(Buffer.concat([head, body]));
};
const waiters = [];
const chunks = new Map();
let pending = Buffer.alloc(0);
const frames = [];
bridge.stdout.on("data", d => {
  pending = Buffer.concat([pending, d]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
    const n = pending.readUInt32LE(0);
    assert(n <= 1024 * 1024, `a frame of ${n} bytes; Firefox drops anything over 1 MB`);
    let m = JSON.parse(pending.subarray(4, 4 + n).toString());
    frames.push(n);
    pending = pending.subarray(4 + n);
    if (m.type === "chunk") {
      const parts = chunks.get(m.id) || [];
      parts[m.part] = m.data;
      chunks.set(m.id, parts);
      if (parts.filter(p => p != null).length < m.of) continue;
      m = JSON.parse(parts.join(""));
      m.__chunked = true;
    }
    if (m.type === "request") answer(m);
    else for (const w of waiters.splice(0)) w(m);
  }
});
const next = () => new Promise(r => waiters.push(r));
let hid = 0;
async function host(op, fields = {}) {
  const id = `h${++hid}`;
  post({ type: "host", id, op, ...fields });
  for (;;) { const m = await next(); if (m.type === "host-reply" && m.id === id) return m; }
}

function answer(m) {
  let result;
  if (m.cmd === "links") result = { ok: true, live: true, ...joined() };
  else if (m.cmd === "storage") result = { ok: true, storage: { tagDefs: storage.tagDefs } };
  else if (m.cmd === "call") {
    const msg = m.args.message;
    sent.push(msg);
    if (msg.type === "set-tags") { storage.linkTags[LINKS.keyOf(msg.url)] = msg.tags; result = { ok: true, tags: msg.tags }; }
    else if (msg.type === "set-tag-suggestions") {
      if (msg.replace) storage.tagSuggestions = {};
      for (const [url, list] of Object.entries(msg.suggestions)) {
        if (list.length) storage.tagSuggestions[LINKS.keyOf(url)] = { at: "2026-10-14T00:00:00Z", tags: list };
        else delete storage.tagSuggestions[LINKS.keyOf(url)];
      }
      result = { ok: true, count: Object.keys(storage.tagSuggestions).length };
    }
    else if (msg.type === "delete-stash") result = { ok: true, removed: msg.ids.length };
    else if (msg.type === "filter-rules") result = { rules: ["reddit.com"] };
    else result = { ok: true };
  } else result = { ok: false, error: `stand-in does not know ${m.cmd}` };
  post({ type: "reply", id: m.id, result });
}

// Async, so this process stays free to answer the requests the CLI sends through the bridge.
const cli = (...args) => new Promise(resolve => {
  execFile("node", [path.join(REPO, "tools/link-keeper.mjs"), ...args], { env, encoding: "utf8" },
    (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: String(stdout) + String(stderr) }));
});
const backupData = () => ({ format: "link-keeper-backup", format_version: 1, extension_version: "test", at: new Date().toISOString(), storage, sessions });
const sock = path.join(env.LINK_KEEPER_STATE_DIR, "bridge.sock");

/* --- checks ------------------------------------------------------------------------------ */

await check("hello names the backup folder", async () => {
  post({ type: "hello", version: "test" });
  const m = await next();
  assert(m.type === "hello" && m.backup_folder === env.LINK_KEEPER_BACKUP_DIR && !m.error, JSON.stringify(m));
});

await check("the socket is this user's alone", async () => {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 100));
  assert((fs.statSync(sock).mode & 0o777) === 0o600, `socket mode ${(fs.statSync(sock).mode & 0o777).toString(8)}`);
  assert((fs.statSync(path.dirname(sock)).mode & 0o777) === 0o700, "state folder is not 700");
});

const today = new Date();
const stamp = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
await check("a backup writes latest.json and the day's file, and drops files over 30 days old", async () => {
  fs.mkdirSync(env.LINK_KEEPER_BACKUP_DIR, { recursive: true });
  const old = path.join(env.LINK_KEEPER_BACKUP_DIR, `backup-${stamp(new Date(Date.now() - 31 * 864e5))}.json`);
  const kept = path.join(env.LINK_KEEPER_BACKUP_DIR, `backup-${stamp(new Date(Date.now() - 29 * 864e5))}.json`);
  fs.writeFileSync(old, "{}"); fs.writeFileSync(kept, "{}");
  const r = (await host("backup", { reason: "change", data: backupData() })).result;
  assert(r.ok, JSON.stringify(r));
  const latest = JSON.parse(fs.readFileSync(path.join(env.LINK_KEEPER_BACKUP_DIR, "latest.json"), "utf8"));
  assert(latest.storage.captures[0].text === "the text of b", "latest.json does not hold the data");
  assert(fs.existsSync(path.join(env.LINK_KEEPER_BACKUP_DIR, `backup-${stamp(today)}.json`)), "no file for today");
  assert(!fs.existsSync(old), "a 31-day-old backup survived");
  assert(fs.existsSync(kept), "a 29-day-old backup was dropped");
});

await check("the day's file keeps the day's first backup; latest.json moves on", async () => {
  const day = path.join(env.LINK_KEEPER_BACKUP_DIR, `backup-${stamp(today)}.json`);
  const first = fs.readFileSync(day, "utf8");
  await host("backup", { reason: "change", data: { ...backupData(), at: "later" } });
  assert(fs.readFileSync(day, "utf8") === first, "the day's file was rewritten");
  assert(JSON.parse(fs.readFileSync(path.join(env.LINK_KEEPER_BACKUP_DIR, "latest.json"), "utf8")).at === "later", "latest.json did not move on");
});

await check("pre-restore saves are their own files, five kept", async () => {
  for (let i = 0; i < 7; i++) { await host("backup", { reason: "pre-restore", data: backupData() }); await new Promise(r => setTimeout(r, 1100)); }
  const pre = fs.readdirSync(env.LINK_KEEPER_BACKUP_DIR).filter(n => n.startsWith("pre-restore-"));
  assert(pre.length === 5, `${pre.length} pre-restore files`);
});

await check("a backup over 1 MB comes back in chunks Firefox accepts, whole", async () => {
  const big = backupData();
  big.storage = { ...storage, captures: [...storage.captures, { url: "https://example.org/big", text: "é".repeat(1_500_000) }] };
  await host("backup", { reason: "change", data: big });
  const m = await host("read-backup", { name: "latest.json" });
  assert(m.__chunked, "it came as one frame");
  assert(m.result.data.storage.captures[1].text.length === 1_500_000, "the text did not survive");
  await host("backup", { reason: "change", data: backupData() });
});

await check("read-backup reads only a file in the backup folder", async () => {
  for (const name of ["../state/x.json", "/etc/passwd", ".hidden.json", "latest"]) {
    const r = (await host("read-backup", { name })).result;
    assert(!r.ok, `${name} was read`);
  }
});

await check("the undo journal keeps entries newest last and drops them", async () => {
  await host("journal-push", { entry: { at: "1", cmd: "set-tags", summary: "linkTags" } });
  await host("journal-push", { entry: { at: "2", cmd: "add", summary: "items" } });
  const last = (await host("journal-last")).result;
  assert(last.entry.cmd === "add", JSON.stringify(last));
  assert((await host("journal-list")).result.entries.length === 2, "two entries listed");
  await host("journal-drop", { entry_id: last.id });
  assert((await host("journal-last")).result.entry.cmd === "set-tags", "drop did not drop the newest");
});

await check("CLI status and links read live through the socket", async () => {
  const s = await cli("links", "--json");
  assert(s.code === 0, s.out);
  const got = JSON.parse(s.out);
  assert(got.total === 3, `${got.total} links`);
  assert(got.links.every(l => !l.cap?.text), "capture text came along without --text");
  assert(got.links.every(l => !l.cap?.replies), "replies came along without --text");
  assert(got.links.find(l => l.url.endsWith("/b")).cap.reply_count === 1, "the reply count is missing");
  const t = await cli("links", "--tag", "ai");
  assert(t.code === 0 && t.out.includes("https://example.org/b") && !t.out.includes("/c"), t.out);
});

await check("CLI tag --add keeps the link's tags and adds", async () => {
  const r = await cli("tag", "https://example.org/b", "--add", "dev");
  assert(r.code === 0, r.out);
  const msg = sent.at(-1);
  assert(msg.type === "set-tags" && JSON.stringify(msg.tags) === '["ai","dev"]', JSON.stringify(msg));
});

const suggestFile = name => {
  const file = path.join(work, name);
  return { file, write: obj => { fs.writeFileSync(file, JSON.stringify(obj)); return file; } };
};
await check("CLI suggest-set sends the file as set-tag-suggestions, merging unless --replace", async () => {
  const f = suggestFile("suggest.json");
  const a = [{ tag: "dev", p: 0.82, by: "model" }, { tag: "ai", p: 0.4, by: "system-one" }];
  f.write({ "https://example.org/a": a, "https://example.org/c": [{ tag: "video", p: 0.9, by: "system-one" }] });
  const r = await cli("suggest-set", f.file);
  assert(r.code === 0 && /2 links hold suggestions/.test(r.out), r.out);
  let msg = sent.at(-1);
  assert(msg.type === "set-tag-suggestions" && msg.replace === false && JSON.stringify(msg.suggestions["https://example.org/a"]) === JSON.stringify(a), JSON.stringify(msg));
  f.write({ "https://example.org/c": [] });
  const m = await cli("suggest-set", f.file);
  assert(m.code === 0 && /1 links hold suggestions/.test(m.out), m.out);
  f.write({ "https://example.org/a": a });
  const rep = await cli("suggest-set", f.file, "--replace");
  msg = sent.at(-1);
  assert(rep.code === 0 && msg.replace === true, JSON.stringify(msg));
  f.write([1]);
  const bad = await cli("suggest-set", f.file);
  assert(bad.code === 1 && /JSON object/.test(bad.out), bad.out);
  const none = await cli("suggest-set", path.join(work, "no-such.json"));
  assert(none.code === 1, none.out);
});

await check("links carry suggested; a link with tags of its own has none; suggestions counts them", async () => {
  storage.tagSuggestions[LINKS.keyOf("https://example.org/b")] = { at: "x", tags: [{ tag: "ai", p: 0.7, by: "model" }] };
  const got = JSON.parse((await cli("links", "--json", "--all")).out);
  const by = u => got.links.find(l => l.url.endsWith(u));
  assert(by("/a").suggested.map(s => s.tag).join() === "dev,ai" && by("/a").suggested[0].p === 0.82, JSON.stringify(by("/a").suggested));
  assert(by("/b").suggested.length === 0, "a tagged link carries suggestions");
  assert(by("/c").suggested.length === 0, "a link with none carries some");
  const s = await cli("suggestions");
  assert(s.code === 0 && s.out.startsWith("1 links with suggestions") && /1  dev/.test(s.out) && /1  ai/.test(s.out), s.out);
  const sj = JSON.parse((await cli("suggestions", "--json")).out);
  assert(sj.links === 1 && sj.tags.dev === 1 && sj.tags.ai === 1, JSON.stringify(sj));
  const one = await cli("link", "https://example.org/a");
  assert(/suggested: dev 82%, ai 40%/.test(one.out), one.out);
});

await check("agents may send set-tag-suggestions, and the journal covers the key it writes", async () => {
  const bridgeJs = fs.readFileSync(path.join(REPO, "extension/bridge.js"), "utf8");
  const writes = bridgeJs.match(/AGENT_WRITES = new Set\(\[([^\]]*)\]/s)?.[1] || "";
  const keys = bridgeJs.match(/JOURNAL_KEYS = \[([^\]]*)\]/s)?.[1] || "";
  assert(writes.includes('"set-tag-suggestions"'), "set-tag-suggestions is not an agent write");
  assert(keys.includes('"tagSuggestions"'), "tagSuggestions is not a journaled key");
});

await check("CLI remove refuses a link held in two places unless told which", async () => {
  const r = await cli("remove", "https://example.org/b");
  assert(r.code === 1 && /2 places/.test(r.out) && /--stash s1/.test(r.out) && /--capture/.test(r.out), r.out);
  const ok = await cli("remove", "https://example.org/b", "--stash", "s1");
  assert(ok.code === 0, ok.out);
  const msg = sent.at(-1);
  assert(msg.type === "delete-stash" && msg.id === "s1" && JSON.stringify(msg.ids) === '["t2"]', JSON.stringify(msg));
});

await check("CLI remove takes a link held in one place without a flag", async () => {
  const r = await cli("remove", "https://example.org/c");
  assert(r.code === 0, r.out);
  assert(sent.at(-1).type === "delete-stash" && sent.at(-1).ids[0] === "t1", JSON.stringify(sent.at(-1)));
});

await check("with the bridge gone, the CLI reads the latest backup and refuses changes", async () => {
  await host("backup", { reason: "change", data: backupData() });
  bridge.stdin.end();
  await new Promise(r => bridge.on("exit", r));
  assert(!fs.existsSync(sock), "the socket outlived the bridge");
  const r = await cli("links");
  assert(r.code === 0 && r.out.includes("https://example.org/b") && /from the backup of/.test(r.out), r.out);
  const c = await cli("capture", "https://example.org/b");
  assert(c.code === 0 && c.out.includes("the text of b"), c.out);
  assert(/replies \(1\):\n  @author  \[author\]  2026-10-02  12 likes, 1 reposts, 340 views  "repo is github.com\/a\/b"  1 links  https:\/\/x.com\/author\/status\/2/.test(c.out), c.out);
  const cj = JSON.parse((await cli("capture", "https://example.org/b", "--json")).out.replace(/\(from the[^\n]*\n/, ""));
  assert(cj.replies.length === 1 && cj.replies[0].likes === 12 && cj.replies[0].self === true, JSON.stringify(cj.replies));
  const sg = await cli("suggestions");
  assert(sg.code === 0 && sg.out.includes("1 links with suggestions") && /from the backup of/.test(sg.out), sg.out);
  const w = await cli("tag", "https://example.org/b", "--add", "x");
  assert(w.code === 1 && /not running/.test(w.out), w.out);
});

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall bridge checks passed");
process.exit(failed ? 1 : 0);
