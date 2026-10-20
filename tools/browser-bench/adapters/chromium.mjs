#!/usr/bin/env node
// DESC: Browser benchmark adapter: plain headless Chromium through Playwright, the baseline the agent browsers are measured against.
/* The adapter contract (tools/browser-bench/run.mjs): take one URL, load it with no logins in a fresh
 * context, print one JSON line {final_url, title, text, challenge} or {error}. Waits for the load event
 * and then up to 8 s of network quiet, so script-built pages have drawn.
 *
 * Usage: chromium.mjs URL     (Playwright from tools/preview-pages/.deps, which shoot-page.zsh installs)
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "preview-pages", ".deps", "package.json"));
const url = process.argv[2];
let browser;
try {
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { waitUntil: "load", timeout: 40000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    title: document.title || "",
    text: document.body?.innerText || "",
    challenge: !!document.querySelector('#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha.com"]'),
  }));
  console.log(JSON.stringify({ final_url: page.url(), ...r }));
} catch (e) {
  console.log(JSON.stringify({ error: String(e.message || e).split("\n")[0] }));
} finally {
  await browser?.close();
}
