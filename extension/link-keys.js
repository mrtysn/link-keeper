/* What a key means on every Link Keeper page, in one place. List, Cards, Explore and Tag all read
 * this table, and their key hints are drawn from it, so the pages cannot drift apart.
 *
 * There are no panes to switch between: every key means one thing wherever the page has the keyboard.
 * The left hand rests on WASD, as in a game, with the number row as the reddit keyboard navigation
 * (RES) has it: 1 2 move, 3 4 read and open. Judging sits on Q E, beside the movement keys rather
 * than on them, so walking can never judge a link.
 *
 *   W S  1 2   previous / next link; a sidebar and the view beside it move together (held, they repeat)
 *   A D        previous / next group — the stash, List's section, the tag on Tags
 *   Q E        drop / keep, then on to the next link; again on a judged link clears it
 *   3          read it in        4  open it        ⇧4  open it with the other stash effect
 *   T L M      tags · to the reading list · move to a stash
 *   ⌘⌫  ⌘Z     remove · undo
 *   /  ?  Esc  filter · these keys · back out
 *   P          Explore's live preview on/off
 *
 * The arrows are aliases: ↑ ↓ walk, ← → judge, as a card is swiped. Only walking repeats while a
 * key is held, so a held key cannot judge or remove a run of links. Plain keys never act while a
 * field has the keyboard; Escape there leaves the field.
 */

