#!/usr/bin/env node
// DESC: Check that the Stashed tabs page reads every import format it claims to.
//
// Loads extension/stash-import.js into a VM and feeds it Link Keeper's own export, TidyTab's
// export, a JSON list, CSV (with quotes, groups and dates), OneTab's Export URLs text and freeform
// text, checking the format it names and the stashes it reads.
//
// Usage: node tools/test-stash-import.mjs

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Check that the Stashed tabs page reads every import format it claims to.\nUsage: node tools/test-stash-import.mjs");
  process.exit(0);
}

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../extension/stash-import.js", import.meta.url), "utf8"), ctx);
const parse = text => JSON.parse(JSON.stringify(ctx.parseStashImport(text)));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok   ${name}`);
}

check("Link Keeper's own export round-trips, marks included", () => {
  const r = parse(JSON.stringify({ exported_at: "x", sessions: [
    { id: "bm1", name: "Research", created_at: "2026-09-28T10:00:00.000Z", tabs: [
      { id: "bm2", url: "https://a.example/", title: "A", container: "firefox-container-2", verdict: "keep", seen_at: "2026-09-28T11:00:00Z" },
      { url: 5 }] }] }));
  assert.equal(r.format, "link-keeper");
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.stashes, [{ name: "Research", created_at: "2026-09-28T10:00:00.000Z", tabs: [
    { url: "https://a.example/", title: "A", container: "firefox-container-2", verdict: "keep", seen_at: "2026-09-28T11:00:00Z" }] }]);
});

check("TidyTab's export: group names and millisecond timestamps", () => {
  const r = parse(JSON.stringify({ version: "3.0.0", data: { tabGroups: [
    { id: "7", name: "", timestamp: "1580000000000", tabs: [{ url: "https://t.example/", title: "T", dateAdded: 1 }] },
    { id: "8", name: "Named", timestamp: "2020-02-02T00:00:00Z", tabs: [{ title: "no url" }] }] } }));
  assert.equal(r.format, "tidytab");
  assert.equal(r.stashes[0].created_at, new Date(1580000000000).toISOString());
  assert.equal(r.stashes[0].name, undefined);
  assert.deepEqual(r.stashes[0].tabs, [{ url: "https://t.example/", title: "T" }]);
  assert.equal(r.stashes[1].name, "Named");
  assert.equal(r.skipped, 1);
});

check("a JSON list of URLs or of objects", () => {
  const r = parse(JSON.stringify(["https://1.example/", { url: "https://2.example/", title: "Two" }, 3]));
  assert.equal(r.format, "json");
  assert.deepEqual(r.stashes[0].tabs, [{ url: "https://1.example/" }, { url: "https://2.example/", title: "Two" }]);
  assert.equal(r.skipped, 1);
});

check("CSV: quoted commas and newlines, groups in order of appearance, earliest date per group", () => {
  const r = parse([
    "Title,URL,Group,Date",
    '"Hello, world",https://h.example/,Reading,2026-01-05',
    'Plain,https://p.example/,Work,2026-01-01',
    '"Two\nlines",https://t.example/,Reading,2026-01-02',
    'Bad,not a url,Work,',
  ].join("\n"));
  assert.equal(r.format, "csv");
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.stashes.map(s => s.name), ["Reading", "Work"]);
  assert.deepEqual(r.stashes[0].tabs, [{ url: "https://h.example/", title: "Hello, world" }, { url: "https://t.example/", title: "Two\nlines" }]);
  assert.equal(r.stashes[0].created_at, "2026-01-02T00:00:00.000Z");
});

check("CSV with semicolons and only a url column is one stash", () => {
  const r = parse("url;note\nhttps://a.example/;x\nhttps://b.example/;y\n");
  assert.equal(r.format, "csv");
  assert.equal(r.stashes.length, 1);
  assert.equal(r.stashes[0].tabs.length, 2);
});

check("OneTab's Export URLs: 'url | title', a blank line between groups, bare URLs too", () => {
  const r = parse([
    "https://a.example/x | A | with a bar",
    "https://b.example/ 2024-03-05",
    "",
    "",
    "file:///Users/me/doc.pdf | Doc",
    "about:config | about:config",
  ].join("\n"));
  assert.equal(r.format, "onetab");
  assert.deepEqual(r.stashes, [
    { tabs: [{ url: "https://a.example/x", title: "A | with a bar" }, { url: "https://b.example/" }] },
    { tabs: [{ url: "file:///Users/me/doc.pdf", title: "Doc" }, { url: "about:config", title: "about:config" }] },
  ]);
});

check("freeform text: every URL in it, once, without trailing punctuation", () => {
  const r = parse("Read https://a.example/post, then (https://b.example/q?x=1). Also https://a.example/post again.\nand about:preferences");
  assert.equal(r.format, "text");
  assert.deepEqual(r.stashes[0].tabs.map(t => t.url), ["https://a.example/post", "https://b.example/q?x=1", "about:preferences"]);
});

check("capture JSONL goes to the reading list, a bad line skipped, U+2028 inside text kept", () => {
  const r = parse([
    JSON.stringify({ url: "https://x.com/a/status/1", text: "one\u2028two" }),
    "{not json",
    JSON.stringify({ url: "https://b.example/", title: "B" }),
  ].join("\n"));
  assert.equal(r.format, "captures");
  assert.deepEqual(r.stashes, []);
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].text, "one\u2028two");
  assert.equal(r.skipped, 1);
});

check("empty or URL-less input reads as nothing", () => {
  assert.deepEqual(parse("   ").stashes, []);
  assert.deepEqual(parse("no links here at all").stashes, []);
});

console.log(`\n${passed} checks passed`);
