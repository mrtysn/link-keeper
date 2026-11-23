// Sync between Macs in a real Firefox, beside the real extension, its real helper and a local sync
// server: run by tools/test-sync-firefox.zsh, which puts `const ROLE = "seed" | "join" | "rejoin";`
// in front of this file. "seed" writes the server's first snapshot and sends a change; "join" takes
// that snapshot as a fresh profile would, then sends a change of its own; "rejoin", another fresh
// profile, must hold both.

const until = async (fn, ms = 60e3, what = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`timed out waiting for ${what}`);
};
const store = async k => (await browser.storage.local.get(k))[k];
const pendingOps = async () => (await store("syncPending") || []).length;
const SEED_KEY = "example.org/e2e-seed";

await check("the helper is up", () => until(() => bridge.state === "on", 60e3, "the helper"));

if (ROLE === "seed") {
  await browser.storage.local.set({ captures: [{ kind: "page", url: "https://example.org/e2e-seed", text: "seeded text" }] });
  await check("the seed writes the server's first snapshot", async () => {
    const r = await syncNow();
    if (!r.ok || r.waiting) throw new Error(JSON.stringify(r));
    if (!(await store("syncState"))?.seeded) throw new Error("not marked as seeded");
  });
  await browser.storage.local.set({ linkTags: { [SEED_KEY]: ["from-seed"] } });
  await check("a change is recorded and sent", async () => {
    await until(async () => (await pendingOps()) > 0, 10e3, "the change to be recorded");
    const r = await syncNow();
    if (!r.ok || !r.pushed) throw new Error(JSON.stringify(r));
    if (await pendingOps()) throw new Error("ops left unsent");
  });
}

if (ROLE === "join") {
  await check("a fresh profile takes the snapshot and the change after it", async () => {
    const r = await syncNow();
    if (!r.ok || r.waiting) throw new Error(JSON.stringify(r));
    const caps = await store("captures") || [];
    if (!caps.some(c => c.url === "https://example.org/e2e-seed" && c.text === "seeded text")) throw new Error(`captures: ${JSON.stringify(caps)}`);
    const tags = (await store("linkTags") || {})[SEED_KEY];
    if (!tags?.includes("from-seed")) throw new Error(`tags: ${JSON.stringify(tags)}`);
  });
  await browser.storage.local.set({ linkTags: { [SEED_KEY]: ["from-seed", "from-join"] } });
  await check("its own change is sent", async () => {
    await until(async () => (await pendingOps()) > 0, 10e3, "the change to be recorded");
    const r = await syncNow();
    if (!r.ok || !r.pushed) throw new Error(JSON.stringify(r));
  });
  await check("the agents' sync status names this device", async () => {
    const s = await agentRequest("sync", {});
    if (s.device !== "mac-b" || !s.enabled || s.error) throw new Error(JSON.stringify(s));
  });
}

if (ROLE === "rejoin") {
  await check("another fresh profile holds both Macs' changes", async () => {
    const r = await syncNow();
    if (!r.ok) throw new Error(JSON.stringify(r));
    const tags = (await store("linkTags") || {})[SEED_KEY] || [];
    if (!(tags.includes("from-seed") && tags.includes("from-join"))) throw new Error(`tags: ${JSON.stringify(tags)}`);
  });
}
