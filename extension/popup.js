const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

function say(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

function short(url) {
  return String(url).replace(/^https?:\/\/(www\.)?/, "");
}

function label(r) {
  if (r.handle && r.title && !r.title.includes(r.handle)) return `${r.handle} — ${r.title}`;
  return r.title || r.handle || short(r.url);
}

function download(name, body, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function refresh() {
  const s = await send({ type: "status" });
  const { pending = 0, seen = 0, kept = 0 } = s.counts;

  $("t-kept").textContent = kept;
  $("t-seen").textContent = seen;
  $("t-pending").textContent = pending;
  $("t-total").textContent = s.total;
  $("bar-kept").style.width = s.total ? `${kept / s.total * 100}%` : "0";
  $("bar-seen").style.width = s.total ? `${seen / s.total * 100}%` : "0";

  // Show what you are on if it came from the list, otherwise what is coming next.
  if (s.current?.isOpen) {
    $("now-lbl").textContent = "on now, from the list";
    $("now-url").textContent = short(s.current.url);
  } else if (s.next) {
    $("now-lbl").textContent = "next up";
    $("now-url").textContent = short(s.next);
  } else {
    $("now-lbl").textContent = s.total ? "list finished" : "next up";
    $("now-url").textContent = s.total ? "nothing pending" : "list is empty";
  }

  $("next").disabled = !s.next;

  $("recent").textContent = "";
  for (const r of s.recent) {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = label(r);
    li.append(b);
    if (r.links) li.append(document.createTextNode(` +${r.links} link${r.links > 1 ? "s" : ""}`));
    $("recent").append(li);
  }
  $("export").disabled = !s.captures;
}

$("keep").onclick = async () => {
  say("reading page…");
  const res = await send({ type: "capture-active", note: $("note").value.trim() });
  if (res?.ok) {
    const r = res.record;
    const inner = r.links?.length ? ` (+${r.links.length} link${r.links.length > 1 ? "s" : ""})` : "";
    say(`kept: ${label({ title: r.title, handle: r.author?.handle, url: r.url })}${inner}`.slice(0, 110), "ok");
    $("note").value = "";
  } else {
    say(res?.error || "could not keep that page", "bad");
  }
  refresh();
};

$("next").onclick = async () => {
  const res = await send({ type: "next" });
  say(res.ok ? `${res.remaining} left after this` : res.error, res.ok ? "" : "bad");
  refresh();
};

$("open-list").onclick = async () => {
  await send({ type: "open-list" });
  window.close();
};

$("queue").onclick = async () => {
  const res = await send({ type: "queue-active", note: $("note").value.trim() });
  say(res.ok
    ? (res.added ? "added to the list" : "already on the list")
    : (res.error || "could not add"), res.added ? "ok" : "");
  refresh();
};

$("add").onclick = async () => {
  const urls = $("urls").value.split("\n").map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
  if (!urls.length) return say("no usable URLs in that box", "bad");
  const res = await send({ type: "add", urls });
  say(`added ${res.added}${res.skipped ? `, ${res.skipped} already known` : ""} — ${res.total} on the list`, "ok");
  $("urls").value = "";
  refresh();
};

$("export").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing captured yet", "");
  download("link-captures.jsonl", captures.map(r => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
  say(`exported ${captures.length} to Downloads`, "ok");
};

$("export-list").onclick = async () => {
  const { items } = await send({ type: "export-list" });
  if (!items.length) return say("the list is empty", "");
  download("link-worklist.jsonl", items.map(r => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
  say(`exported ${items.length} list entries`, "ok");
};

$("reset").onclick = async () => {
  await send({ type: "reset-progress" });
  say("progress reset — kept items untouched", "ok");
  refresh();
};

$("clear-captures").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing to clear", "");
  if (!confirm(`Delete all ${captures.length} captures? Export first if you have not.`)) return;
  await send({ type: "clear-captures" });
  say("captures cleared", "ok");
  refresh();
};

$("clear-list").onclick = async () => {
  if (!confirm("Empty the worklist? Captures are not affected.")) return;
  await send({ type: "clear-list" });
  say("list cleared", "ok");
  refresh();
};

refresh();
setInterval(refresh, 1500);
