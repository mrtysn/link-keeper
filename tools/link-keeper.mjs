#!/usr/bin/env node
// DESC: Read and change Link Keeper's links, tags, captures and stashes from the shell, live from Firefox or from the latest backup.
/* Talks to native/link-keeper-bridge.py, which runs while Firefox has Link Keeper open, over its
 * Unix socket. With Firefox closed, reads come from the latest backup instead, joined by the
 * extension's own links.js, so a link looks the same either way; changes need Firefox running.
 *
 * Every change an agent makes is journaled; `link-keeper undo` puts the last one back. Nothing here
 * opens, closes, captures or navigates a tab. */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILTER_TAG = "filtered-out";

const HELP = `link-keeper — Link Keeper's data from the shell (live from Firefox, else the latest backup)

Reading
  status                          live or backup, counts, last backup
  links [filters] [--json]        the links, newest first; filters:
      --filter all|captured|uncaptured|local|filtered   (all = the pile, without filtered-out)
      --tag T (repeatable, any of)  --untagged  --stash ID  --site HOST  --search TEXT
      --limit N (default 50)  --all (no limit)
  link URL [--text] [--json]      one link: tags, every copy and its stash, list entry, capture
  capture URL [--json]            the captured text, links and images of a link
  stashes [--json]                every stash: id, date, name, tab count
  stash ID [--json]               one stash's tabs
  tags [--json]                   the tag library with how many links carry each
  filter-rules                    the filtered-out rules, one per line

Changing (needs Firefox running; each change is journaled)
  tag URL --add a,b | --remove a | --set a,b | --clear
  tag-stash ID a,b                add tags to every tab of a stash
  tag-create NAME [--hue 0-359]   tag-rename OLD NEW   tag-delete NAME   tag-recolor NAME HUE
  add URL... [--note TEXT]        put links on the reading list
  remove URL --stash ID | --list | --capture | --everywhere
                                  one copy unless told otherwise; --capture also takes the list entry;
                                  with no flag, works only when the link is held in one place
  stash-rename ID NAME            stash-flag ID --lock|--unlock|--star|--unstar
  stash-delete ID                 the whole stash (refused while locked)
  filter-rules --add RULE | --remove RULE
  undo [--force]                  put the last agent change back; history lists them
  call TYPE [JSON]                any message the pages send that agents may (see bridge.js)

Backups
  backup                          write latest.json now
  backups                         the backup files
  restore NAME                    replace the data with that file (the current state is saved first)

Output is plain lines; --json prints what the extension returned. Exit 1 on an error.`;

/* --- configuration, as the helper reads it -------------------------------------------- */

