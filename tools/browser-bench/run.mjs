#!/usr/bin/env node
// DESC: Run the browser benchmark's sample through one candidate browser's adapter and score each page the same way.
/* One runner for every candidate, so the numbers compare. An adapter is any command that takes one URL,
 * loads it in its browser (no logins, a fresh profile) and prints one JSON object:
 *   {final_url, title, text, challenge}   text: the page's visible text (document.body.innerText);
 *                                         challenge: true when a Cloudflare / reCAPTCHA / hCaptcha
 *                                         widget is on the page (#challenge-form, its iframes)
 *   {error}                               when it could not load the page at all
 * The runner times it, and scores it with the extension's own wall rules (extension/extractors.js,
 * wall()): login, captcha, blocked; else thin under THIN characters of text; else read.
 *
 * Pacing: one request per site per browser (the sample has one link per site), PACE_MS between pages,
 * and a page that takes over TIMEOUT_MS counts as an error. The owner's rule on traffic applies: a site
 * that refuses is not asked again, and nothing here retries.
 *
 * Usage: run.mjs --browser NAME [--sample FILE] [--limit N] -- ADAPTER [ARGS...]
 *   writes $DATA_DIR/browser-bench/results-NAME.jsonl, one line per link, and prints a summary
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dash = process.argv.indexOf("--");
const args = process.argv.slice(2, dash < 0 ? undefined : dash);
const adapter = dash < 0 ? [] : process.argv.slice(dash + 1);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const browser = opt("--browser");
if (!browser || !adapter.length || args.includes("--help")) {
  console.log("run.mjs --browser NAME [--sample FILE] [--limit N] -- ADAPTER [ARGS...]");
  process.exit(browser && adapter.length ? 0 : 1);
}
const dir = join(process.env.DATA_DIR || join(repo, "data"), "browser-bench");
const sample = readFileSync(opt("--sample", join(dir, "sample.jsonl")), "utf8").trim().split("\n").map(l => JSON.parse(l));
const limit = +opt("--limit", 0) || sample.length;
const out = join(dir, `results-${browser}.jsonl`);
const THIN = 200, PACE_MS = 3000, TIMEOUT_MS = 60000;

// extension/extractors.js wall(), on what the adapter returned.
const LOGIN_PATH = /^\/(accounts\/login|i\/flow\/login|login|signin|sign-in|uas\/login|authwall|checkpoint|ServiceLogin|v3\/signin)(\/|$|\?)/i;
const CAPTCHA_TITLE = /^(just a moment|attention required|verifying you are human|checking your browser|are you a robot|security check|bot verification)/i;
const BLOCKED_TITLE = /^(access denied|403 forbidden|forbidden|429 too many requests|too many requests|rate limit)/i;
const BLOCKED_TEXT = /(you('ve| have) been blocked|unusual traffic|too many requests|rate.limited|temporarily (blocked|restricted)|not able to serve your requests this quickly)/i;
function score(r) {
  if (r.error) return { verdict: "error", why: String(r.error).slice(0, 160) };
  let host = "", path = "/";
  try { const u = new URL(r.final_url || ""); host = u.hostname; path = u.pathname; } catch { /* no final url */ }
  const title = (r.title || "").trim(), text = (r.text || "").trim(), short = text.length < 1500;
  if (host === "accounts.google.com" || LOGIN_PATH.test(path)) return { verdict: "wall", why: "login" };
  if (CAPTCHA_TITLE.test(title) || (short && r.challenge)) return { verdict: "wall", why: `captcha: ${title.slice(0, 60)}` };
  if (BLOCKED_TITLE.test(title)) return { verdict: "wall", why: `blocked: ${title.slice(0, 60)}` };
  if (short && BLOCKED_TEXT.test(text)) return { verdict: "wall", why: `blocked: ${text.match(BLOCKED_TEXT)[0]}` };
  if (text.length < THIN) return { verdict: "thin", why: `${text.length} characters` };
  return { verdict: "read", why: `${text.length} characters` };
}

mkdirSync(dir, { recursive: true });
writeFileSync(out, "");
const tally = {};
for (const [i, s] of sample.slice(0, limit).entries()) {
  if (i) spawnSync("sleep", [String(PACE_MS / 1000)]);
  const t0 = Date.now();
  const run = spawnSync(adapter[0], [...adapter.slice(1), s.url], { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 1 << 26 });
  const ms = Date.now() - t0;
  let r;
  if (run.error?.code === "ETIMEDOUT" || run.signal) r = { error: `timed out after ${TIMEOUT_MS / 1000} s` };
  else {
    try { r = JSON.parse(run.stdout.trim().split("\n").pop() || "{}"); }
    catch { r = { error: `adapter printed no JSON (exit ${run.status}): ${(run.stderr || run.stdout || "").trim().slice(-200)}` }; }
  }
  const sc = score(r);
  const key = `${s.expect} → ${sc.verdict}`;
  tally[key] = (tally[key] || 0) + 1;
  appendFileSync(out, JSON.stringify({ ...s, browser, ms, ...sc, title: (r.title || "").slice(0, 120), text_len: (r.text || "").trim().length,
    text_head: (r.text || "").trim().replace(/\s+/g, " ").slice(0, 200), final_url: r.final_url || null }) + "\n");
  console.log(`${String(i + 1).padStart(3)} ${sc.verdict.padEnd(5)} ${String(ms).padStart(6)} ms  ${s.expect.padEnd(8)} ${s.url.slice(0, 90)}`);
}
console.log(`\n${browser}: ${Object.entries(tally).sort().map(([k, n]) => `${k} ${n}`).join(" · ")}\n→ ${out}`);
