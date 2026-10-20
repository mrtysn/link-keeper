#!/usr/bin/env node
// DESC: Ranked word search over the owner's saved links (title, URL, tags, note, captured text, reel transcripts and on-screen text), best match first.
//
// Reads through `link-keeper links` (live from Firefox, else the latest backup) and ranks with
// extension/link-search.js, the matcher the Links page uses. Every word must match.
//
// Usage: search-saved-links.mjs WORDS... [--limit N] [--site HOST] [--tag T] [--json]
//        default limit 15; each hit shows a snippet of captured text around the first matching word

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(args.length ? 0 : 2);
}

const opt = { limit: 15, site: null, tag: [], json: false };
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--limit") opt.limit = Number(args[++i]) || 15;
  else if (a === "--site") opt.site = args[++i];
  else if (a === "--tag") opt.tag.push(args[++i]);
  else if (a === "--json") opt.json = true;
  else words.push(a);
}
const query = words.join(" ");

const ctx = vm.createContext({});
vm.runInContext(readFileSync(path.join(REPO, "extension/link-search.js"), "utf8"), ctx);

const cli = ["links", "--all", "--json", "--text", ...(opt.site ? ["--site", opt.site] : []), ...opt.tag.flatMap(t => ["--tag", t])];
let raw;
try {
  raw = execFileSync("node", [path.join(REPO, "tools/link-keeper.mjs"), ...cli], { encoding: "utf8", maxBuffer: 1 << 30 });
} catch (e) {
  console.error(`could not read the links: ${(e.stderr || e.message).toString().trim().split("\n")[0]}`);
  process.exit(1);
}
const links = JSON.parse(raw.slice(raw.indexOf("{"))).links;

const fieldsOf = l => ({ title: [l.title, l.cap?.title].filter(Boolean).join(" "), url: l.url, tags: l.tags, note: l.list?.note, text: l.cap?.text, links: l.cap?.links });
const hits = Array.from(ctx.LinkSearch.rank(links, query, fieldsOf));

const snippet = (text, ws) => {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ");
  const at = Math.min(...ws.map(w => flat.toLowerCase().indexOf(w)).filter(n => n >= 0), Infinity);
  if (!Number.isFinite(at)) return "";
  const from = Math.max(0, at - 60);
  return `${from ? "…" : ""}${flat.slice(from, at + 140)}…`;
};
const ws = query.toLowerCase().split(/\s+/).filter(Boolean);
const shown = hits.slice(0, opt.limit).map(({ link: l, score }) => ({
  url: l.url, title: l.title || l.cap?.title || "", date: l.date || "", tags: l.tags, score: Math.round(score * 100) / 100,
  snippet: snippet(l.cap?.text, ws),
}));

if (opt.json) {
  console.log(JSON.stringify({ total: hits.length, shown: shown.length, hits: shown }, null, 2));
} else {
  for (const h of shown) {
    console.log(`${h.date}  ${h.score.toFixed(1).padStart(5)}  ${h.title || "(no title)"}\n    ${h.url}${h.tags.length ? `  [${h.tags.join(", ")}]` : ""}${h.snippet ? `\n    ${h.snippet}` : ""}`);
  }
  console.log(`${hits.length ? `${shown.length} of ${hits.length}` : "no"} match${hits.length === 1 ? "" : "es"} for: ${query}`);
}
