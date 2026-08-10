const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

function say(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

async function refresh() {
  const s = await send({ type: "status" });
  $("s-queued").textContent = s.queued;
  $("s-sent").textContent = s.sent;
  $("s-file").textContent = s.captures ?? "—";
  $("s-sink").innerHTML = s.reachable
    ? '<span class="dot on"></span> up'
    : '<span class="dot off"></span> not running';

  if (!$("sink").value) $("sink").value = s.sinkUrl;
  if (s.hasToken) $("token").placeholder = "saved — type to replace";

  if (s.sweep && !s.sweep.done && !s.sweep.stopped) {
    say(`sweeping ${s.sweep.index}/${s.sweep.total}${s.sweep.errors ? `, ${s.sweep.errors} failed` : ""}`);
  } else if (s.sweep?.done) {
    say(`sweep finished: ${s.sweep.total - s.sweep.errors}/${s.sweep.total} captured`, "ok");
  } else if (!s.hasToken) {
    say("No token set. Start link-sink.py and paste its token under Sink settings.", "bad");
  } else if (!s.reachable && s.queued) {
    say(`Sink down — ${s.queued} capture(s) held here. They send when it is back.`, "bad");
  } else if (s.lastError) {
    say(s.lastError, "bad");
  }
}

$("capture").onclick = async () => {
  say("reading page…");
  const res = await send({ type: "capture-active", note: $("note").value.trim() });
  if (res?.ok) {
    const r = res.record;
    const label = r.author?.handle ? `${r.author.handle} — ${r.title || ""}` : (r.title || r.url);
    const inner = r.links?.length ? ` (+${r.links.length} link${r.links.length > 1 ? "s" : ""})` : "";
    say(`captured: ${label}${inner}`.slice(0, 110), res.sent ? "ok" : "bad");
    $("note").value = "";
  } else {
    say(res?.error || "capture failed", "bad");
  }
  refresh();
};

$("flush").onclick = async () => {
  const res = await send({ type: "flush" });
  say(res.ok ? `sent ${res.sent}` : res.error, res.ok ? "ok" : "bad");
  refresh();
};

$("save").onclick = async () => {
  const res = await send({
    type: "save-config",
    sinkUrl: $("sink").value.trim(),
    token: $("token").value.trim(),
  });
  say(res?.ok ? "saved" : (res?.error || "saved — sink did not answer"), res?.ok ? "ok" : "bad");
  $("token").value = "";
  refresh();
};

$("bf-start").onclick = async () => {
  const urls = $("urls").value.split("\n").map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
  if (!urls.length) return say("no usable URLs in that list", "bad");

  // Reading a tab you are not looking at is outside activeTab, so ask for those origins
  // now — this click is the user gesture that permissions.request needs.
  let origins;
  try {
    origins = [...new Set(urls.map(u => new URL(u).origin + "/*"))];
  } catch (e) {
    return say("one of those lines is not a valid URL", "bad");
  }
  const granted = await browser.permissions.request({ origins });
  if (!granted) return say("without access to those sites the sweep cannot read them", "bad");

  const res = await send({ type: "sweep-start", urls });
  say(`sweep started over ${res.total} URLs — leave the window alone`, "ok");
};

$("bf-stop").onclick = async () => {
  await send({ type: "sweep-stop" });
  say("sweep stopped");
  refresh();
};

$("errors").onclick = async () => {
  const { errors } = await send({ type: "sweep-errors" });
  if (!errors.length) return say("no failures recorded", "ok");
  const body = errors.map(e => `${e.url}\t${e.error}`).join("\n");
  await navigator.clipboard.writeText(body).catch(() => {});
  say(`${errors.length} failure(s) copied to the clipboard`, "bad");
};

$("export").onclick = async () => {
  const { queue } = await send({ type: "export-queue" });
  if (!queue.length) return say("queue is empty", "");
  // JSONL, so the file appends straight onto the sink's log.
  const body = queue.map(r => JSON.stringify(r)).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  a.download = "link-captures.jsonl";
  a.click();
  URL.revokeObjectURL(a.href);
  say(`exported ${queue.length} — append onto link-captures.jsonl`, "ok");
};

refresh();
setInterval(refresh, 2000);
