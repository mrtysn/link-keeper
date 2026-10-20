#!/usr/bin/env node
// DESC: Browser benchmark adapter: Obscura (Rust headless browser, V8, no Chromium) through its own `fetch` command, default settings.
/* The adapter contract (tools/browser-bench/run.mjs): take one URL, load it with no logins in a fresh
 * context, print one JSON line {final_url, title, text, challenge} or {error}.
 *
 * Drives `obscura fetch URL --eval EXPR`, where EXPR returns the JSON the contract wants, read from the page
 * after Obscura's own settle wait (default: up to 5 s, returns once the page is quiet). No --stealth, no proxy,
 * no user-agent override: the release archive without a suffix (render, no stealth transport), as downloaded.
 *
 * Install (not committed; tools/browser-bench/.deps is gitignored):
 *   mkdir -p .deps/obscura && curl -sL https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.5/obscura-aarch64-macos.tar.gz | tar xz -C .deps/obscura
 * Usage: obscura.mjs URL
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.OBSCURA_BIN || join(here, "..", ".deps", "obscura", "obscura");
const url = process.argv[2];
const expr = `JSON.stringify({final_url: location.href, title: document.title || "", text: document.body ? document.body.innerText : "", challenge: !!document.querySelector('#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha.com"]')})`;

const p = spawnSync(bin, ["fetch", url, "--quiet", "--timeout", "40", "--eval", expr], { encoding: "utf8", timeout: 55000, maxBuffer: 64 << 20 });
if (p.error) {
  console.log(JSON.stringify({ error: String(p.error.message || p.error).split("\n")[0] }));
} else {
  const out = (p.stdout || "").trim();
  // --eval prints the expression's value; a JSON string may come back quoted, so unwrap once if needed.
  let r;
  try { r = JSON.parse(out); if (typeof r === "string") r = JSON.parse(r); } catch { r = null; }
  if (r && typeof r === "object") console.log(JSON.stringify(r));
  else console.log(JSON.stringify({ error: (p.stderr || out || `exit ${p.status}`).trim().split("\n").pop().slice(0, 200) }));
}
