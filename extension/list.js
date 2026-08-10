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

function labelOf(row) {
  const cap = row.cap;
  if (!cap) return null;
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
  const hay = [row.url, labelOf(row), row.cap?.text, row.note, ...(row.cap?.links || [])]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(term);
}

function groupRows(visible, mode) {
  if (mode === "flat") {
    return [["", [...visible].sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)))]];
  }
  if (mode === "status") {
    const order = ["pending", "seen", "kept"];
    const names = { pending: "left to go through", seen: "seen, not kept", kept: "kept" };
    return order
      .map(s => [names[s], visible.filter(r => r.status === s)])
      .filter(([, list]) => list.length);
  }
  const byHost = new Map();
  for (const row of visible) {
    const host = hostOf(row.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(row);
  }
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
  if (row.cap?.kind && row.cap.kind !== "page") {
    meta.append(Object.assign(document.createElement("span"), { textContent: row.cap.kind }));
  }
  if (!row.cap) meta.append(Object.assign(document.createElement("span"), { textContent: "not read yet" }));
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

  li.append(main);

  const acts = document.createElement("div");
  acts.className = "acts";
  const actions = [
    ["open", "Open in this window", () => send({ type: "set-current", url: row.url })
      .then(() => browser.tabs.update({ url: row.url })).then(load)],
    [row.status === "kept" ? "unkeep" : "kept", "Toggle kept",
      () => send({ type: "mark", url: row.url, status: row.status === "kept" ? "seen" : "kept" }).then(load)],
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
  const counts = { pending: 0, seen: 0, kept: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const total = rows.length;

  $("sub").textContent = total
    ? `${total} links · ${counts.kept} kept · ${counts.seen} seen · ${counts.pending} left`
    : "nothing on the list yet";
  $("bar-kept").style.width = total ? `${counts.kept / total * 100}%` : "0";
  $("bar-seen").style.width = total ? `${counts.seen / total * 100}%` : "0";
  $("f-all").textContent = `all ${total}`;
  $("f-pending").textContent = `left ${counts.pending}`;
  $("f-seen").textContent = `seen ${counts.seen}`;
  $("f-kept").textContent = `kept ${counts.kept}`;

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
    for (const row of list) ul.append(rowEl(row));
    section.append(ul);
    out.append(section);
  }
}

$("q").addEventListener("input", render);
$("groupby").addEventListener("change", render);

for (const which of ["all", "pending", "seen", "kept"]) {
  $(`f-${which}`).onclick = () => {
    filter = which;
    for (const other of ["all", "pending", "seen", "kept"]) {
      $(`f-${other}`).setAttribute("aria-pressed", String(other === which));
    }
    render();
  };
}

$("export").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing captured yet");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([captures.map(r => JSON.stringify(r)).join("\n") + "\n"],
    { type: "application/x-ndjson" }));
  a.download = "link-captures.jsonl";
  a.click();
  URL.revokeObjectURL(a.href);
  say(`exported ${captures.length} captures to Downloads`);
};

$("tidy").onclick = async () => {
  const done = rows.filter(r => r.status !== "pending").map(r => r.url);
  if (!done.length) return say("nothing to tidy — everything is still pending");
  if (!confirm(`Remove ${done.length} finished entries from the list? Captures are kept.`)) return;
  await send({ type: "remove", urls: done });
  say(`removed ${done.length} from the list`);
  load();
};

load();
// Cheap way to stay in step with captures made in other tabs.
browser.storage.onChanged.addListener(load);
