/* The toolbar popup: a way into the three viewers, what to do with this tab, and the reading list's
 * next link. Everything else — adding links in bulk, exports, settings — lives on the List page.
 */

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

/* A popup is destroyed the moment it closes, so a note half-typed and the result of the last
 * action would vanish with it. Both are mirrored into storage and restored on open — the message
 * matters most, because an action's outcome is otherwise unknowable after the fact. */
const UI_KEY = "popupUi";
let ui = { note: "", noting: false, msg: "", msgClass: "" };
let uiTimer = null;

function saveUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => browser.storage.local.set({ [UI_KEY]: ui }).catch(() => {}), 250);
}

function say(text, cls = "") {
  $("msg").textContent = text;
  $("msg").className = cls;
  $("copy-msg").hidden = !text;
  Object.assign(ui, { msg: text, msgClass: cls });
  saveUi();
}

$("copy-msg").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("msg").textContent);
    $("copy-msg").textContent = "Copied";
  } catch (e) {
    $("copy-msg").textContent = "Copy failed";
  }
  setTimeout(() => ($("copy-msg").textContent = "Copy"), 1200);
};

const short = url => String(url).replace(/^https?:\/\/(www\.)?/, "");
const fmt = n => Number(n).toLocaleString();

/* A plain tweet's title is only its handle, so its text is what identifies it. */
function label(r) {
  const body = (r.text || "").replace(/\s+/g, " ").trim();
  if (body && (!r.title || /^@?\S+ on X$|^X post$/.test(r.title))) {
    return (r.handle ? `${r.handle}: ` : "") + (body.length > 90 ? body.slice(0, 90) + "…" : body);
  }
  if (r.handle && r.title && !r.title.includes(r.handle)) return `${r.handle} — ${r.title}`;
  return r.title || r.handle || short(r.url);
}

/* --- the viewers ------------------------------------------------------------------- */

const SOURCES = [["tabs", "Stashed tabs"], ["import", "Imports"], ["list", "Reading list"]];

async function counts() {
  const c = await send({ type: "link-counts" });
  $("n-links").textContent = fmt(c.total);
  $("n-undecided").textContent = fmt(c.undecided);
  $("n-stashes").textContent = fmt(c.stashes);
  $("n-stashes-word").textContent = c.stashes === 1 ? "stash" : "stashes";
  // Each source toggles, as in the pages' top bar; the viewers follow.
  const box = $("sources");
  box.textContent = "";
  for (const [id, name] of SOURCES) {
    const on = c.chosen.includes(id);
    const b = Object.assign(document.createElement("button"), {
      className: on ? "" : "off", textContent: `${name} ${fmt(c.sources[id])}`,
      title: on ? `Showing ${name.toLowerCase()} in the viewers; click to hide` : `Hidden from the viewers; click to show`,
    });
    b.setAttribute("aria-pressed", String(on));
    b.onclick = async () => {
      const next = on ? c.chosen.filter(s => s !== id) : [...c.chosen, id];
      await browser.storage.local.set({ viewSources: SOURCES.map(([s]) => s).filter(s => next.includes(s)) });
      counts();
    };
    box.append(b);
  }
}

for (const [id, type] of [["open-list", "open-list"], ["open-cards", "open-cards"], ["open-explore", "open-explore"]]) {
  $(id).onclick = async () => {
    await send({ type });
    window.close();
  };
}

/* --- this tab ---------------------------------------------------------------------- */

/* The stash shows its stashes as the tabs close, so the popup has nothing left to show. */
async function stash(scope) {
  const res = await send({ type: "stash", scope });
  if (res.ok) window.close();
  else say(res.error, "bad");
}
$("stash").onclick = () => stash("auto");
for (const b of document.querySelectorAll("#stash-menu [data-scope]")) {
  b.onclick = () => { $("stash-menu").hidePopover(); stash(b.dataset.scope); };
}

async function keep(withShot = false) {
  say(withShot ? "reading page, then shooting it…" : "reading page…");
  const res = await send({ type: "capture-active", note: $("note").value.trim(), withShot });
  if (res?.ok) {
    const r = res.record;
    const inner = r.links?.length ? ` (+${r.links.length} link${r.links.length > 1 ? "s" : ""})` : "";
    // Truncate the title, never the diagnostic — the reason a screenshot failed is the whole
    // point of showing anything at all.
    const head = `kept: ${label({ title: r.title, handle: r.author?.handle, url: r.url, text: r.text })}${inner}`.slice(0, 140);
    if (r.screenshot) {
      const s = r.screenshot;
      say(`${head}\npng ${s.width}×${s.height}${s.tiles ? ` from ${s.tiles} tiles` : ""} → ${s.filename}`, "ok");
    } else if (r.screenshot_error) {
      say(`${head}\nscreenshot failed: ${r.screenshot_error}`, "bad");
    } else {
      say(head, "ok");
    }
    showNote(false);
  } else {
    say(res?.error || "could not keep that page", "bad");
  }
  refresh();
}
$("keep").onclick = () => keep(false);

