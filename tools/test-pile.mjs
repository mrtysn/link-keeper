#!/usr/bin/env node
// DESC: Check `link-keeper pile`, `drop` and the drop-list filters against a made-up backup and made-up import files.
/* Everything is fake: a temporary backup folder stands in for the add-on's data (no bridge socket, so the
 * CLI reads the backup), and a temporary DATA_DIR holds import files of invented links. Nothing reaches
 * Firefox, the owner's data or the network.
 *
 * Usage: node tools/test-pile.mjs */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lk-pile-"));
const data = path.join(work, "data");
const backups = path.join(work, "backups");
const dropFile = path.join(work, "drops", "drops.jsonl");
fs.mkdirSync(data); fs.mkdirSync(backups);
const env = { ...process.env, LINK_KEEPER_BACKUP_DIR: backups, LINK_KEEPER_STATE_DIR: path.join(work, "state"), DATA_DIR: data, DROP_LIST: dropFile };

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", `${name}: ${e.message}`); }
}
function assert(cond, why) { if (!cond) throw new Error(why); }

const LINKS = vm.createContext({ URL, console });
vm.runInContext(fs.readFileSync(path.join(REPO, "extension/links.js"), "utf8"), LINKS);
const keyOf = u => LINKS.keyOf(u);
const jsonl = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";

/* --- what link-keeper holds ---------------------------------------------------------------- */

const HELD = "https://held.example/post";
const HELD_REEL = "https://www.instagram.com/reel/AAA111/";
const HELD_FILTERED = "https://filtered.example/x";
const storage = {
  items: [
    { url: HELD, status: "pending", added_at: "2026-10-01T10:00:00Z", saved_at: "2026-10-01" },
    { url: HELD_REEL, status: "pending", added_at: "2026-10-02T10:00:00Z", saved_at: "2026-10-02" },
    { url: HELD_FILTERED, status: "pending", added_at: "2026-10-03T10:00:00Z", saved_at: "2026-10-03" },
  ],
  captures: [{ url: HELD, title: "Held title", text: "held text of the page, long enough to count as a read page", links: ["https://github.com/a/held-repo", HELD], captured_at: "2026-10-01T11:00:00Z" }],
  linkTags: { [keyOf(HELD)]: ["ai", "dev"], [keyOf(HELD_FILTERED)]: ["filtered-out"] },
  tagSuggestions: { [keyOf(HELD_REEL)]: { at: "2026-10-05T00:00:00Z", tags: [{ tag: "video", p: 0.8, by: "gutsy" }] } },
  agentTags: {},
};
fs.writeFileSync(path.join(backups, "latest.json"), JSON.stringify({ format: "link-keeper-backup", format_version: 1, extension_version: "test", at: "2026-11-01T00:00:00Z", storage, sessions: [] }));

/* --- what the import found ------------------------------------------------------------------ */

const REEL_B = "https://instagram.com/someone/reel/AAA111/?igsh=zzz";     // the held reel, another spelling
const NEW_REEL = "https://www.instagram.com/reel/NEW222/";
const YT_A = "https://www.youtube.com/watch?v=abcdefghijk&t=5";
const YT_B = "https://youtu.be/abcdefghijk";
const PAGE = "https://fresh.example/article#section";
const PAGE_PLAIN = "https://fresh.example/article";
const DROPPED = "https://dropped.example/a";
const TWEET_I = "https://x.com/i/status/777";
const TWEET_H = "https://x.com/someone/status/777";
fs.writeFileSync(path.join(data, "link-captures-ig.jsonl"), jsonl([
  { url: REEL_B, saved_at: "2026-09-01T10:00:00Z", thread: ["friend_123456"], senders: ["Friend"], account: "main", kind: "reel", title: "A reel", text: "reel caption" },
  { url: NEW_REEL, saved_at: "2026-09-05T10:00:00Z", thread: ["friend_123456"], senders: ["Friend"], account: "main", kind: "reel", title: "New reel", author: { handle: "@reeler" }, text: "new reel caption" },
  { url: YT_A, saved_at: "2026-09-06T10:00:00Z", thread: ["pals_999999"], senders: ["Pal"], account: "main" },
]));
fs.writeFileSync(path.join(data, "link-captures-xdm.jsonl"), jsonl([
  { url: TWEET_I, saved_at: "2026-09-07T10:00:00Z", thread: ["me"], senders: ["me"], account: "side" },
]));
fs.writeFileSync(path.join(data, "link-inbox.tsv"), [`${YT_B}\t2026-08-01`, `${PAGE}\t2026-08-02`, `${DROPPED}\t2026-08-03`, `${HELD}\t2026-08-04`, "not a link\t2026-08-05"].join("\n") + "\n");
fs.writeFileSync(path.join(data, "link-captures-all.jsonl"), jsonl([
  { url: PAGE_PLAIN, title: "Fresh article", text: "x".repeat(5000), author: { handle: "@writer" }, links: [{ resolved: "https://github.com/a/inner" }, "https://github.com/a/inner", PAGE_PLAIN] },
  { url: TWEET_H, kind: "tweet", text: "a tweet text", author: { handle: "@someone" }, quoted: { text: "quoted words" }, status_id: "777" },
  { url: NEW_REEL, title: "New reel", text: "from the capture file" },
  { url: "https://nothing.example/", title: "" },
]));
const telegram = path.join(work, "result.json");
fs.writeFileSync(telegram, JSON.stringify({ name: "Saved Messages", type: "saved_messages", messages: [
  { id: 1, date: "2026-07-01T10:00:00", text: ["look ", { type: "link", text: "https://tg.example/one" }], text_entities: [{ type: "link", text: "https://tg.example/one" }] },
  { id: 2, date: "2026-07-02T10:00:00", text: [{ type: "link", text: "bare.sh" }], text_entities: [{ type: "link", text: "bare.sh" }] },
] }));

