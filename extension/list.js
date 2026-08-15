/* The full-page list. Everything the popup shows, but readable at 277 rows.
 *
 * Rows come pre-joined from the background (list entry + its capture, if any), so this file
 * only presents and filters. Clicking a title opens it in a new tab and tells the background
 * that entry is now current, so a Ctrl+Shift+K on that tab attaches the capture to it.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

let rows = [];
let filter = "all";
const domainSel = new Set();   // empty = every domain
let domainsExpanded = false;

function say(text) { $("msg").textContent = text; }

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch (e) { return "(unparseable)"; }
}

function shortUrl(url) { return String(url).replace(/^https?:\/\/(www\.)?/, ""); }

/* The date the link was saved, not when it was pasted in — a Telegram export spans years. */
function savedOn(row) { return row.saved_at || row.added_at || ""; }
const byNewest = (a, b) => String(savedOn(b)).localeCompare(String(savedOn(a)));

function labelOf(row) {
  const cap = row.cap;
  if (!cap) return null;
  // A plain tweet's title is only its handle; its text is what identifies it.
  const body = (cap.text || "").replace(/\s+/g, " ").trim();
  if (body && (!cap.title || /^@?\S+ on X$|^X post$/.test(cap.title))) {
    return (cap.handle ? `${cap.handle}: ` : "") + (body.length > 120 ? body.slice(0, 120) + "…" : body);
  }
  if (cap.handle && cap.title && !cap.title.includes(cap.handle)) return `${cap.handle} — ${cap.title}`;
  return cap.title || cap.handle || null;
}

/* Stable hue per domain — no palette to maintain, and the same trick the triage page uses. */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

async function load() {
  const { items, loose } = await send({ type: "dump" });
  rows = [...items, ...loose];
  render();
}

function matches(row, term) {
  if (filter !== "all" && row.status !== filter) return false;
  if (domainSel.size && !domainSel.has(hostOf(row.url))) return false;
  if (!term) return true;
  const hay = [row.url, labelOf(row), row.cap?.text, row.note, row.cap?.screenshot, savedOn(row),
    row.cap?.verdict, ...(row.cap?.links || []), ...(row.cap?.reply_links || []).map(l => l.href)]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(term);
}

