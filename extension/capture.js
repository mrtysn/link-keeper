/* The Capture page: the capture queue's progress, kept open in a tab of its own while a run goes on.
 *
 * capture-queue.js runs the queue in the background page and keeps its state in storage.session; this
 * page reads it (capture-queue-status) whenever that changes, and redraws the countdowns every second
 * between changes. It drives the queue with the same messages Links' line does: speed, pause, resume,
 * stop, retry failed, dismiss. Starting a run stays in Links, where the links are picked. */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter(k => k != null));
  return node;
}
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; } };
const n = x => x.toLocaleString("en-US");
const SPEED_KEY = "captureSpeed";   // Links remembers the speed under the same key

let queue = null;

/* "in 22 s", "in 3 min", or "now". */
function inTime(at) {
  const s = Math.ceil((at - Date.now()) / 1000);
  if (s <= 0) return "now";
  return s < 90 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

/* How long what is left takes at the pace each site allows: the slowest site sets it, since the others
 * load while it waits. A rough floor, not a promise: page loads add to it. */
function timeLeft(sites) {
  const ms = Math.max(0, ...sites.map(s => s.waiting * s.gap));
  const min = Math.round(ms / 60000);
  return min < 1 ? "under a minute" : min < 90 ? `about ${min} min` : `about ${(min / 60).toFixed(1)} h`;
}

function button(label, type, title) {
  const b = el("button", { type: "button", textContent: label, title });
  b.onclick = async () => show(await send({ type }));
  return b;
}

function drawActs() {
  const q = queue, box = $("acts");
  box.replaceChildren();
  if (["running", "paused"].includes(q.status)) {
    const pace = el("select", { title: "Gentle: one link at a time, every wait doubled. Fast: three at a time, waits halved" });
    pace.setAttribute("aria-label", "Capture speed");
    for (const [value, label] of [["gentle", "Gentle"], ["normal", "Normal"], ["fast", "Fast"]]) pace.append(el("option", { value, textContent: label }));
    pace.value = q.speed || "normal";
    pace.onchange = async () => {
      try { localStorage.setItem(SPEED_KEY, pace.value); } catch (e) { /* remembered for this run only */ }
      show(await send({ type: "capture-queue-speed", speed: pace.value }));
    };
    box.append(pace);
  }
  if (q.status === "running") box.append(button("Pause", "capture-queue-pause", "Finish the pages loading now, then wait"));
  if (q.status === "paused") box.append(button("Resume", "capture-queue-resume", "Carry on with the links still waiting"));
  if (["running", "paused"].includes(q.status)) box.append(button("Stop", "capture-queue-stop", "Drop the links still waiting; what was captured stays"));
  if (q.failed.length) box.append(button("Retry failed", "capture-queue-retry", "Put the failed links back in line, their sites no longer stopped"));
  if (["done", "stopped"].includes(q.status)) box.append(button("Dismiss", "capture-queue-dismiss", "Clear this run"));
}

function drawProgress() {
  const q = queue;
  const failed = q.failed.length, done = q.captured + q.skipped + failed;
  const head = { running: "Capturing", paused: "Paused", done: "Finished", stopped: "Stopped" }[q.status] || "";
  const started = q.started_at ? new Date(q.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  $("sub").textContent = `${head} · ${n(done)} of ${n(q.total)} done${q.pending && q.status === "running" ? ` · ${timeLeft(q.sites)} left` : ""}${started ? ` · started ${started}` : ""}`;
  const bar = $("bar");
  const part = (cls, x) => el("i", { className: cls, style: `width:${q.total ? (100 * x) / q.total : 0}%` });
  bar.replaceChildren(part("ok", q.captured), part("already", q.skipped), part("bad", failed));
  bar.setAttribute("aria-label", `${done} of ${q.total} done`);
  const stat = (cls, label, x) => el("span", {}, cls ? el("span", { className: `key`, style: `background:var(--${cls})` }) : null, el("b", { textContent: n(x) }), ` ${label}`);
  $("stats").replaceChildren(
    stat("ok", "captured", q.captured), stat("field", "captured already", q.skipped), stat("bad", "failed", failed),
    stat(null, "waiting", q.pending), stat(null, `sites${Object.keys(q.stoppedSites).length ? `, ${Object.keys(q.stoppedSites).length} stopped` : ""}`, q.sites.length));
}

function drawNow() {
  const q = queue, box = $("now");
  if (q.active.length) box.replaceChildren(...q.active.map(u => el("span", {}, el("a", { href: u, textContent: u, target: "_blank", rel: "noreferrer" }))));
  else if (q.status === "running" && q.next) box.replaceChildren(el("span", { className: "muted", textContent: `Waiting: ${q.next.host} ${inTime(q.next.at)}` }));
  else box.replaceChildren(el("span", { className: "muted", textContent: q.status === "paused" ? "Nothing; paused" : "Nothing" }));
}

/* Sites with links waiting first (most first), then the finished ones; stopped ones say why. */
function siteRows() {
  const q = queue;
  const rows = [...q.sites].sort((a, b) => (b.waiting > 0) - (a.waiting > 0) || b.waiting - a.waiting || (b.captured + b.failed) - (a.captured + a.failed) || a.host.localeCompare(b.host));
  $("sites-h").textContent = `Sites (${q.sites.length})`;
  $("sites").replaceChildren(...rows.map(s => {
    let next = "done", cls = "next";
    if (s.stopped) { next = `stopped: ${s.stopped}`; cls += " stop"; }
    else if (s.loading) { next = "loading"; cls += " load"; }
    else if (s.waiting) next = q.status === "running" ? `${inTime(s.nextAt)} · every ${Math.round(s.gap / 1000)} s` : `every ${Math.round(s.gap / 1000)} s`;
    return el("tr", {}, el("td", { className: "site", textContent: s.host }), el("td", { className: "n", textContent: n(s.waiting) }),
      el("td", { className: "n", textContent: n(s.captured) }), el("td", { className: "n", textContent: n(s.failed) }), el("td", { className: cls, textContent: next }));
  }));
}

function drawFeeds() {
  const q = queue;
  const when = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("recent-h").textContent = `Latest captures (${q.recent.length})`;
  $("recent").replaceChildren(...(q.recent.length ? q.recent.map(r => el("li", {},
    el("span", { className: "when", textContent: when(r.at) }),
    el("span", { className: "what" }, el("a", { href: r.url, textContent: r.title || r.url, target: "_blank", rel: "noreferrer", title: r.url }), el("span", { className: "t muted", textContent: `${hostOf(r.url)}${r.kind && r.kind !== "page" ? ` · ${r.kind}` : ""}` })),
    el("span", { className: `size${r.thin ? " thin" : ""}`, textContent: r.thin ? `${n(r.chars)} chars · almost empty` : `${n(r.chars)} chars` })))
    : [el("li", {}, el("span", { className: "muted", textContent: "None yet" }))]));
  $("failed-h").textContent = `Failed (${q.failed.length})`;
  $("failed").replaceChildren(...(q.failed.length ? [...q.failed].reverse().map(f => el("li", {},
    el("span", { className: "what" }, el("a", { href: f.url, textContent: f.url, target: "_blank", rel: "noreferrer" }), el("span", { className: "t why", textContent: f.error }))))
    : [el("li", {}, el("span", { className: "muted", textContent: "None" }))]));
}

function show(q) {
  if (q?.ok === false) return;
  queue = q;
  const idle = !q?.status || q.status === "idle";
  $("idle").hidden = !idle;
  $("run").hidden = idle;
  if (idle) { $("acts").replaceChildren(); $("sub").textContent = "The capture queue reads links out of sight, one site at a time."; return; }
  drawActs();
  drawProgress();
  drawNow();
  siteRows();
  drawFeeds();
}

async function load() {
  show(await send({ type: "capture-queue-status" }));
}
browser.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.captureQueue) load(); });
// The countdowns move between the queue's own changes.
setInterval(() => { if (queue?.status === "running") { drawNow(); siteRows(); drawProgress(); } }, 1000);
load();
