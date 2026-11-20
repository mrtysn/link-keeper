#!/usr/bin/env node
// DESC: The drop list: links the owner decided not to keep before they were ever saved; read by the import and `link-keeper pile`.
/* One JSON line per dropped link: {at, key, url}. A link is dropped by its key (extension/links.js
 * keyOf), so every spelling of it is. The file is appended to by `link-keeper drop`, and read by:
 *
 *   tools/import-links.zsh   filter-lines drops them from the worklist before any lookup, and
 *                            filter-handoff takes their captures and queue entries out of the handover
 *   tools/link-keeper.mjs    `pile` leaves dropped links that link-keeper does not hold out
 *
 * Where the file lives: DROP_LIST in config.local.sh, else link-drops.jsonl in DATA_DIR.
 *
 * Usage:
 *   drop-list.mjs filter-lines --drops FILE            stdin to stdout, minus lines whose first tab field is dropped
 *   drop-list.mjs filter-handoff --drops FILE HANDOFF  rewrite link-handoff.json without dropped captures and queue entries */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINKS = vm.createContext({ URL, console });
vm.runInContext(fs.readFileSync(path.join(REPO, "extension/links.js"), "utf8"), LINKS);
export const keyOf = url => LINKS.keyOf(url);

/** [{at, key, url}] of the file; a missing file is an empty list, a damaged line is skipped. */
export function readDrops(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.key) out.push(rec);
    } catch { /* a half-written line is not a drop */ }
  }
  return out;
}

export const readDropKeys = file => new Set(readDrops(file).map(r => r.key));

/** Add urls to the file, one line each, skipping the ones already there. Returns {added, already}. */
export function appendDrops(file, urls, at = new Date().toISOString()) {
  const have = readDropKeys(file);
  const lines = [];
  let already = 0;
  for (const url of urls) {
    const key = keyOf(url);
    if (have.has(key)) { already++; continue; }
    have.add(key);
    lines.push(JSON.stringify({ at, key, url }));
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a");
    try { fs.writeSync(fd, lines.join("\n") + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { added: lines.length, already };
}

const isDropped = (keys, ...urls) => urls.some(u => u && keys.has(keyOf(u)));

function filterLines(keys) {
  const kept = fs.readFileSync(0, "utf8").split("\n").filter(line => !(line.startsWith("http") && isDropped(keys, line.split("\t")[0].trim())));
  process.stdout.write(kept.join("\n"));
}

function filterHandoff(keys, file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const before = [data.captures?.length || 0, data.queue?.length || 0];
  data.captures = (data.captures || []).filter(c => !isDropped(keys, c.url, c.source_url));
  data.queue = (data.queue || []).filter(q => !isDropped(keys, q.url));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  const gone = [before[0] - data.captures.length, before[1] - data.queue.length];
  if (gone[0] || gone[1]) console.log(`  ${gone[0]} captures and ${gone[1]} queued links left out: on the drop list`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const at = rest.indexOf("--drops");
  const file = at >= 0 ? rest[at + 1] : null;
  if (!file) { console.error("drop-list: --drops FILE is required"); process.exit(2); }
  const keys = readDropKeys(file);
  if (cmd === "filter-lines") filterLines(keys);
  else if (cmd === "filter-handoff") filterHandoff(keys, rest.filter((a, i) => i !== at && i !== at + 1)[0]);
  else { console.error("drop-list: filter-lines or filter-handoff"); process.exit(2); }
}