const cli = (args, extra = {}) => {
  const r = spawnSync("node", [path.join(REPO, "tools/link-keeper.mjs"), ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const pile = (...more) => {
  const r = cli(["pile", "--json", ...more]);
  assert(r.code === 0, r.err);
  return JSON.parse(r.out);
};
const byUrl = (p, url) => p.links.find(l => l.key === keyOf(url));

/* --- checks ---------------------------------------------------------------------------------- */

await check("a held link is held, with its tags, its own capture and no filtered-out tag", () => {
  const p = pile();
  const l = byUrl(p, HELD);
  assert(l.held === true && l.url === HELD, JSON.stringify(l));
  assert(JSON.stringify(l.tags) === '["ai","dev"]', JSON.stringify(l.tags));
  assert(l.capture.title === "Held title" && l.capture.text.startsWith("held text of the page"), JSON.stringify(l.capture));
  assert(JSON.stringify(l.capture.links) === '["https://github.com/a/held-repo"]', `inner links ${JSON.stringify(l.capture.links)}`);
  const f = byUrl(p, HELD_FILTERED);
  assert(f.filteredOut === true && f.tags.length === 0, JSON.stringify(f));
  assert(byUrl(p, HELD).filteredOut === false, "a link that is not filtered out says so");
});

await check("suggestions come with their tag, p and source", () => {
  const l = byUrl(pile(), HELD_REEL);
  assert(JSON.stringify(l.suggested) === '[{"tag":"video","p":0.8,"by":"gutsy"}]', JSON.stringify(l.suggested));
  assert(byUrl(pile(), HELD).suggested.length === 0, "a link with no suggestions has an empty list");
});

await check("every spelling of one link is one entry, held when link-keeper holds any spelling", () => {
  const p = pile();
  assert(keyOf(REEL_B) === keyOf(HELD_REEL), "the test spellings are not one key");
  assert(p.links.filter(l => l.key === keyOf(HELD_REEL)).length === 1, "the reel is listed twice");
  const reel = byUrl(p, HELD_REEL);
  assert(reel.held && reel.url === HELD_REEL, "the held reel keeps the held spelling");
  assert(reel.origins.length === 1 && reel.origins[0].source === "instagram" && reel.origins[0].thread[0] === "friend", JSON.stringify(reel.origins));
  assert(p.links.filter(l => l.key === keyOf(YT_A)).length === 1, "the video is listed twice");
  const yt = byUrl(p, YT_A);
  assert(JSON.stringify(yt.origins.map(o => o.source).sort()) === '["instagram","phone"]', JSON.stringify(yt.origins));
  assert(yt.date === "2026-08-01", `the earliest date wins (${yt.date})`);
});

await check("a fragment that is a plain anchor does not make a second link", () => {
  const p = pile();
  assert(p.links.filter(l => l.key === keyOf(PAGE_PLAIN)).length === 1, "two entries");
});

await check("a link the import found and link-keeper does not hold is not held, with origin and capture", () => {
  const l = byUrl(pile(), NEW_REEL);
  assert(l.held === false && l.heldIn === undefined, JSON.stringify(l));
  assert(l.origins[0].accounts[0] === "main" && l.origins[0].senders[0] === "Friend", JSON.stringify(l.origins));
  assert(l.capture.text === "from the capture file" || l.capture.text === "new reel caption", JSON.stringify(l.capture));
  assert(l.title === "New reel", l.title);
});

await check("a capture keeps its inner links without duplicates or the link itself, and clips its text", () => {
  const l = byUrl(pile(), PAGE);
  assert(JSON.stringify(l.capture.links) === '["https://github.com/a/inner"]', JSON.stringify(l.capture.links));
  assert(l.capture.text.length === 3000, `text ${l.capture.text.length}`);
  assert(l.capture.author === "@writer", l.capture.author);
});

await check("an X status joins its capture whichever address it was saved under", () => {
  const l = byUrl(pile(), TWEET_I);
  assert(l.key === "status:777" && l.capture.text === "a tweet text" && l.capture.quote === "quoted words", JSON.stringify(l));
});

await check("keys maps urls on stdin to link keys", () => {
  const r = spawnSync("node", [path.join(REPO, "tools/link-keeper.mjs"), "keys", "--json"], { env, input: `${YT_A}\n${REEL_B}\n\n`, encoding: "utf8" });
  assert(r.status === 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert(got[YT_A] === "yt:abcdefghijk" && got[REEL_B] === "ig:AAA111", r.stdout);
  const plain = spawnSync("node", [path.join(REPO, "tools/link-keeper.mjs"), "keys"], { env, input: `${PAGE}\n`, encoding: "utf8" });
  assert(plain.stdout === `${PAGE}\t${keyOf(PAGE)}\n`, plain.stdout);
});

await check("a link with no capture has capture null", () => {
  assert(byUrl(pile(), YT_A).capture === null, "expected null");
});

await check("the phone inbox's own copy of a held link adds its origin", () => {
  const l = byUrl(pile(), HELD);
  assert(l.held && l.origins.some(o => o.source === "phone"), JSON.stringify(l.origins));
});

await check("a Telegram export joins the pile on request, and its bare entries are listed apart", () => {
  const p = pile("--telegram", telegram);
  const l = byUrl(p, "https://tg.example/one");
  assert(l.held === false && l.origins[0].source === "telegram" && l.origins[0].thread[0] === "Saved Messages" && l.context === "look", JSON.stringify(l));
  assert(p.schemeless.length === 1 && p.schemeless[0].url === "bare.sh", JSON.stringify(p.schemeless));
  assert(!byUrl(pile(), "https://tg.example/one"), "an export nobody named was read");
});

await check("counts add up and the list is newest first", () => {
  const p = pile();
  assert(p.total === p.links.length && p.held + p.unheld === p.total, JSON.stringify([p.total, p.held, p.unheld]));
  const dates = p.links.map(l => l.date || "");
  assert(dates.every((d, i) => i === 0 || dates[i - 1] >= d), "not newest first");
  assert(p.held === 3, `held ${p.held}`);
});

await check("drop puts links on the list; dropping again adds nothing; a dry run changes nothing", () => {
  let r = cli(["drop", DROPPED, "--dry-run"]);
  assert(r.code === 0 && /would drop 1/.test(r.out) && !fs.existsSync(dropFile), r.out + r.err);
  r = cli(["drop", DROPPED, "https://dropped.example/a/"]);
  assert(r.code === 0 && /1 dropped, 1 already/.test(r.out), r.out + r.err);
  r = cli(["drop", DROPPED]);
  assert(/0 dropped, 1 already/.test(r.out), r.out);
  const lines = fs.readFileSync(dropFile, "utf8").trim().split("\n");
  assert(lines.length === 1 && JSON.parse(lines[0]).key === keyOf(DROPPED), lines.join("|"));
  assert(JSON.parse(cli(["drops", "--json"]).out).drops.length === 1, "drops lists it");
});

await check("a dropped link the import found is left out of the pile, and counted", () => {
  const p = pile();
  assert(!byUrl(p, DROPPED) && p.dropped === 1, `dropped ${p.dropped}`);
});

await check("dropping a link link-keeper holds does not hide it", () => {
  cli(["drop", HELD]);
  assert(byUrl(pile(), HELD)?.held === true, "a held link was hidden");
});

await check("the import's worklist and handover lose dropped links and keep the rest", () => {
  const lines = [`${DROPPED}\t2026-08-03`, `${PAGE}\t2026-08-02`, "", `${DROPPED}/\t2026-08-04`].join("\n");
  const r = spawnSync("node", [path.join(REPO, "tools/drop-list.mjs"), "filter-lines", "--drops", dropFile], { input: lines, encoding: "utf8" });
  assert(r.status === 0 && r.stdout === `${PAGE}\t2026-08-02\n`, JSON.stringify(r.stdout));
  const handoff = path.join(work, "handoff.json");
  fs.writeFileSync(handoff, JSON.stringify({ captures: [{ url: DROPPED }, { url: PAGE }, { url: "https://other.example/", source_url: DROPPED }], queue: [{ url: DROPPED }, { url: NEW_REEL }] }));
  const out = execFileSync("node", [path.join(REPO, "tools/drop-list.mjs"), "filter-handoff", "--drops", dropFile, handoff], { encoding: "utf8" });
  const got = JSON.parse(fs.readFileSync(handoff, "utf8"));
  assert(got.captures.length === 1 && got.captures[0].url === PAGE && got.queue.length === 1 && got.queue[0].url === NEW_REEL, JSON.stringify(got));
  assert(/2 captures and 1 queued/.test(out), out);
});

await check("with no drop list there is nothing to filter", () => {
  const r = spawnSync("node", [path.join(REPO, "tools/drop-list.mjs"), "filter-lines", "--drops", path.join(work, "none.jsonl")], { input: `${DROPPED}\t1\n`, encoding: "utf8" });
  assert(r.stdout === `${DROPPED}\t1\n`, JSON.stringify(r.stdout));
});

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall pile checks passed");
process.exit(failed ? 1 : 0);
