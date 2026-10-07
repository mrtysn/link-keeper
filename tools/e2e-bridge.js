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