function groupRows(visible, mode) {
  if (mode === "flat") return [["", [...visible].sort(byNewest)]];
  if (mode === "oldest") return [["", [...visible].sort(byNewest).reverse()]];
  if (mode === "status") {
    const order = ["pending", "seen", "skipped", "kept"];
    const names = {
      pending: "left to go through",
      seen: "opened, undecided",
      skipped: "skipped",
      kept: "kept",
    };
    return order
      .map(s => [names[s], visible.filter(r => r.status === s).sort(byNewest)])
      .filter(([, list]) => list.length);
  }
  const byHost = new Map();
  for (const row of visible) {
    const host = hostOf(row.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(row);
  }
  for (const list of byHost.values()) list.sort(byNewest);
  return [...byHost.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/* Source favicons, inlined as SVG so the page makes no network requests. A handful of brands
 * cover nearly the whole list; anything else gets a neutral monogram of its domain's first
 * letter, which is still a scent even for a host seen once. */
const BRAND_ICONS = {
  ig: '<rect width="24" height="24" rx="6" fill="#C13584"/><rect x="5.6" y="5.6" width="12.8" height="12.8" rx="3.4" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.1" cy="7.9" r="1.1" fill="#fff"/>',
  x: '<rect width="24" height="24" rx="6" fill="#000"/><path d="M5.8 5h4l3 4.4L16.2 5h2.6l-4.9 6.3L19.3 19h-4l-3.3-4.8L8.2 19H5.6l5.3-6.9L5.8 5z" fill="#fff"/>',
  gh: '<rect width="24" height="24" rx="6" fill="#181717"/><path transform="translate(3.6 3.6) scale(.7)" fill="#fff" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  yt: '<rect width="24" height="24" rx="6" fill="#FF0000"/><path d="M9.8 8.3v7.4l6.4-3.7z" fill="#fff"/>',
  rd: '<rect width="24" height="24" rx="6" fill="#FF4500"/><circle cx="8.8" cy="13" r="1.4" fill="#fff"/><circle cx="15.2" cy="13" r="1.4" fill="#fff"/><path d="M8.5 16.2c1 .9 2.2 1.3 3.5 1.3s2.5-.4 3.5-1.3" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2" fill="#fff"/><path d="M12 7.6c2.9 0 5.6 1 7.2 2.7M12 7.6C9.1 7.6 6.4 8.6 4.8 10.3" fill="none" stroke="#fff" stroke-width="1.1"/>',
  hn: '<rect width="24" height="24" rx="6" fill="#F60"/><text x="12" y="17" font-family="Verdana,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff">Y</text>',
};

function brandOf(host) {
  if (/(^|\.)instagram\.com$/.test(host)) return "ig";
  if (/(^|\.)(x|twitter)\.com$|^t\.co$/.test(host)) return "x";
  if (/(^|\.)github\.com$/.test(host)) return "gh";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "yt";
  if (/(^|\.)reddit\.com$/.test(host)) return "rd";
  if (host === "news.ycombinator.com") return "hn";
  return null;
}

function srcIcon(url) {
  const el = document.createElement("span");
  el.className = "src";
  const host = hostOf(url);
  const glyph = BRAND_ICONS[brandOf(host)] ||
    `<rect width="24" height="24" rx="6" fill="#5a5f6a"/><text x="12" y="17" font-family="Verdana,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff">${(host[0] || "•").toUpperCase()}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${glyph}</svg>`;
  el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  el.title = host;
  return el;
}

function rowEl(row) {
  const li = document.createElement("li");
  li.dataset.status = row.status;
  if (row.current) li.classList.add("current");

  li.append(srcIcon(row.url));
  li.append(Object.assign(document.createElement("span"), { className: "dot" }));

  const main = document.createElement("div");
  main.className = "main";

  const label = labelOf(row);
  const a = document.createElement("a");
  a.className = "ttl" + (label ? "" : " plain");
  a.href = row.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label || shortUrl(row.url);
  // Opening from the list makes this the current item, so a later keep attaches to it.
  a.addEventListener("click", () => send({ type: "set-current", url: row.url }).then(load));
  main.append(a);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(Object.assign(document.createElement("span"), { textContent: hostOf(row.url) }));
  const when = savedOn(row);
  if (when) {
    const t = document.createElement("time");
    t.dateTime = when;
    t.textContent = when.slice(0, 10);
    t.title = row.saved_at ? "saved on this date" : "added to the list on this date (original date unknown)";
    if (!row.saved_at) t.style.opacity = ".6";
    meta.append(t);
  }
  if (row.cap?.kind && row.cap.kind !== "page") {
    meta.append(Object.assign(document.createElement("span"), { textContent: row.cap.kind }));
  }
  if (!row.cap) meta.append(Object.assign(document.createElement("span"), { textContent: "not read yet" }));
  if (row.cap?.verdict) {
    const v = document.createElement("span");
    v.className = "png";
    v.textContent = row.cap.verdict === "keep" ? "✓ keep" : "✕ drop";
    v.style.color = row.cap.verdict === "keep" ? "var(--ok)" : "var(--bad)";
    meta.append(v);
  }
  if (row.note) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = row.note;
    meta.append(note);
  }
  main.append(meta);

  if (row.cap?.text) {
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = row.cap.text;
    main.append(body);
  }

  if (row.cap?.links?.length) {
    const inner = document.createElement("div");
    inner.className = "inner";
    for (const url of row.cap.links.slice(0, 5)) {
      const chip = document.createElement("a");
      chip.href = url;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.textContent = shortUrl(url);
      inner.append(chip);
    }
    main.append(inner);
  }

  // Links harvested from the replies — the author's own reply is the one that usually matters.
  if (row.cap?.reply_links?.length) {
    const box = document.createElement("div");
    box.className = "inner replies";
    for (const l of row.cap.reply_links.slice(0, 6)) {
      const a = document.createElement("a");
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = l.self ? "from-author" : "";
      a.textContent = `↩ ${shortUrl(l.href)}`;
      a.title = l.self ? `from the author's own reply (${l.from || "?"})` : `from a reply by ${l.from || "?"}`;
      box.append(a);
    }
    main.append(box);
  }

  // Actual thumbnails, not URLs — the point of keeping image links is to see them.
  if (row.cap?.images?.length) {
    const shots = document.createElement("div");
    shots.className = "shots";
    for (const src of row.cap.images.slice(0, 8)) {
      const a = document.createElement("a");
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.alt = "";
      a.append(img);
      shots.append(a);
    }
    if (row.cap.images.length > 8) {
      const more = document.createElement("span");
      more.className = "png";
      more.textContent = `+${row.cap.images.length - 8} more`;
      shots.append(more);
    }
    main.append(shots);
  }

  if (row.cap?.screenshot && !row.cap.shotThumb) {
    // No preview stored — Firefox's own screenshot, or one taken before previews existed.
    const tag = document.createElement("span");
    tag.className = "png";
    tag.textContent = `📄 ${row.cap.screenshot}`;
    const line = document.createElement("div");
    line.append(tag);
    main.append(line);
  }

  if (row.cap?.shotThumb) {
    const wrap = document.createElement("div");
    wrap.className = "shots";
    const img = document.createElement("img");
    img.src = row.cap.shotThumb;
    img.className = "shot-preview";
    img.loading = "lazy";
    img.alt = "";
    // The PNG itself lives in Downloads, which this page cannot load; the downloads API opens it.
    const btn = document.createElement("button");
    btn.className = "shot-btn";
    btn.title = `open ${row.cap.screenshot}`;
    btn.append(img);
    btn.onclick = async () => {
      const res = await send({ type: "open-shot", id: row.cap.shotId, filename: row.cap.screenshot });
      if (!res?.ok) say(res?.error || "could not open it");
    };
    wrap.append(btn);
    main.append(wrap);
  }

  li.append(main);

  const acts = document.createElement("div");
  acts.className = "acts";

  /* Read it without leaving this page: opens the link out of sight in your own session, extracts,
   * closes it. Needs permission for that site, asked for here because a permission prompt must come
   * from a click on an extension page. */
  const grab = document.createElement("button");
  grab.textContent = row.cap ? "re-read" : "read it";
  grab.title = "Open it in the background, read it, close it";
  grab.onclick = async () => {
    let origin;
    try {
      origin = new URL(row.url).origin + "/*";
    } catch (e) {
      return say("that URL cannot be opened");
    }
    const granted = await browser.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted) return say(`without access to ${hostOf(row.url)} it cannot be read`);

    grab.disabled = true;
    grab.textContent = "reading…";
    const res = await send({ type: "capture-url", url: row.url });
    if (res?.ok) {
      const r = res.record;
      const extra = [
        r.links?.length ? `${r.links.length} link${r.links.length > 1 ? "s" : ""}` : null,
        r.reply_links?.length ? `${r.reply_links.length} from replies` : null,
      ].filter(Boolean).join(", ");
      say(`read ${r.title || hostOf(row.url)}${extra ? ` — ${extra}` : ""}`);
    } else {
      say(res?.error || "could not read it");
      grab.disabled = false;
      grab.textContent = row.cap ? "re-read" : "read it";
    }
    load();
  };
  acts.append(grab);

  const actions = [
    ["open", "Open in this window", () => send({ type: "set-current", url: row.url })
      .then(() => browser.tabs.update({ url: row.url })).then(load)],
    [row.status === "kept" ? "unkeep" : "kept", "Toggle kept",
      () => send({ type: "mark", url: row.url, status: row.status === "kept" ? "seen" : "kept" }).then(load)],
    [row.status === "skipped" ? "unskip" : "skip", "Toggle skipped",
      () => send({ type: "mark", url: row.url, status: row.status === "skipped" ? "seen" : "skipped" }).then(load)],
    ["remove", "Remove from the list",
      () => send({ type: "remove", urls: [row.url] }).then(load)],
  ];
  for (const [text, title, fn] of actions) {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.onclick = fn;
    acts.append(b);
  }
  li.append(acts);
  return li;
}

/* Domain toggles. Multi-select: clicking narrows to the chosen set, clicking again releases;
 * nothing selected means no narrowing. The long tail hides behind an expander so fifty
 * one-off domains do not swallow the toolbar. */
function renderDomainChips() {
  const box = $("domains");
  box.textContent = "";
  const counts = new Map();
  for (const r of rows) {
    const h = hostOf(r.url);
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const hosts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = domainsExpanded ? hosts : hosts.slice(0, 12);

  const domainChip = (host, n) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("aria-pressed", String(domainSel.has(host)));
    chip.style.color = domainSel.has(host) ? "" : `hsl(${hue(host)} 55% 55%)`;
    chip.append(srcIcon(`https://${host}/`), host,
      Object.assign(document.createElement("span"), { className: "n", textContent: n }));
    chip.onclick = () => {
      domainSel.has(host) ? domainSel.delete(host) : domainSel.add(host);
      render();
    };
    return chip;
  };

  for (const [host, n] of shown) box.append(domainChip(host, n));
  // Selected domains always stay visible, even from the collapsed tail.
  for (const host of domainSel) {
    if (!shown.some(([h]) => h === host)) box.append(domainChip(host, counts.get(host) || 0));
  }
  if (hosts.length > 12) {
    const more = document.createElement("button");
    more.className = "chip";
    more.textContent = domainsExpanded ? "fewer −" : `+${hosts.length - 12} more`;
    more.onclick = () => { domainsExpanded = !domainsExpanded; render(); };
    box.append(more);
  }
  if (domainSel.size) {
    const clear = document.createElement("button");
    clear.className = "chip";
    clear.textContent = "clear ✕";
    clear.onclick = () => { domainSel.clear(); render(); };
    box.append(clear);
  }
}

function render() {
  renderDomainChips();
  const term = $("q").value.trim().toLowerCase();
  const counts = { pending: 0, seen: 0, kept: 0, skipped: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const total = rows.length;

  $("sub").textContent = total
    ? `${total} links · ${counts.kept} kept · ${counts.skipped} skipped · ${counts.seen} seen · ${counts.pending} left`
    : "nothing on the list yet";
  $("bar-kept").style.width = total ? `${counts.kept / total * 100}%` : "0";
  $("bar-seen").style.width = total ? `${counts.seen / total * 100}%` : "0";
  $("bar-skipped").style.width = total ? `${counts.skipped / total * 100}%` : "0";
  $("f-all").textContent = `all ${total}`;
  $("f-pending").textContent = `left ${counts.pending}`;
  $("f-seen").textContent = `seen ${counts.seen}`;
  $("f-kept").textContent = `kept ${counts.kept}`;
  $("f-skipped").textContent = `skipped ${counts.skipped}`;

  const visible = rows.filter(r => matches(r, term));
  const out = $("out");
  out.textContent = "";

  if (!visible.length) {
    const box = document.createElement("div");
    box.className = "empty";
    box.innerHTML = total
      ? "<b>Nothing matches.</b>Clear the filter or pick a different status."
      : "<b>The list is empty.</b>Add links from the popup, or press Ctrl+Shift+U on a page.";
    out.append(box);
    return;
  }

  for (const [name, list] of groupRows(visible, $("groupby").value)) {
    const section = document.createElement("section");
    section.className = "group";
    if (name) {
      const h2 = document.createElement("h2");
      const mono = document.createElement("span");
      mono.textContent = name;
      mono.style.color = `hsl(${hue(name)} 55% 50%)`;
      h2.append(mono, Object.assign(document.createElement("span"), { className: "n", textContent: list.length }));
      const rm = document.createElement("button");
      rm.textContent = "remove all";
      rm.onclick = () => {
        if (!confirm(`Remove all ${list.length} from ${name}? Captures are kept.`)) return;
        send({ type: "remove", urls: list.map(r => r.url) }).then(load);
      };
      h2.append(rm);
      section.append(h2);
    }
    const ul = document.createElement("ul");
    ul.className = "rows";
    for (const row of list) {
      try {
        ul.append(rowEl(row));
      } catch (e) {
        // One malformed row must not blank the page; fall back to the bare URL.
        const li = document.createElement("li");
        li.dataset.status = row.status;
        li.append(document.createElement("span"), Object.assign(document.createElement("div"), {
          className: "main", textContent: `${shortUrl(row.url)} — could not render: ${e.message}`,
        }));
        ul.append(li);
        console.error("row failed", row.url, e);
      }
    }
    section.append(ul);
    out.append(section);
  }
}

$("q").addEventListener("input", render);
$("groupby").addEventListener("change", render);

const FILTERS = ["all", "pending", "seen", "skipped", "kept"];
for (const which of FILTERS) {
  $(`f-${which}`).onclick = () => {
    filter = which;
    for (const other of FILTERS) {
      $(`f-${other}`).setAttribute("aria-pressed", String(other === which));
    }
    render();
  };
}

$("export").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing captured yet");
  const a = document.createElement("a");
  const body = captures.map(r =>
    JSON.stringify(r).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")).join("\n") + "\n";
  a.href = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  a.download = "link-captures.jsonl";
  a.click();
  URL.revokeObjectURL(a.href);
  say(`exported ${captures.length} captures to Downloads`);
};

$("to-cards").onclick = () => { location.href = "cards.html"; };

/* Import lives here rather than in the popup: choosing a file opens an OS dialog, which closes a
 * browser-action popup and destroys its JS before onchange can fire. A tab survives it. */
$("show-import").onclick = () => $("import-panel").classList.remove("hidden");
$("hide-import").onclick = () => $("import-panel").classList.add("hidden");

function parseJsonl(raw) {
  // split("\n") only: U+2028 appears raw inside tweet text and would tear a record in two.
  const records = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch (e) { bad++; }
  }
  return { records, bad };
}

async function runImport(raw) {
  const note = $("import-msg");
  const { records, bad } = parseJsonl(raw);
  if (!records.length) {
    note.className = "bad";
    note.textContent = `nothing readable${bad ? ` — ${bad} unparseable lines` : ""}`;
    return;
  }
  const res = await send({ type: "import-captures", records });
  note.className = "ok";
  note.textContent = `${res.added} new, ${res.enriched} filled in, ${res.skipped} already known`
    + `${res.marked ? `, ${res.marked} taken off the queue` : ""}`
    + `${bad ? `, ${bad} bad lines skipped` : ""} — ${res.total} captures held`;
  $("import-text").value = "";
  load();
}

$("import-file").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  $("import-msg").textContent = `reading ${file.name}…`;
  await runImport(await file.text());
  e.target.value = "";
};

