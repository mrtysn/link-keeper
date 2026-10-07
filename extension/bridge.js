/* --- the bridge: backups on disk, and a door for local agents -------------------------
 * native/link-keeper-bridge.py runs while this port is open; Firefox starts it on connect. The
 * open port also keeps this background page from being suspended, so the agents' socket stays up
 * as long as Firefox runs.
 *
 * Backups: about a minute after the first change to storage or to any bookmark, the whole storage
 * and the stashes go to the helper, which writes latest.json and one dated file a day. Firefox
 * deletes an add-on's storage when it is uninstalled; the stashes, being bookmarks, survive.
 *
 * Restore: storage carries a storageId from the first run of 5.46 on. Storage without one, no
 * captures and no reading list is a fresh install or a wiped profile: the latest backup comes back
 * by itself. Settings → Backups restores any other file, after saving the current state.
 *
 * Agents: tools/link-keeper.mjs talks to the helper's socket, which hands each request here as
 * { type: "request", id, cmd, args }. Reads answer from the live data. Changes go through the
 * pages' own messages (handleMessage), one at a time, each journaled with what it replaced so
 * `link-keeper undo` can put it back. Nothing an agent sends opens, closes or navigates a tab. */

const BRIDGE = "link_keeper_bridge";
const bridge = {
  port: null, state: "off", error: null, folder: null, lastBackup: null, retry: 30e3,
  calls: new Map(), chunks: new Map(), seq: 0,
};

function bridgeConnect() {
  if (bridge.port) return;
  let port;
  try { port = browser.runtime.connectNative(BRIDGE); } catch (e) { bridge.port = {}; bridgeDown(String(e.message || e)); return; }
  bridge.port = port;
  bridge.state = "connecting";
  port.onMessage.addListener(m => bridgeReceive(m).catch(e => console.error("bridge:", e)));
  port.onDisconnect.addListener(p => bridgeDown(p.error?.message || "the helper stopped"));
  port.postMessage({ type: "hello", version: browser.runtime.getManifest().version });
}

function bridgeDown(why) {
  bridge.port = null;
  bridge.state = "off";
  bridge.error = /no such native application/i.test(why) ? "the helper is not installed: run native/install.zsh" : why;
  for (const call of bridge.calls.values()) call.reject(new Error(bridge.error));
  bridge.calls.clear();
  // Not installed is not going to change soon; anything else is retried sooner, backing off.
  const wait = /not installed/.test(bridge.error) ? 10 * 60e3 : bridge.retry;
  bridge.retry = Math.min(bridge.retry * 2, 10 * 60e3);
  setTimeout(bridgeConnect, wait);
}

