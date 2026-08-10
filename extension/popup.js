const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

function say(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
}

function label(r) {
  if (r.handle && r.title && !r.title.includes(r.handle)) return `${r.handle} — ${r.title}`;
  return r.title || r.handle || r.url;
}

async function refresh() {
  const s = await send({ type: "status" });
  $("total").textContent = s.total;

  $("recent").textContent = "";
  for (const r of s.recent) {
    const li = document.createElement("li");
    const strong = document.createElement("b");
    strong.textContent = label(r);
    li.append(strong);
    if (r.links) li.append(document.createTextNode(` +${r.links} link${r.links > 1 ? "s" : ""}`));
    $("recent").append(li);
  }

  if (s.sweep && !s.sweep.done && !s.sweep.stopped) {
    say(`sweeping ${s.sweep.index}/${s.sweep.total}${s.sweep.errors ? `, ${s.sweep.errors} failed` : ""}`);
  } else if (s.sweep?.done) {
    say(`sweep finished — ${s.sweep.total - s.sweep.errors}/${s.sweep.total} captured`, "ok");
  }
}

$("capture").onclick = async () => {
  say("reading page…");
  const res = await send({ type: "capture-active", note: $("note").value.trim() });
  if (res?.ok) {
    const r = res.record;
    const inner = r.links?.length ? ` (+${r.links.length} link${r.links.length > 1 ? "s" : ""})` : "";
    say(`captured: ${label({ title: r.title, handle: r.author?.handle, url: r.url })}${inner}`.slice(0, 110), "ok");
    $("note").value = "";
  } else {
    say(res?.error || "capture failed", "bad");
  }
  refresh();
};

$("export").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing captured yet", "");
  // JSONL: one object per line, so it appends and streams cleanly.
  const body = captures.map(r => JSON.stringify(r)).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  a.download = "link-captures.jsonl";
  a.click();
  URL.revokeObjectURL(a.href);
  say(`exported ${captures.length} to Downloads`, "ok");
};

$("clear").onclick = async () => {
  const { captures } = await send({ type: "export" });
  if (!captures.length) return say("nothing to clear", "");
  if (!confirm(`Delete all ${captures.length} captures? Export first if you have not.`)) return;
  await send({ type: "clear" });
  say("cleared", "ok");
  refresh();
};

$("bf-start").onclick = async () => {
  const urls = $("urls").value.split("\n").map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
  if (!urls.length) return say("no usable URLs in that list", "bad");

  // Reading a tab you are not looking at is outside activeTab, so ask for those origins
  // now — this click is the user gesture permissions.request needs.
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
  await navigator.clipboard.writeText(errors.map(e => `${e.url}\t${e.error}`).join("\n")).catch(() => {});
  say(`${errors.length} failure(s) copied to the clipboard`, "bad");
};

refresh();
setInterval(refresh, 2000);