const LinkKeys = (() => {
  const MAC = /Mac/.test(navigator.platform);
  const MOD = MAC ? "⌘" : "Ctrl+";

  // cmd → the keys shown for it and what it does, in the order the key list gives them.
  const TABLE = [
    { cmd: "prev", show: ["W", "1", "↑"], does: "previous link" },
    { cmd: "next", show: ["S", "2", "↓"], does: "next link" },
    { cmd: "group-prev", show: ["A"], does: "previous group: stash, section or tag" },
    { cmd: "group-next", show: ["D"], does: "next group: stash, section or tag" },
    { cmd: "drop", show: ["Q", "←"], does: "drop, then next" },
    { cmd: "keep", show: ["E", "→"], does: "keep, then next" },
    { cmd: "read", show: ["3"], does: "capture its text and images" },
    { cmd: "open", show: ["4"], does: "open" },
    { cmd: "open-other", show: ["⇧4"], does: "open, other restore" },
    { cmd: "tags", show: ["T"], does: "tags" },
    { cmd: "list", show: ["L"], does: "to the reading list" },
    { cmd: "move", show: ["M"], does: "move to a stash" },
    { cmd: "remove", show: [`${MOD}⌫`], does: "remove from its stash or the list" },
    { cmd: "undo", show: [`${MOD}Z`], does: "undo" },
    { cmd: "preview", show: ["P"], does: "live preview on/off" },
    { cmd: "filter", show: ["/"], does: "filter" },
    { cmd: "help", show: ["?"], does: "these keys" },
    { cmd: "escape", show: ["Esc"], does: "back out" },
  ];
  const BY_CMD = new Map(TABLE.map(r => [r.cmd, r]));

  const PLAIN = { w: "prev", s: "next", a: "group-prev", d: "group-next", q: "drop", e: "keep", t: "tags", l: "list", m: "move", p: "preview" };
  const DIGITS = { Digit1: "prev", Digit2: "next", Digit3: "read", Digit4: "open" };
  const ARROWS = { ArrowUp: "prev", ArrowDown: "next", ArrowLeft: "drop", ArrowRight: "keep" };
  const REPEATING = new Set(["prev", "next"]);

  const inField = t => !!t?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");

  /* The command a keydown means here, or null when it belongs to the page or the browser. */
  function command(e) {
    if (e.isComposing) return null;
    if (inField(e.target)) return e.key === "Escape" ? "escape" : null;
    const mod = MAC ? e.metaKey : e.ctrlKey;
    let cmd = null;
    if (mod) {
      if (e.altKey) return null;
      if ((e.key === "Backspace" || e.key === "Delete") && !e.shiftKey) cmd = "remove";
      else if (e.key.toLowerCase() === "z" && !e.shiftKey) cmd = "undo";
      else return null;
    } else {
      if (e.altKey || (MAC ? e.ctrlKey : e.metaKey)) return null;
      // Digits by their place, so ⇧4 reads as 4 whatever the layout prints on it.
      if (DIGITS[e.code]) cmd = e.shiftKey ? (e.code === "Digit4" ? "open-other" : null) : DIGITS[e.code];
      else if (ARROWS[e.key] && !e.shiftKey) cmd = ARROWS[e.key];
      else if (e.key === "?") cmd = "help";
      else if (e.key === "/") cmd = "filter";
      else if (e.key === "Escape") cmd = "escape";
      else if (!e.shiftKey && PLAIN[e.key.toLowerCase()]) cmd = PLAIN[e.key.toLowerCase()];
    }
    // "" means: ours, but a held key that does not repeat.
    if (cmd && e.repeat && !REPEATING.has(cmd)) return "";
    return cmd;
  }

  /* Every page listens the same way: handlers maps a command to what this page does with it. A
   * command the page has no handler for stays the browser's. A held key that must not repeat is
   * swallowed, not passed on. */
  /* labels renames a command's keycap in the guide where it does something else here. */
  function listen(handlers, { labels: names } = {}) {
    startGuide(Object.keys(handlers), names);
    addEventListener("keydown", e => {
      const cmd = command(e);
      if (cmd === "") { e.preventDefault(); return; }
      if (cmd === "help" && !handlers.help) { e.preventDefault(); toggleGuide(); return; }
      const run = cmd && handlers[cmd];
      if (!run) return;
      press(e);
      if (cmd === "escape" && inField(e.target)) { e.target.blur(); }
      e.preventDefault();
      run(e);
    });
  }

  const showOf = cmd => BY_CMD.get(cmd)?.show[0] || "";

  /* A hint line: the keys for these commands, each with what it does. */
  function hint(cmds, extra = []) {
    const out = [];
    for (const cmd of cmds) {
      const r = BY_CMD.get(cmd);
      if (!r) continue;
      if (out.length) out.push(" · ");
      out.push(el("kbd", { textContent: r.show[0] }), ` ${r.does}`);
    }
    for (const node of extra) out.push(" · ", node);
    if (out.length) out.push(" · ");
    out.push(el("kbd", { textContent: "?" }), " key guide");
    return out;
  }

  /* --- the key guide -----------------------------------------------------------------
   * A drawn keyboard docked in the corner: the left hand's keys where they sit, each keycap naming
   * what it does here, coloured by kind. Keys this page has no use for are faint, and the key held
   * down sinks, lit, until it is let go. ? shows and hides it; the choice is remembered. */
  const SHORT = {
    prev: "up", next: "down", "group-prev": "◂ group", "group-next": "group ▸", drop: "drop", keep: "keep",
    read: "capture", open: "open", "open-other": "open other", tags: "tags", list: "to list", move: "move",
    remove: "remove", undo: "undo", preview: "preview", filter: "filter", help: "keys", escape: "back",
  };
  const KIND = {
    prev: "go", next: "go", "group-prev": "go", "group-next": "go", drop: "drop", keep: "keep",
    read: "open", open: "open", "open-other": "open", tags: "edit", list: "edit", move: "edit", remove: "edit",
    undo: "edit", preview: "view", filter: "view", help: "view", escape: "view",
  };
  // The left hand's rows as they sit, and the keys away from it beneath; null caps are spacers.
  const ROWS = [
    [["`"], ["1", "prev"], ["2", "next"], ["3", "read"], ["4", "open"], ["5"]],
    [["Tab", null, "wide"], ["Q", "drop"], ["W", "prev"], ["E", "keep"], ["R"], ["T", "tags"]],
    [["Caps", null, "wider"], ["A", "group-prev"], ["S", "next"], ["D", "group-next"], ["F"], ["G"]],
  ];
  const EXTRA = [["L", "list"], ["M", "move"], ["P", "preview"], ["/", "filter"], ["⇧4", "open-other"],
    [`${MOD}Z`, "undo"], [`${MOD}⌫`, "remove"], ["Esc", "escape"], ["?", "help"]];
  // The physical keys behind each keycap (KeyboardEvent.code), and whether Shift is part of it.
  const CODES = {
    1: "Digit1", 2: "Digit2", 3: "Digit3", 4: "Digit4", Q: "KeyQ ArrowLeft", W: "KeyW ArrowUp", E: "KeyE ArrowRight",
    T: "KeyT", A: "KeyA", S: "KeyS ArrowDown", D: "KeyD", L: "KeyL", M: "KeyM", P: "KeyP", "/": "Slash",
    "⇧4": "Digit4", [`${MOD}Z`]: "KeyZ", [`${MOD}⌫`]: "Backspace Delete", Esc: "Escape", "?": "Slash",
  };
  const SHIFTED = new Set(["⇧4", "?"]);
  const GUIDE_KEY = "keyGuide";
  let active = new Set();
  let labels = {};

  const cap = ([label, cmd, size]) => {
    const k = el("div", { className: `kc${size ? ` ${size}` : ""}${cmd ? ` k-${KIND[cmd]}` : " off"}` },
      el("b", { textContent: label }), cmd ? el("span", { textContent: labels[cmd] || SHORT[cmd] }) : null);
    if (cmd) {
      k.dataset.cmd = cmd;
      k.dataset.code = CODES[label] || "";
      k.dataset.shift = SHIFTED.has(label) ? "1" : "";
      k.title = BY_CMD.get(cmd)?.does || "";
      if (!active.has(cmd)) k.classList.add("idle");
    }
    return k;
  };
  function drawGuide() {
    const box = el("aside", { id: "key-guide", className: "key-guide" });
    box.setAttribute("aria-label", "Keys");
    const close = el("button", { type: "button", className: "kg-x", textContent: "×", title: "Hide the keys (?)" });
    close.onclick = () => showGuide(false);
    box.append(el("div", { className: "kg-head" }, el("strong", { textContent: "Keys" }),
      el("span", { textContent: "↑↓ move · ←→ keep or drop · held, only moving repeats" }), close));
    for (const row of ROWS) box.append(el("div", { className: "kg-row" }, ...row.map(cap)));
    box.append(el("div", { className: "kg-row kg-extra" }, ...EXTRA.map(cap)));
    return box;
  }
  function showGuide(on) {
    document.getElementById("key-guide")?.remove();
    if (on) document.body.append(drawGuide());
    document.body.classList.toggle("kg-on", on);
    try { localStorage.setItem(GUIDE_KEY, on ? "on" : "off"); } catch (e) { /* storage unavailable */ }
  }
  const toggleGuide = () => showGuide(!document.getElementById("key-guide"));
  /* The keycap for the key pressed, not every key bound to the command; it stays down while held,
   * so an auto-repeat changes nothing on screen. */
  function press(e) {
    const caps = [...document.querySelectorAll("#key-guide .kc[data-code]")].filter(k => k.dataset.code.split(" ").includes(e.code));
    const k = caps.find(c => !!c.dataset.shift === e.shiftKey) || caps[0];
    k?.classList.add("down");
  }
  function release(e) {
    const all = /^(Shift|Meta|Control|Alt)/.test(e.key) || e.type === "blur";
    for (const k of document.querySelectorAll("#key-guide .kc.down")) {
      if (all || k.dataset.code.split(" ").includes(e.code)) k.classList.remove("down");
    }
  }
  addEventListener("keyup", release);
  addEventListener("blur", release);
  /* First visit: shown, unless the window is too narrow to spare the corner. */
  function startGuide(cmds, names) {
    active = new Set([...cmds, "help", "escape"]);
    labels = names || {};
    let pref = null;
    try { pref = localStorage.getItem(GUIDE_KEY); } catch (e) { /* storage unavailable */ }
    const on = pref ? pref === "on" : innerWidth >= 720;
    const go = () => { if (on) showGuide(true); };
    if (document.body) go(); else addEventListener("DOMContentLoaded", go);
  }

  return { command, listen, hint, showOf, toggleGuide, MOD };
})();
