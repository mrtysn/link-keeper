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

function rowEl(row) {
  const li = document.createElement("li");
  li.dataset.status = row.status;
  if (row.current) li.classList.add("current");

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

function render() {
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
  const { records, bad } = parseJsonl(res.body);
  if (!records.length) return;
  const out = await send({ type: "import-captures", records });
  const note = $("import-msg");
  note.className = "ok";
  note.textContent = `picked up ${records.length} from the last refresh — ${out.added} new, `
    + `${out.enriched} filled in${out.marked ? `, ${out.marked} taken off the queue` : ""}`;
  $("import-panel").classList.remove("hidden");
  load();
})();

load();
// Cheap way to stay in step with captures made in other tabs.
browser.storage.onChanged.addListener(load);
