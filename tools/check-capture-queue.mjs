#!/usr/bin/env node
// DESC: Check a running capture queue: each site's captures spaced at least its wait, and each capture looking like its page.
//
// Reads the queue's state and this run's captures through link-keeper (read-only), then prints one block: progress,
// the busiest sites with their closest two captures, any pair closer than the site's wait (capture-queue.js
// SITE_GAPS, at the run's speed, less the 20% jitter), and the captures that look wrong: no title, under 40
// characters of text, marked incomplete, a login or captcha title, or a page that moved to another site.
//
// Usage: node tools/check-capture-queue.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log((await import("node:fs")).readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 8).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}
const cli = fileURLToPath(new URL("link-keeper.mjs", import.meta.url));
const lk = (...a) => JSON.parse(execFileSync("node", [cli, ...a], { maxBuffer: 1 << 30 }).toString());
const q = lk("call", "capture-queue-status");
const caps = lk("call", "export").captures.filter(c => q.started_at && c.captured_at >= q.started_at && c.via === "list");
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "?"; } };
const SLOW = /(^|\.)(instagram\.com|x\.com|twitter\.com|linkedin\.com|facebook\.com|threads\.(net|com)|tiktok\.com)$/;
const MED = /(^|\.)(reddit\.com|youtube\.com|google\.[a-z.]+)$/;
const factor = { gentle: 2, normal: 1, fast: 0.5 }[q.speed] || 1;
const gap = h => (SLOW.test(h) ? 30 : MED.test(h) ? 8 : 2) * factor;

console.log(`${new Date().toISOString().slice(11, 19)}  ${q.status} · ${q.speed} · ${q.captured + q.skipped + q.failed.length}/${q.total} done · ${q.captured} captured · ${q.failed.length} failed · ${q.pending} waiting`);
console.log(`  loading: ${q.active.map(host).join(", ") || "-"} · stopped: ${Object.keys(q.stoppedSites).join(", ") || "-"}`);

// Spacing: the queue site is the one asked for (source_url when the page moved).
const bySite = new Map();
for (const c of caps) {
  const h = host(c.source_url || c.url);
  (bySite.get(h) || bySite.set(h, []).get(h)).push(Date.parse(c.captured_at));
}
const close = [];
for (const [h, ts] of bySite) {
  ts.sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) {
    const d = (ts[i] - ts[i - 1]) / 1000;
    if (d < gap(h) * 0.8 - 0.5) close.push(`${h} ${d.toFixed(1)}s < ${(gap(h) * 0.8).toFixed(1)}s`);
  }
}
const busiest = [...bySite].sort((a, b) => b[1].length - a[1].length).slice(0, 5)
  .map(([h, ts]) => `${h} ×${ts.length}${ts.length > 1 ? ` min ${Math.min(...ts.slice(1).map((t, i) => (t - ts[i]) / 1000)).toFixed(1)}s` : ""}`);
console.log(`  spacing: ${caps.length} captures over ${bySite.size} sites; busiest ${busiest.join(", ")}`);
console.log(close.length ? `  TOO CLOSE: ${close.join("; ")}` : "  spacing ok: no site captured faster than its wait");

// Content: what a good capture has, and the shapes that mean it is not the page.
const bad = [];
for (const c of caps) {
  const why = [];
  const text = (c.text || "").trim();
  if (!c.title) why.push("no title");
  if (text.length < 40) why.push(`text ${text.length} chars`);
  if (c.incomplete) why.push("incomplete");
  if (/^(log ?in|sign ?in|just a moment|access denied|attention required)/i.test(c.title || "")) why.push(`title "${c.title}"`);
  if (c.source_url && host(c.source_url) !== host(c.url)) why.push(`moved to ${host(c.url)}`);
  if (why.length) bad.push(`${(c.source_url || c.url).slice(0, 90)} — ${why.join(", ")}`);
}
const kinds = {};
for (const c of caps) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
console.log(`  content: ${caps.length - bad.length} look right, ${bad.length} suspect · kinds ${JSON.stringify(kinds)}`);
for (const b of bad.slice(-12)) console.log(`    ${b}`);
const fails = q.failed.filter(f => !/^not tried/.test(f.error));
if (fails.length) console.log(`  failed: ${fails.slice(-8).map(f => `${host(f.url)}: ${f.error.slice(0, 70)}`).join(" | ")}`);