/* An operation the helper does itself: write or read a backup, keep the undo journal. */
function hostCall(op, fields = {}) {
  if (!bridge.port) return Promise.reject(new Error(bridge.error || "the helper is not running"));
  const id = `h${++bridge.seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bridge.calls.delete(id); reject(new Error(`the helper did not answer ${op}`)); }, 120e3);
    bridge.calls.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    bridge.port.postMessage({ type: "host", id, op, ...fields });
  });
}

async function bridgeReceive(m) {
  // Firefox takes at most 1 MB from the helper at once; anything bigger comes in parts.
  if (m.type === "chunk") {
    const parts = bridge.chunks.get(m.id) || [];
    parts[m.part] = m.data;
    bridge.chunks.set(m.id, parts);
    if (parts.filter(p => p != null).length < m.of) return;
    bridge.chunks.delete(m.id);
    m = JSON.parse(parts.join(""));
  }
  switch (m.type) {
    case "hello":
      bridge.state = "on";
      bridge.error = m.error || null;
      bridge.folder = m.backup_folder || null;
      bridge.retry = 30e3;
      await restoreIfEmpty().catch(e => console.error("restore:", e));
      backupSoon(5e3);
      return;
    case "host-reply": {
      const call = bridge.calls.get(m.id);
      bridge.calls.delete(m.id);
      call?.resolve(m.result);
      return;
    }
    case "request": {
      let result;
      try {
        result = await agentRequest(m.cmd, m.args || {});
      } catch (e) {
        result = { ok: false, error: String(e.message || e) };
      }
      bridge.port?.postMessage({ type: "reply", id: m.id, result });
      return;
    }
  }
}

/* --- backups -------------------------------------------------------------------------- */

async function backupData() {
  return {
    format: "link-keeper-backup",
    format_version: 1,
    extension_version: browser.runtime.getManifest().version,
    at: new Date().toISOString(),
    storage: await browser.storage.local.get(null),
    sessions: await getSessions(),
  };
}

async function backupNow(reason = "change") {
  clearTimeout(backupTimer);
  backupTimer = null;
  if (bridge.state !== "on") return { ok: false, error: bridge.error || "the helper is not running" };
  const res = await hostCall("backup", { reason, data: await backupData() });
  if (reason !== "pre-restore") bridge.lastBackup = res;
  return res;
}

/* The first change starts the clock and later ones ride along, so a busy minute is one backup
 * written at its end, never one put off for as long as changes keep coming. A sooner request
 * (the one on connecting) pulls a pending backup forward rather than waiting behind it. */
let backupTimer = null, backupDue = 0;
function backupSoon(ms = 60e3) {
  if (backupTimer && backupDue <= Date.now() + ms) return;
  clearTimeout(backupTimer);
  backupDue = Date.now() + ms;
  backupTimer = setTimeout(() => backupNow().catch(e => { bridge.lastBackup = { ok: false, error: String(e.message || e) }; }), ms);
}
browser.storage.onChanged.addListener((changes, area) => { if (area === "local") backupSoon(); });
for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) browser.bookmarks?.[ev]?.addListener(() => backupSoon());

const newStorageId = () => crypto.randomUUID();

async function restoreIfEmpty() {
  const got = await browser.storage.local.get(["storageId", "captures", "items"]);
  if (got.storageId) return;
  if (got.captures?.length || got.items?.length) {
    await browser.storage.local.set({ storageId: newStorageId() });
    return;
  }
  const res = await hostCall("read-backup", { name: "latest.json" }).catch(() => null);
  const s = res?.ok && res.data?.storage;
  if (!s || !(s.captures?.length || s.items?.length)) {
    await browser.storage.local.set({ storageId: newStorageId() });
    return;
  }
  const done = await restoreBackup(res.data, "automatic, storage was empty");
  if (done.ok) await notify(`restored your data from the backup of ${new Date(res.data.at).toLocaleString()}`);
}

/* Storage replaced by the backup's. Stashes are bookmarks and outlive an uninstall; only when none
 * are left (a new profile) are the backup's written again, as new stashes. */
async function restoreBackup(data, why) {
  if (data?.format !== "link-keeper-backup" || !data.storage) return { ok: false, error: "not a Link Keeper backup" };
  const now = await browser.storage.local.get(["captures", "items"]);
  if (now.captures?.length || now.items?.length) {
    const saved = await backupNow("pre-restore");
    if (!saved.ok) return { ok: false, error: `the current data could not be saved first: ${saved.error}` };
  }
  const stashesNow = await getSessions();
  const rewrite = !stashesNow.length && (data.sessions || []).length;
  const storage = { ...data.storage };
  if (rewrite) { delete storage.stashMeta; delete storage.stashRoot; }
  storage.storageId ||= newStorageId();
  storage.restoredFrom = { at: new Date().toISOString(), backup_at: data.at, why };
  // In the same queues the filters, tags and stash metadata are edited in, so no edit already
  // under way writes back what it read before the restore.
  await filterQueue(() => tagQueue(() => metaQueue(async () => {
    await browser.storage.local.clear();
    await browser.storage.local.set(storage);
  })));
  let stashes = 0;
  if (rewrite) {
    // Oldest first, each written at the top, so the order comes back as it was.
    for (const s of [...data.sessions].reverse()) {
      const res = await writeStash(s.tabs, { name: s.name, created_at: s.created_at, source: s.source, format: s.format });
      if (s.locked || s.starred) await editMeta(m => { Object.assign(m.stashes[res.id], s.locked && { locked: true }, s.starred && { starred: true }); });
      stashes++;
    }
  }
  await paintBadge();
  applyFilterRules().catch(() => {});
  return { ok: true, restored: Object.keys(data.storage).length, stashes, backup_at: data.at };
}

async function bridgeStatus() {
  return { ok: true, state: bridge.state, error: bridge.error, folder: bridge.folder, lastBackup: bridge.lastBackup };
}

/* --- agents --------------------------------------------------------------------------- */

/* The pages' messages an agent may send. Reads answer as they are; changes are journaled. What is
 * left out opens, closes, captures or navigates tabs, which stays with the person at the browser. */
const AGENT_READS = new Set(["status", "page-info", "filter-rules", "link-counts", "sessions", "links", "export",
  "export-list", "stash-settings", "get-folder"]);
const AGENT_WRITES = new Set(["set-tags", "tag-stash", "rename-tag", "delete-tag", "create-tag", "recolor-tag",
  "add", "remove", "restore-items", "rename-stash", "delete-stash", "move-stash", "move-stashed", "flag-stash",
  "put-back", "set-filter-rules", "filter-out-page", "import-captures", "import-stashes", "set-stash-source",
  "set-stash-settings", "toggle-excluded", "set-folder"]);
// What an agent's change can touch in storage; the journal keeps the ones it did.
const JOURNAL_KEYS = ["items", "captures", "linkTags", "tagDefs", "filterRules", "filteredAuto", "stashMeta",
  "stashSettings", "folder"];

const agentQueue = serial();

async function agentRequest(cmd, args) {
  switch (cmd) {
    case "status": return agentStatus();
    case "links": return { ok: true, live: true, ...await getLinks() };
    case "storage": return { ok: true, storage: await browser.storage.local.get(args.keys ?? null) };
    case "backup": return backupNow("agent");
    case "backups": return hostCall("list-backups");
    case "restore": {
      const res = await hostCall("read-backup", { name: String(args.name || "") });
      return res.ok ? restoreBackup(res.data, "asked for by an agent") : res;
    }
    case "history": return hostCall("journal-list");
    case "undo": return agentQueue(() => agentUndo(!!args.force));
    case "call": {
      const msg = args.message || {};
      if (AGENT_READS.has(msg.type)) return handleMessage(msg);
      if (AGENT_WRITES.has(msg.type)) return agentQueue(() => journaled(msg));
      return { ok: false, error: `${msg.type} is not open to agents; it acts on tabs, or does not exist` };
    }
    default:
      return { ok: false, error: `unknown command ${cmd}` };
  }
}

async function agentStatus() {
  const { links, stashes } = await getLinks();
  const got = await browser.storage.local.get(["captures", "items", "restoredFrom"]);
  return {
    ok: true, live: true, version: browser.runtime.getManifest().version,
    counts: {
      links: links.length, stashes: stashes.length, captures: (got.captures || []).length,
      list: (got.items || []).length, untagged: links.filter(l => !l.tags.length).length,
      filtered: links.filter(l => l.tags.includes(FILTER_TAG)).length,
    },
    backup: { folder: bridge.folder, last: bridge.lastBackup, error: bridge.error },
    restoredFrom: got.restoredFrom || null,
  };
}

/* FNV-1a over the JSON: enough to tell whether a value changed since. */
function hashOf(value) {
  const s = JSON.stringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
}

/* Where every stashed bookmark is: { [id]: { stash, index, title, url } }, and each stash's name. */
function stashPlaces(sessions) {
  const tabs = {}, names = {};
  for (const s of sessions) {
    names[s.id] = s.name;
    s.tabs.forEach((t, index) => { tabs[t.id] = { stash: s.id, index, url: t.url, title: t.title }; });
  }
  return { tabs, names };
}

/* One change, with what it replaced: the storage keys it altered and the bookmarks it moved,
 * removed or made. Undo needs exactly that and nothing more. */
async function journaled(msg) {
  const before = await browser.storage.local.get(JOURNAL_KEYS);
  const sessionsBefore = await getSessions();
  const result = await handleMessage(msg);
  const after = await browser.storage.local.get(JOURNAL_KEYS);
  const sessionsAfter = await getSessions();

  const storage = {}, absent = [], hashes = {};
  for (const k of JOURNAL_KEYS) {
    if (hashOf(before[k]) === hashOf(after[k])) continue;
    if (k in before) storage[k] = before[k]; else absent.push(k);
    hashes[k] = hashOf(after[k]);
  }
  const was = stashPlaces(sessionsBefore), is = stashPlaces(sessionsAfter);
  const byId = new Map(sessionsBefore.map(s => [s.id, s]));
  const removed = new Map(), added = [], moved = [], renamed = [];
  for (const [id, t] of Object.entries(was.tabs)) {
    if (!is.tabs[id]) {
      const s = byId.get(t.stash);
      const full = s.tabs.find(x => x.id === id);
      if (!removed.has(s.id)) removed.set(s.id, {
        stash: { id: s.id, name: s.name, created_at: s.created_at, source: s.source, format: s.format, locked: s.locked, starred: s.starred },
        tabs: [],
      });
      removed.get(s.id).tabs.push({ ...full, index: t.index });
    } else if (is.tabs[id].stash !== t.stash || is.tabs[id].index !== t.index) {
      moved.push({ id, parentId: t.stash, index: t.index });
    }
  }
  for (const id of Object.keys(is.tabs)) if (!was.tabs[id]) added.push(id);
  const addedFolders = Object.keys(is.names).filter(id => !(id in was.names));
  for (const [id, name] of Object.entries(was.names)) if (id in is.names && is.names[id] !== name) renamed.push({ id, title: name });

  const changed = Object.keys(hashes).length || removed.size || added.length || moved.length || renamed.length;
  if (changed) {
    const entry = {
      at: new Date().toISOString(), cmd: msg.type, message: msg,
      summary: [Object.keys(hashes).join(", "), removed.size && "stash tabs removed", added.length && "stash tabs added",
        moved.length && "stash tabs moved", renamed.length && "stashes renamed"].filter(Boolean).join("; "),
      storage, absent, hashes, stashes: { removed: [...removed.values()], added, addedFolders, moved, renamed },
    };
    const saved = await hostCall("journal-push", { entry });
    return { ...result, undo: saved.ok ? "link-keeper undo" : `not journaled: ${saved.error}` };
  }
  return result;
}

async function agentUndo(force) {
  const last = await hostCall("journal-last");
  if (!last.ok) return last;
  const e = last.entry;
  const now = await browser.storage.local.get(Object.keys(e.hashes));
  const since = Object.keys(e.hashes).filter(k => hashOf(now[k]) !== e.hashes[k]);
  if (since.length && !force) {
    return { ok: false, error: `${since.join(", ")} changed after ${e.cmd} (${e.at}); undoing would overwrite that too. Pass --force to undo anyway.` };
  }
  // Storage first: putting tabs back writes their marks under their new bookmark ids, after it.
  await tagQueue(() => metaQueue(async () => {
    if (Object.keys(e.storage).length) await browser.storage.local.set(e.storage);
    if (e.absent.length) await browser.storage.local.remove(e.absent);
  }));
  const st = e.stashes;
  for (const id of st.added) await browser.bookmarks.remove(id).catch(() => {});
  for (const id of st.addedFolders) await removeStashFolder(id);
  for (const { id, parentId, index } of st.moved) await browser.bookmarks.move(id, { parentId, index }).catch(() => {});
  for (const { id, title } of st.renamed) await browser.bookmarks.update(id, { title }).catch(() => {});
  let back = 0;
  for (const { stash, tabs } of st.removed) back += (await putBack(stash, tabs)).ids?.length || 0;
  await paintBadge();
  await hostCall("journal-drop", { entry_id: last.id });
  return { ok: true, undone: e.cmd, at: e.at, summary: e.summary, putBack: back };
}

bridgeConnect();