$("do-import").onclick = () => {
  const raw = $("import-text").value.trim();
  if (!raw) return ($("import-msg").className = "bad", $("import-msg").textContent = "paste some JSONL, or choose a file");
  runImport(raw);
};

$("tidy").onclick = async () => {
  const done = rows.filter(r => r.status !== "pending").map(r => r.url);
  if (!done.length) return say("nothing to tidy — everything is still pending");
  if (!confirm(`Remove ${done.length} finished entries from the list? Captures are kept.`)) return;
  await send({ type: "remove", urls: done });
  say(`removed ${done.length} from the list`);
  load();
};

if (location.hash === "#import") $("import-panel").classList.remove("hidden");

/* If a refresh is waiting on loopback, take it now. Import is idempotent, so doing this on every
 * visit costs nothing and means the only step after a rebuild is opening this page. */
(async () => {
  const res = await send({ type: "fetch-pending" });
  if (!res?.ok) return;

  // A refresh hands over both halves: what it could read, and what it could not. The second lot are
  // the only links that still need a browser, so they go straight onto the queue rather than being
  // printed as a shell command to run by hand.
  let records = [], queue = [];
  const body = res.body.trim();
  if (body.startsWith("{")) {
    try {
      const bundle = JSON.parse(body);
      records = bundle.captures || [];
      queue = bundle.queue || [];
    } catch (e) { return; }
  } else {
    records = parseJsonl(body).records;
  }
  if (!records.length && !queue.length) return;

  const bits = [];
  if (records.length) {
    const out = await send({ type: "import-captures", records });
    bits.push(`${records.length} read — ${out.added} new, ${out.enriched} filled in`
      + `${out.marked ? `, ${out.marked} off the queue` : ""}`);
  }
  if (queue.length) {
    const out = await send({ type: "add", urls: queue });
    bits.push(`${queue.length} needing a browser — ${out.added} queued`
      + `${out.skipped ? `, ${out.skipped} already there` : ""}`);
  }

  const note = $("import-msg");
  note.className = "ok";
  note.textContent = `from the last refresh: ${bits.join("; ")}`;
  $("import-panel").classList.remove("hidden");
  load();
})();

load();
// Cheap way to stay in step with captures made in other tabs.
browser.storage.onChanged.addListener(load);
