#!/usr/bin/env node
// DESC: Check extension/link-search.js: every word must match, a title beats body text, nothing the old substring filter found is lost.
//
// Usage: node tools/test-link-search.mjs

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../extension/link-search.js", import.meta.url), "utf8"), ctx);
const { rank } = ctx.LinkSearch;

const fieldsOf = l => ({ title: l.title, url: l.url, tags: l.tags, note: l.note, text: l.text, links: l.links });
const L = (url, title, text, extra = {}) => ({ url, title, text, tags: [], ...extra });
const links = [
  L("https://a.example/1", "Swimming the Bosporus", "an open-water race across the strait"),
  L("https://b.example/2", "Kitchen shelves", "we were typing notes about local-first sync engines and swimming pools"),
  L("https://c.example/3", "Local-first sync", "conflict-free replicated data types for notes"),
  L("https://github.com/acme/typescript-tools", "", "a toolbox", { tags: ["dev"] }),
  L("https://d.example/4", "Unrelated", "nothing to see", { note: "bookmarked for the garden" }),
];
const urls = q => Array.from(rank(links, q, fieldsOf), r => r.link.url);

// every word must match, in any order and any place
assert.deepEqual(urls("sync notes").sort(), ["https://b.example/2", "https://c.example/3"]);
assert.deepEqual(urls("notes sync").sort(), urls("sync notes").sort());
assert.deepEqual(urls("sync garden"), []);

// a stem matches its inflections
assert.ok(urls("swim").includes("https://a.example/1"), "a prefix reaches the whole word");
assert.deepEqual(urls("swimming").slice(0, 2), ["https://a.example/1", "https://b.example/2"], "a title hit outranks a body hit");

// the old filter was one substring: whatever it found is still found
assert.ok(urls("script-tools").includes("https://github.com/acme/typescript-tools"));
assert.ok(urls("typescript").includes("https://github.com/acme/typescript-tools"));
assert.ok(urls("acme/typescript").includes("https://github.com/acme/typescript-tools"));
assert.ok(urls("garden").includes("https://d.example/4"), "a note is searched");
assert.ok(urls("dev").includes("https://github.com/acme/typescript-tools"), "a tag is searched");

// the best match comes first and the empty query keeps everything in order
assert.equal(urls("local first sync")[0], "https://c.example/3");
assert.deepEqual(urls(""), links.map(l => l.url));
assert.deepEqual(urls("zzzz"), []);

// editing a link changes what it matches
links[4].note = "pasta recipes";
assert.deepEqual(urls("garden"), []);
assert.ok(urls("pasta").includes("https://d.example/4"));

console.log("link-search: ok");