function configValue(name) {
  if (process.env[name]) return process.env[name];
  const conf = path.join(REPO, "config.local.sh");
  if (!fs.existsSync(conf)) return null;
  for (const line of fs.readFileSync(conf, "utf8").split("\n")) {
    const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`));
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, os.homedir())
        .replace(/\$\{?HOME\}?/g, os.homedir());
      return v || null;
    }
  }
  return null;
}
const stateDir = () => configValue("LINK_KEEPER_STATE_DIR") || path.join(os.homedir(), ".local/state/link-keeper");
const backupDir = () => configValue("LINK_KEEPER_BACKUP_DIR");

/* --- the live extension, or the backup ------------------------------------------------- */

function request(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(stateDir(), "bridge.sock"));
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ cmd, args }) + "\n"));
    sock.on("data", d => { buf += d; });
    sock.on("end", () => {
      try { resolve(JSON.parse(buf)); } catch { reject(new Error(`the bridge answered something that is not JSON: ${buf.slice(0, 200)}`)); }
    });
    sock.on("error", e => (["ENOENT", "ECONNREFUSED"].includes(e.code) ? resolve(null) : reject(e)));
  });
}

// links.js, as the extension loads it: keyOf, joinLinks and what they use.
const LINKS = vm.createContext({ URL, console });
vm.runInContext(fs.readFileSync(path.join(REPO, "extension/links.js"), "utf8"), LINKS);
const keyOf = url => LINKS.keyOf(url);

function readBackup() {
  const dir = backupDir();
  if (!dir) throw new Error("Firefox is not running Link Keeper, and no backup folder is set (LINK_KEEPER_BACKUP_DIR in config.local.sh)");
  const file = path.join(dir, "latest.json");
  if (!fs.existsSync(file)) throw new Error(`Firefox is not running Link Keeper, and there is no ${file} yet`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

let source = null;   // "live", or "backup of <time>"
async function getData() {
  const live = await request("links");
  if (live) {
    if (live.ok === false) throw new Error(live.error);
    source = "live";
    const lib = await request("storage", { keys: ["tagDefs"] });
    return { ...live, tagDefs: lib?.storage?.tagDefs };
  }
  const b = readBackup();
  source = `backup of ${b.at}`;
  const s = b.storage;
  const joined = LINKS.joinLinks({ items: s.items || [], captures: s.captures || [], sessions: b.sessions || [],
    thumbs: s.thumbs || {}, currentKey: s.current?.key || null, tags: s.linkTags || {} });
  return { ...JSON.parse(JSON.stringify(joined)), tagDefs: s.tagDefs, backup: b };
}

async function live(cmd, args) {
  const res = await request(cmd, args);
  if (!res) throw new Error("Firefox is not running Link Keeper (no bridge socket); changes need the live extension");
  if (res.ok === false) throw new Error(res.error || "the extension refused");
  return res;
}
const call = (type, fields = {}) => live("call", { message: { type, ...fields } });

/* --- arguments ----------------------------------------------------------------------------- */

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const flag = ["json", "text", "all", "untagged", "force", "list", "capture", "everywhere", "clear",
      "lock", "unlock", "star", "unstar", "help"].includes(name);
    const value = flag ? true : argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === "tag") (opt.tag ||= []).push(value);
    else opt[name] = value;
  }
  return { pos, opt };
}
const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
const need = (v, what) => { if (!v) throw new Error(`missing ${what} (see --help)`); return v; };

/* --- output -------------------------------------------------------------------------------- */

const out = s => process.stdout.write(s + "\n");
const json = v => out(JSON.stringify(v, null, 2));
const day = iso => (iso ? String(iso).slice(0, 10) : "          ");
const isWeb = url => /^(https?|ftp):/.test(url);
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const linkLine = l => [day(l.date), l.tags.length ? `[${l.tags.join(",")}]` : "[]", l.cap ? "captured" : "",
  l.copies.length > 1 ? `×${l.copies.length}` : "", l.title || l.cap?.title || "", l.url].filter(Boolean).join("  ");
function note() { if (source && source !== "live") process.stderr.write(`(from the ${source}; Firefox is not running Link Keeper)\n`); }

function findLink(data, url) {
  const link = data.links.find(l => l.key === keyOf(url));
  if (!link) throw new Error(`${url} is not held anywhere`);
  return link;
}

/* --- commands ------------------------------------------------------------------------------ */

const commands = {
  async status({ opt }) {
    const res = await request("status");
    if (res) return opt.json ? json(res) : out([
      `live: Link Keeper ${res.version} in Firefox`,
      `${res.counts.links} links (${res.counts.filtered} filtered out, ${res.counts.untagged} untagged), ${res.counts.stashes} stashes, ${res.counts.captures} captures, ${res.counts.list} on the reading list`,
      res.backup.error ? `backup: ${res.backup.error}` : `backup: ${res.backup.folder}${res.backup.last?.at ? `, last ${res.backup.last.at}` : ""}`,
    ].join("\n"));
    const d = await getData();
    const s = d.backup.storage;
    const counts = { links: d.links.length, stashes: d.stashes.length, captures: (s.captures || []).length, list: (s.items || []).length };
    if (opt.json) return json({ ok: true, live: false, backup_at: d.backup.at, version: d.backup.extension_version, counts });
    out(`not live: Firefox is not running Link Keeper\nlatest backup: ${d.backup.at} (Link Keeper ${d.backup.extension_version})\n${counts.links} links, ${counts.stashes} stashes, ${counts.captures} captures, ${counts.list} on the reading list`);
  },

  async links({ opt }) {
    const d = await getData();
    const f = opt.filter || "all";
    if (!["all", "captured", "uncaptured", "local", "filtered"].includes(f)) throw new Error(`no filter ${f}`);
    const term = String(opt.search || "").toLowerCase();
    const hits = d.links.filter(l => {
      const out = l.tags.includes(FILTER_TAG);
      if (f === "filtered" ? !out : out) return false;
      if (f === "captured" && !(isWeb(l.url) && l.cap)) return false;
      if (f === "uncaptured" && !(isWeb(l.url) && !l.cap)) return false;
      if (f === "local" && isWeb(l.url)) return false;
      if (opt.untagged && l.tags.length) return false;
      if (opt.tag && !opt.tag.some(t => l.tags.includes(t))) return false;
      if (opt.stash && !l.copies.some(c => c.stash === opt.stash)) return false;
      if (opt.site && hostOf(l.url) !== opt.site.replace(/^www\./, "")) return false;
      if (term) {
        const hay = [l.url, l.title, l.cap?.title, l.cap?.text, l.list?.note, ...l.tags, ...(l.cap?.links || [])].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    }).sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const shown = opt.all ? hits : hits.slice(0, +(opt.limit || 50));
    note();
    if (opt.json) return json({ total: hits.length, links: shown.map(l => (opt.text ? l : { ...l, cap: l.cap && { ...l.cap, text: undefined } })) });
    for (const l of shown) out(linkLine(l));
    if (shown.length < hits.length) out(`… ${hits.length - shown.length} more (--limit N or --all)`);
  },

  async link({ pos, opt }) {
    const d = await getData();
    const l = findLink(d, need(pos[0], "URL"));
    const names = new Map(d.stashes.map(s => [s.id, s]));
    const view = { ...l, copies: l.copies.map(c => ({ ...c, stash_name: names.get(c.stash)?.name, stash_date: names.get(c.stash)?.created_at })) };
    if (view.cap && !opt.text) view.cap = { ...view.cap, text: view.cap.text ? `${view.cap.text.length} characters (--text to show)` : null };
    note();
    if (opt.json) return json(view);
    out([`${l.title || l.cap?.title || "(no title)"}`, l.url, `tags: ${l.tags.join(", ") || "none"}`,
      `list: ${l.list ? `${l.list.status}${l.list.loose ? " (captured, never queued)" : ""}` : "not on it"}`,
      `capture: ${l.cap ? `${l.cap.captured_at || "yes"}` : "none"}`,
      ...view.copies.map(c => `in stash ${c.stash}  ${day(c.stash_date)}  ${c.stash_name || ""}  (bookmark ${c.tab})`)].join("\n"));
    if (opt.text && l.cap?.text) out(`\n${l.cap.text}`);
  },

  async capture({ pos, opt }) {
    const d = await getData();
    const l = findLink(d, need(pos[0], "URL"));
    if (!l.cap) throw new Error(`${l.url} has no capture`);
    note();
    if (opt.json) return json({ url: l.url, ...l.cap });
    out([l.cap.title || l.title || l.url, l.url, l.cap.captured_at ? `captured ${l.cap.captured_at}` : "", "", l.cap.text || "(no text)",
      ...(l.cap.links?.length ? ["", "links:", ...l.cap.links] : [])].join("\n"));
  },

  async stashes({ opt }) {
    const d = await getData();
    note();
    if (opt.json) return json(d.stashes.map(({ tabs, ...s }) => ({ ...s, tabs: tabs.length })));
    for (const s of d.stashes) out([s.id, day(s.created_at), `${s.tabs.length} tabs`, s.locked ? "locked" : "", s.starred ? "starred" : "", s.source === "import" ? `imported${s.format ? ` (${s.format})` : ""}` : "", s.name].filter(Boolean).join("  "));
  },

  async stash({ pos, opt }) {
    const d = await getData();
    const s = d.stashes.find(x => x.id === need(pos[0], "stash ID"));
    if (!s) throw new Error(`no stash ${pos[0]}`);
    note();
    if (opt.json) return json(s);
    out(`${s.name}  (${day(s.created_at)}, ${s.tabs.length} tabs${s.locked ? ", locked" : ""})`);
    const byKey = new Map(d.links.map(l => [l.key, l]));
    for (const t of s.tabs) out(`${t.id}  [${(byKey.get(t.key)?.tags || []).join(",")}]  ${t.title || ""}  ${t.url}`);
  },

  async tags({ opt }) {
    const d = await getData();
    const use = {};
    for (const l of d.links) for (const t of l.tags) use[t] = (use[t] || 0) + 1;
    const lib = (d.tagDefs?.list || []).map(t => ({ ...t, links: use[t.name] || 0 }));
    note();
    if (opt.json) return json(lib);
    for (const t of lib) out(`${String(t.links).padStart(5)}  ${t.name}`);
  },

  async "filter-rules"({ opt }) {
    const { rules } = await call("filter-rules").catch(async e => {
      if (!/not running/.test(e.message)) throw e;
      const b = readBackup(); source = `backup of ${b.at}`;
      return { rules: b.storage.filterRules || [] };
    });
    if (opt.add || opt.remove) {
      const next = opt.add ? [...rules, opt.add] : rules.filter(r => r !== opt.remove);
      if (opt.remove && next.length === rules.length) throw new Error(`no rule ${opt.remove}`);
      const res = await call("set-filter-rules", { rules: next });
      return opt.json ? json(res) : out(`${res.matched} links filtered out (${res.added} new, ${res.removed} back in the pile)`);
    }
    note();
    opt.json ? json(rules) : rules.forEach(r => out(r));
  },

  async tag({ pos, opt }) {
    const url = need(pos[0], "URL");
    const d = await getData();
    if (source !== "live") throw new Error("Firefox is not running Link Keeper; changes need the live extension");
    const have = d.links.find(l => l.key === keyOf(url))?.tags || [];
    let tags;
    if (opt.clear) tags = [];
    else if (opt.set) tags = list(opt.set);
    else if (opt.add || opt.remove) tags = [...have, ...list(opt.add)].filter(t => !list(opt.remove).includes(t));
    else throw new Error("say --add, --remove, --set or --clear");
    const res = await call("set-tags", { url, tags });
    opt.json ? json(res) : out(`tags: ${res.tags.join(", ") || "none"}`);
  },

  async "tag-stash"({ pos, opt }) { done(opt, await call("tag-stash", { id: need(pos[0], "stash ID"), tags: list(need(pos[1], "tags")) }), r => `tagged ${r.tagged} tabs`); },
  async "tag-create"({ pos, opt }) { done(opt, await call("create-tag", { name: need(pos[0], "tag name"), hue: opt.hue ?? null }), r => `created ${r.tag}`); },
  async "tag-rename"({ pos, opt }) { done(opt, await call("rename-tag", { from: need(pos[0], "old name"), to: need(pos[1], "new name") }), r => `renamed on ${r.links} links`); },
  async "tag-delete"({ pos, opt }) { done(opt, await call("delete-tag", { tag: need(pos[0], "tag name") }), r => `deleted from ${r.links} links`); },
  async "tag-recolor"({ pos, opt }) { done(opt, await call("recolor-tag", { tag: need(pos[0], "tag name"), hue: need(pos[1], "hue") }), () => "recolored"); },

  async add({ pos, opt }) {
    if (!pos.length) throw new Error("missing URL");
    const at = new Date().toISOString();
    done(opt, await call("add", { urls: pos.map(url => ({ url, saved_at: at })), note: opt.note || "" }),
      r => `${r.added} added, ${r.skipped + r.updated} already on the list`);
  },

  async remove({ pos, opt }) {
    const url = need(pos[0], "URL");
    const d = await getData();
    if (source !== "live") throw new Error("Firefox is not running Link Keeper; changes need the live extension");
    const l = findLink(d, url);
    const places = [...new Set(l.copies.map(c => c.stash))].map(s => `--stash ${s}`);
    if (l.list && !l.list.loose) places.push("--list");
    if (l.cap) places.push("--capture");
    let stashIds = [], fromList = false, capture = false;
    if (opt.everywhere) { stashIds = [...new Set(l.copies.map(c => c.stash))]; fromList = !!l.list; capture = !!l.cap; }
    else if (opt.stash) stashIds = [opt.stash];
    else if (opt.list) fromList = true;
    else if (opt.capture) capture = true;
    else if (places.length === 1) [stashIds, fromList, capture] = [l.copies.map(c => c.stash).slice(0, 1), places[0] === "--list", places[0] === "--capture"];
    else throw new Error(`${l.url} is held in ${places.length} places; say which: ${places.join(", ")}, or --everywhere`);
    const results = [];
    for (const id of stashIds) {
      // Two tabs of one URL in a stash are two copies: one goes, unless --everywhere.
      const all = l.copies.filter(c => c.stash === id).map(c => c.tab);
      const ids = opt.everywhere ? all : all.slice(0, 1);
      if (!ids.length) throw new Error(`${l.url} is not in stash ${id}`);
      const r = await call("delete-stash", { id, ids });
      if (!r.removed) throw new Error(`stash ${id} gave up nothing; it may be locked`);
      results.push(`${r.removed} from stash ${id}`);
    }
    if (fromList || capture) {
      await call("remove", { urls: [l.url], alsoCaptures: capture });
      results.push(capture ? "capture and list entry" : "list entry");
    }
    out(`removed ${results.join(", ")}; link-keeper undo puts it back`);
  },

  async "stash-rename"({ pos, opt }) { done(opt, await call("rename-stash", { id: need(pos[0], "stash ID"), name: pos.slice(1).join(" ") }), () => "renamed"); },
  async "stash-flag"({ pos, opt }) {
    const fields = {};
    if (opt.lock || opt.unlock) fields.locked = !!opt.lock;
    if (opt.star || opt.unstar) fields.starred = !!opt.star;
    if (!Object.keys(fields).length) throw new Error("say --lock, --unlock, --star or --unstar");
    done(opt, await call("flag-stash", { id: need(pos[0], "stash ID"), ...fields }), () => "done");
  },
  async "stash-delete"({ pos, opt }) { done(opt, await call("delete-stash", { id: need(pos[0], "stash ID") }), r => `removed ${r.removed} tabs`); },

  async undo({ opt }) { done(opt, await live("undo", { force: !!opt.force }), r => `undid ${r.undone} from ${r.at}${r.summary ? ` (${r.summary})` : ""}`); },
  async history({ opt }) {
    const r = await live("history");
    if (opt.json) return json(r.entries);
    if (!r.entries.length) return out("no agent changes journaled");
    for (const e of r.entries) out(`${e.at}  ${e.cmd}  ${e.summary || ""}`);
  },

  async backup({ opt }) { done(opt, await live("backup"), r => `wrote ${r.file} (${Math.round(r.bytes / 1024)} KB)`); },
  async backups({ opt }) {
    let r = await request("backups");
    if (!r) {
      const dir = need(backupDir(), "LINK_KEEPER_BACKUP_DIR in config.local.sh");
      r = { folder: dir, backups: fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(".json") && !n.startsWith("."))
        .map(name => { const st = fs.statSync(path.join(dir, name)); return { name, bytes: st.size, modified: st.mtime.toISOString() }; })
        .sort((a, b) => b.modified.localeCompare(a.modified)) : [] };
    }
    if (opt.json) return json(r);
    out(r.folder);
    for (const b of r.backups) out(`${b.modified}  ${String(Math.round(b.bytes / 1024)).padStart(6)} KB  ${b.name}`);
  },
  async restore({ pos, opt }) { done(opt, await live("restore", { name: need(pos[0], "backup file name") }), r => `restored the backup of ${r.backup_at}${r.stashes ? `, and wrote ${r.stashes} stashes again` : ""}`); },

  async call({ pos }) {
    const fields = pos[1] ? JSON.parse(pos[1]) : {};
    json(await call(need(pos[0], "message type"), fields));
  },
};

function done(opt, res, say) { opt.json ? json(res) : out(say(res)); }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return out(HELP);
  const fn = commands[cmd];
  if (!fn) throw new Error(`no command ${cmd} (see --help)`);
  const args = parse(rest);
  if (args.opt.help) return out(HELP);
  await fn(args);
}

main().catch(e => { process.stderr.write(`link-keeper: ${e.message}\n`); process.exit(1); });
