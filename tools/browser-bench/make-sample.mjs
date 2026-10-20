#!/usr/bin/env node
// DESC: Draw the browser benchmark's sample from Link Keeper: one failed public link per site, plus controls that captured fine.
/* The benchmark asks one question of each candidate agent browser: does it read the pages Firefox's
 * captures failed on? So the sample is the owner's own known failures, read live through the agents'
 * CLI (tools/link-keeper.mjs): one link per site, so no site is asked twice per browser; every kind of
 * failure (thin, error, wall, skipped); and controls, links that captured fine, to show a browser does
 * not break what already works. Sites that need the owner's login (X, Instagram, Google, *.mertyas.in)
 * and local pages are left out: the agent browser is for public links.
 *
 * Usage: make-sample.mjs [--failed N] [--controls N] [--out FILE]
 *   defaults: 40 failed, 10 controls, $DATA_DIR/browser-bench/sample.jsonl (DATA_DIR from the
 *   environment, else the repo's data/)
 * Each line: {url, host, expect: "thin"|"error"|"wall"|"skipped"|"control", why}
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (args.includes("-h") || args.includes("--help")) {
  console.log("make-sample.mjs [--failed N] [--controls N] [--out FILE]");
  process.exit(0);
}
const nFailed = +opt("--failed", 40), nControls = +opt("--controls", 10);
const out = opt("--out", join(process.env.DATA_DIR || join(repo, "data"), "browser-bench", "sample.jsonl"));

const LOGIN_SITES = /(^|\.)(x\.com|twitter\.com|instagram\.com|google\.[a-z.]+|youtube\.com|mertyas\.in)$|^(localhost|127\.0\.0\.1|\[::1\])$/;
const links = filter => {
  const j = JSON.parse(execFileSync("node", [join(repo, "tools", "link-keeper.mjs"), "links", "--filter", filter, "--all", "--json"],
    { encoding: "utf8", maxBuffer: 1 << 28 }));
  return Array.isArray(j) ? j : j.links;
};
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
const isPublic = l => /^https?:\/\//.test(l.url) && hostOf(l.url) && !LOGIN_SITES.test(hostOf(l.url));

// Failed: one per site, kinds taken in turn so walls and errors are not crowded out by thin pages.
const byKind = {};
for (const l of links("failed").filter(isPublic)) (byKind[l.fail?.kind || "error"] ||= []).push(l);
const seen = new Set(), picked = [];
const kinds = Object.keys(byKind).sort();
while (picked.length < nFailed && kinds.some(k => byKind[k].length)) {
  for (const k of kinds) {
    while (byKind[k].length) {
      const l = byKind[k].shift();
      if (seen.has(hostOf(l.url))) continue;
      seen.add(hostOf(l.url));
      picked.push({ url: l.url, host: hostOf(l.url), expect: k, why: l.fail?.error || "" });
      break;
    }
    if (picked.length >= nFailed) break;
  }
}
// Controls: captured with real text, sites not already in the sample.
const controls = [];
for (const l of links("captured").filter(isPublic)) {
  if (controls.length >= nControls) break;
  if (seen.has(hostOf(l.url)) || (l.cap?.kind && l.cap.kind !== "page")) continue;
  seen.add(hostOf(l.url));
  controls.push({ url: l.url, host: hostOf(l.url), expect: "control", why: "captured fine in Firefox" });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, [...picked, ...controls].map(r => JSON.stringify(r)).join("\n") + "\n");
const count = {};
for (const r of [...picked, ...controls]) count[r.expect] = (count[r.expect] || 0) + 1;
console.log(`${picked.length + controls.length} links, ${seen.size} sites → ${out}`);
console.log(Object.entries(count).map(([k, n]) => `${k} ${n}`).join(" · "));
