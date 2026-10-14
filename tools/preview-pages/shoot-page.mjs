/* Screenshot one preview page at several widths into out/. Run by shoot-page.zsh, which builds and
 * serves the preview; node shoot-page.mjs <base url> <page path> <widths> <name> [--deal VALUE] [--until SELECTOR]
 * --deal picks that value in Cards' deck selector; --until presses S on Cards until SELECTOR matches. */
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const [base, path, widths, name, ...rest] = process.argv.slice(2);
const opt = n => { const i = rest.indexOf(n); return i < 0 ? null : rest[i + 1]; };
const b = await chromium.launch();
for (const width of widths.split(",").map(Number)) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(base + path); await p.waitForTimeout(800);
  if (opt("--deal")) { await p.selectOption("#deal-tag", opt("--deal") === "suggested" ? "\u0000suggested" : opt("--deal")); await p.waitForTimeout(600); }
  const until = opt("--until");
  for (let i = 0; until && i < 60 && !(await p.$(until)); i++) { await p.keyboard.press("s"); await p.waitForTimeout(250); }
  await p.evaluate(() => document.getElementById("key-guide")?.remove());
  await p.waitForTimeout(300);
  const file = `${process.env.OUT_DIR}/${name}-${width}.png`;
  await p.screenshot({ path: file, fullPage: true });
  console.log(file + (errs.length ? `  page errors: ${errs.join("; ")}` : ""));
  await p.close();
}
await b.close();