/* permissions.request needs a real user gesture, so the grant happens here rather than in the
 * background where the capture runs. Already-granted returns true immediately. */
$("keep-shot").onclick = async () => {
  $("keep-menu").hidePopover();
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: ["*://*/*"] });
  } catch (e) {
    return say(`could not request permission: ${e.message}`, "bad");
  }
  if (!granted) return say("reading pixels needs site access — declined", "bad");
  keep(true);
};

/* The note field shows only when asked for; it goes with the next Keep, and Enter keeps. */
function showNote(on) {
  $("note-row").hidden = !on;
  if (!on) $("note").value = "";
  Object.assign(ui, { noting: on, note: on ? $("note").value : "" });
  saveUi();
  if (on) $("note").focus();
}
$("keep-note").onclick = () => { $("keep-menu").hidePopover(); showNote(true); };
$("note").addEventListener("input", () => { ui.note = $("note").value; saveUi(); });
$("note").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); keep(false); }
  if (e.key === "Escape") { e.preventDefault(); showNote(false); }
});

$("queue").onclick = async () => {
  const res = await send({ type: "queue-active", note: $("note").value.trim() });
  say(res.ok ? (res.added ? "added to the reading list" : "already on the reading list") : (res.error || "could not add"), res.added ? "ok" : "");
  refresh();
};

/* Menus open beside their arrow, flipped up if they would run off the popup. */
for (const [menu, arrow] of [["stash-menu", "stash-more"], ["keep-menu", "keep-more"]]) {
  $(menu).addEventListener("toggle", e => {
    if (e.newState !== "open") return;
    const r = $(arrow).getBoundingClientRect(), m = $(menu);
    const below = r.bottom + 4 + m.offsetHeight <= innerHeight;
    m.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - 4 - m.offsetHeight)}px`;
    m.style.left = `${Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4))}px`;
  });
}

/* --- the reading list ------------------------------------------------------------------ */

async function refresh() {
  const s = await send({ type: "status" });
  const { pending = 0 } = s.counts;
  $("left").textContent = s.total ? `${fmt(pending)} left of ${fmt(s.total)}` : "";

  // What you are on if it came from the list, otherwise what is coming next.
  const onPage = !!s.current?.isOpen;
  const url = $("now-url");
  url.classList.remove("done");
  if (onPage) {
    $("now-lbl").textContent = "on now";
    url.textContent = short(s.current.url);
    url.title = s.current.url;
  } else if (s.next) {
    $("now-lbl").textContent = "next";
    url.textContent = short(s.next);
    url.title = s.next;
  } else {
    $("now-lbl").textContent = "";
    url.textContent = s.total ? "Nothing left to go through" : "Empty — + List adds this page";
    url.classList.add("done");
    url.title = "";
  }
  // One filled action: Keep while a list item is open in this tab, Next otherwise.
  $("keep").classList.toggle("primary", onPage);
  $("next").classList.toggle("primary", !onPage && !!s.next);
  $("next").disabled = !s.next;
  $("skip").disabled = !onPage && !s.next;
}

$("next").onclick = async () => {
  const res = await send({ type: "next" });
  say(res.ok ? `${res.remaining} left after this` : res.error, res.ok ? "" : "bad");
  refresh();
};

$("skip").onclick = async () => {
  const res = await send({ type: "skip" });
  say(res.ok ? `skipped · ${res.remaining} left` : res.error, res.ok ? "" : "bad");
  refresh();
};

/* Restore what the last popup session had in flight. */
browser.storage.local.get(UI_KEY).then(got => {
  ui = { ...ui, ...(got[UI_KEY] || {}) };
  if (ui.noting) {
    $("note-row").hidden = false;
    $("note").value = ui.note || "";
  }
  if (ui.msg) {
    $("msg").textContent = ui.msg;
    $("msg").className = ui.msgClass || "";
    $("copy-msg").hidden = false;
  }
}).catch(() => {});

counts();
refresh();
setInterval(refresh, 1500);
