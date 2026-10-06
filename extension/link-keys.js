/* What a key means on every Link Keeper page, in one place. List, Cards, Explore and Tag all read
 * this table, and their key hints are drawn from it, so the pages cannot drift apart.
 *
 * The left hand rests on WASD, as in a game, with the number row as the reddit keyboard navigation
 * (RES) has it: 1 2 move, 3 4 read and open. Judging sits on Q E, beside the movement keys rather
 * than on them, so walking can never judge a link.
 *
 *   W S  1 2   previous / next link in the focused pane (held, they repeat)
 *   A D        previous / next pane — sidebar and view; on a page of one pane, previous / next section
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
    { cmd: "pane-prev", show: ["A"], does: "previous pane or section" },
    { cmd: "pane-next", show: ["D"], does: "next pane or section" },
    { cmd: "drop", show: ["Q", "←"], does: "drop, then next" },
    { cmd: "keep", show: ["E", "→"], does: "keep, then next" },
    { cmd: "read", show: ["3"], does: "read it in" },
    { cmd: "open", show: ["4"], does: "open" },
    { cmd: "open-other", show: ["⇧4"], does: "open, with the other stash effect" },
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

  const PLAIN = { w: "prev", s: "next", a: "pane-prev", d: "pane-next", q: "drop", e: "keep", t: "tags", l: "list", m: "move", p: "preview" };
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
  function listen(handlers) {
    addEventListener("keydown", e => {
      const cmd = command(e);
      if (cmd === "") { e.preventDefault(); return; }
      if (cmd === "help" && !handlers.help) { e.preventDefault(); toggleHelp(Object.keys(handlers)); return; }
      const run = cmd && handlers[cmd];
      if (!run) return;
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
    out.push(el("kbd", { textContent: "?" }), " all keys");
    return out;
  }

  /* The key list, over the page: every command this page answers to. */
  function toggleHelp(cmds) {
    const open = document.getElementById("keys-help");
    if (open) { open.remove(); return; }
    const rows = TABLE.filter(r => cmds.includes(r.cmd) || r.cmd === "help" || r.cmd === "escape");
    const box = el("div", { id: "keys-help", className: "keys-help" },
      el("h2", { textContent: "Keys" }),
      el("dl", {}, ...rows.flatMap(r => [el("dt", {}, ...r.show.flatMap((k, i) => [i ? " " : null, el("kbd", { textContent: k })]).filter(Boolean)), el("dd", { textContent: r.does })])),
      el("p", { textContent: "WASD walks and changes pane; Q E judge; the number row walks, reads and opens as reddit's keyboard navigation does." }));
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Keys");
    const close = e => {
      if (e.type === "keydown" ? e.key !== "Escape" && e.key !== "?" : box.contains(e.target)) return;
      if (e.type === "keydown") { e.preventDefault(); e.stopPropagation(); }
      box.remove();
      removeEventListener("keydown", close, true);
      removeEventListener("pointerdown", close, true);
    };
    addEventListener("keydown", close, true);
    addEventListener("pointerdown", close, true);
    document.body.append(box);
  }

  return { command, listen, hint, showOf, toggleHelp, MOD };
})();
