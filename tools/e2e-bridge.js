/* The bridge checks, run by tools/test-bridge-firefox.zsh beside the real extension in a headless
 * Firefox, with the real helper (registered by native/install.zsh) writing into a temporary folder.
 * Midway it sets the screenshot folder to "cli-go"; the wrapper sees that through the CLI, drives
 * the CLI against the live socket, and answers by creating the tag "cli-done". */

const until = async (what, test, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await test()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const tagsOf = async url => (await browser.storage.local.get("linkTags")).linkTags?.[keyOf(url)] || [];
const CAP = "https://example.org/cap";

await check("the bridge connects and names the backup folder", async () => {
  await until("the bridge", () => bridge.state === "on");
  if (!bridge.folder) throw new Error(`no backup folder: ${bridge.error}`);
});

await check("a fresh profile with no backup gets a storageId and nothing restored", async () => {
  await until("a storageId", async () => (await browser.storage.local.get("storageId")).storageId);
  if ((await browser.storage.local.get("restoredFrom")).restoredFrom) throw new Error("it restored something");
});

await browser.storage.local.set({
  captures: [{ url: CAP, title: "Cap", text: "captured text", captured_at: "2026-10-01T10:00:00Z" }],
  items: [{ url: "https://example.org/listed", status: "pending", added_at: "2026-10-01T10:00:00Z" }],
});
const made = await writeStash([{ url: "https://example.org/s1", title: "S1" }, { url: "https://example.org/s2", title: "S2" }], { name: "e2e stash" });

await check("a backup writes latest.json with storage and stashes", async () => {
  const res = await backupNow("agent");
  if (!res.ok || !/latest\.json$/.test(res.file)) throw new Error(JSON.stringify(res));
  const back = await hostCall("read-backup", { name: "latest.json" });
  if (back.data.storage.captures[0].text !== "captured text") throw new Error("the capture is not in it");
  if (!back.data.sessions.some(s => s.name === "e2e stash" && s.tabs.length === 2)) throw new Error("the stash is not in it");
});

await check("an agent's tag change is journaled and undone", async () => {
  const res = await agentRequest("call", { message: { type: "set-tags", url: CAP, tags: ["e2e"] } });
  if (!res.ok || !res.undo) throw new Error(JSON.stringify(res));
  if ((await tagsOf(CAP)).join() !== "e2e") throw new Error("not tagged");
  const u = await agentRequest("undo", {});
  if (!u.ok) throw new Error(JSON.stringify(u));
  if ((await tagsOf(CAP)).length) throw new Error(`still tagged ${await tagsOf(CAP)}`);
});

await check("an agent's removal of one stash copy is undone into its place", async () => {
  const [stash] = (await getSessions()).filter(s => s.id === made.id);
  const res = await agentRequest("call", { message: { type: "delete-stash", id: made.id, ids: [stash.tabs[0].id] } });
  if (res.removed !== 1) throw new Error(JSON.stringify(res));
  const u = await agentRequest("undo", {});
  if (!u.ok || u.putBack !== 1) throw new Error(JSON.stringify(u));
  const after = (await getSessions()).find(s => s.id === made.id);
  if (after?.tabs.map(t => t.url).join() !== "https://example.org/s1,https://example.org/s2") throw new Error(after?.tabs.map(t => t.url).join());
});

await check("undo refuses to overwrite a change made after the agent's, unless forced", async () => {
  await agentRequest("call", { message: { type: "set-tags", url: CAP, tags: ["agent"] } });
  await setTags(CAP, ["by-hand"]);
  const u = await agentRequest("undo", {});
  if (u.ok || !/linkTags.* changed after/.test(u.error)) throw new Error(JSON.stringify(u));
  const f = await agentRequest("undo", { force: true });
  if (!f.ok || (await tagsOf(CAP)).length) throw new Error(JSON.stringify(f));
});

await check("agent-set tag suggestions show on links, step aside for tags, and undo reverts them", async () => {
  const suggestedOf = async url => (await getLinks()).links.find(l => l.key === keyOf(url))?.suggested || [];
  const set = (suggestions, replace = false) => agentRequest("call", { message: { type: "set-tag-suggestions", suggestions, replace } });
  const res = await set({ [CAP]: [{ tag: "Dev  Tools", p: 0.4, by: "system-one" }, { tag: "ai", p: 0.9, by: "model" }],
    "https://example.org/listed": [{ tag: "video", p: 0.7, by: "model" }] });
  if (!res.ok || res.count !== 2 || !res.undo) throw new Error(JSON.stringify(res));
  const got = await suggestedOf(CAP);
  if (got.map(s => s.tag).join() !== "ai,dev tools" || got[0].p !== 0.9 || got[0].by !== "model") throw new Error(JSON.stringify(got));
  await setTags(CAP, ["mine"]);
  if ((await suggestedOf(CAP)).length) throw new Error("a link with tags carries suggestions");
  await setTags(CAP, []);
  const merged = await set({ "https://example.org/listed": [] });
  if (!merged.ok || merged.count !== 1 || (await suggestedOf("https://example.org/listed")).length || (await suggestedOf(CAP)).length !== 2) throw new Error(JSON.stringify(merged));
  const replaced = await set({ "https://example.org/listed": [{ tag: "news", p: 0.5, by: "system-one" }] }, true);
  if (replaced.count !== 1 || (await suggestedOf(CAP)).length) throw new Error(JSON.stringify(replaced));
  if ((await set({ [CAP]: "ai" })).ok) throw new Error("a malformed list was accepted");
  const u = await agentRequest("undo", {});
  if (!u.ok) throw new Error(JSON.stringify(u));
  if ((await suggestedOf(CAP)).length !== 2) throw new Error("undo did not bring the replaced suggestions back");
  await agentRequest("undo", {});
  await agentRequest("undo", {});
  if ((await browser.storage.local.get("tagSuggestions")).tagSuggestions) throw new Error("undo left suggestions in storage");
});

await check("agent tags: merged, replaced and removed per link, apart from tags, and undo reverts them", async () => {
  const agentOf = async url => (await getLinks()).links.find(l => l.key === keyOf(url));
  const set = (tags, replace = false, by = "haiku") => agentRequest("call", { message: { type: "set-agent-tags", tags, by, replace } });
  const listed = "https://example.org/listed";
  const res = await set({ [CAP]: ["Dev  Tools", "ai", "ai"], [listed]: ["video"] });
  if (!res.ok || res.count !== 2 || !res.undo) throw new Error(JSON.stringify(res));
  const link = await agentOf(CAP);
  if (link.agentTags.join() !== "dev tools,ai" || link.agentBy !== "haiku") throw new Error(JSON.stringify([link.agentTags, link.agentBy]));
  await setTags(CAP, ["mine"]);
  const tagged = await agentOf(CAP);
  if (tagged.agentTags.length !== 2 || tagged.tags.join() !== "mine") throw new Error("agent tags and the owner's tags are not apart");
  await setTags(CAP, []);
  if ((await browser.storage.local.get("tagDefs")).tagDefs.list.some(t => t.name === "dev tools")) throw new Error("an agent tag entered the tag library");
  const merged = await set({ [listed]: [] });
  if (!merged.ok || merged.count !== 1 || (await agentOf(listed)).agentTags.length || (await agentOf(CAP)).agentTags.length !== 2) throw new Error(JSON.stringify(merged));
  const replaced = await set({ [listed]: ["news"] }, true, "sonnet");
  if (replaced.count !== 1 || (await agentOf(CAP)).agentTags.length || (await agentOf(listed)).agentBy !== "sonnet") throw new Error(JSON.stringify(replaced));
  if ((await set({ [CAP]: "ai" })).ok) throw new Error("a malformed list was accepted");
  if ((await set({ [CAP]: ["ai"] }, false, " ")).ok) throw new Error("a write with no author was accepted");
  const u = await agentRequest("undo", {});
  if (!u.ok) throw new Error(JSON.stringify(u));
  if ((await agentOf(CAP)).agentTags.length !== 2) throw new Error("undo did not bring the replaced agent tags back");
  await agentRequest("undo", {});
  await agentRequest("undo", {});
  if ((await browser.storage.local.get("agentTags")).agentTags) throw new Error("undo left agent tags in storage");
});

await check("agents cannot send what acts on tabs", async () => {
  for (const type of ["stash", "restore-stash", "next", "capture-url", "open-list", "queue-active"]) {
    const res = await agentRequest("call", { message: { type } });
    if (res.ok !== false) throw new Error(`${type} was let through`);
  }
});

await check("the CLI reads and changes the live extension through the socket", async () => {
  await browser.storage.local.set({ folder: "cli-go" });
  await until("the CLI's run", async () => (await browser.storage.local.get("tagDefs")).tagDefs?.list?.some(t => t.name === "cli-done"), 90000);
  const items = (await browser.storage.local.get("items")).items;
  if (!items.some(i => i.url === "https://example.org/from-cli")) throw new Error("link-keeper add did not land");
  if ((await tagsOf("https://example.org/from-cli")).join() !== "cli") throw new Error(`tags ${await tagsOf("https://example.org/from-cli")}`);
});

await check("wiped storage comes back from the latest backup by itself", async () => {
  await backupNow("agent");
  await browser.storage.local.clear();
  await restoreIfEmpty();
  const got = await browser.storage.local.get(["captures", "items", "storageId", "restoredFrom"]);
  if (got.captures?.[0]?.text !== "captured text") throw new Error("captures did not come back");
  if (!got.items?.some(i => i.url === "https://example.org/from-cli")) throw new Error("the reading list did not come back");
  if (!got.storageId || !got.restoredFrom) throw new Error("not marked restored");
});

await check("Settings compares a backup with what is here before restoring it", async () => {
  await backupNow("agent");
  const res = await handleMessage({ type: "compare-backup", name: "latest.json" });
  if (!res.ok) throw new Error(JSON.stringify(res));
  for (const k of ["links in no stash", "captures", "tagged links", "tags", "in the Trash", "filter rules"]) {
    if (typeof res.now[k] !== "number" || res.now[k] !== res.file[k]) throw new Error(`${k}: ${res.now[k]} vs ${res.file[k]}`);
  }
  if ((await handleMessage({ type: "compare-backup", name: "no-such.json" })).ok) throw new Error("a missing file compared");
});

await check("a restore into a profile with no stashes writes them again", async () => {
  for (const s of await getSessions()) await removeStashFolder(s.id);
  const back = await hostCall("read-backup", { name: "latest.json" });
  const res = await restoreBackup(back.data, "e2e");
  if (!res.ok || res.stashes < 1) throw new Error(JSON.stringify(res));
  const s = (await getSessions()).find(x => x.name === "e2e stash");
  if (s?.tabs.length !== 2) throw new Error("the stash did not come back whole");
  const pre = (await hostCall("list-backups")).backups.filter(b => b.name.startsWith("pre-restore-"));
  if (!pre.length) throw new Error("the state before the restore was not saved");
});
