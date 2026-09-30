/* Reads stashes out of whatever was pasted or dropped on the Stashed tabs page, and says which
 * format it took it for. Pure: text in, { format, stashes, skipped } out (plus records, for capture
 * JSONL, which goes to the reading list rather than into stashes), where a stash is
 * { name?, created_at?, tabs: [{ url, title?, container?, verdict?, seen_at? }] }. The background
 * checks every URL again before writing anything.
 *
 * Formats, tried in this order:
 *   link-keeper — this page's own Export: { sessions: [...] }
 *   tidytab     — TidyTab's export: { data: { tabGroups: [{ name, timestamp, tabs: [{ url, title }] }] } }
 *   json        — a JSON list of URLs, or of objects with a url
 *   captures    — capture JSONL: one JSON object with a url per line (the list's own export,
 *                 importers/enrich-x.py); these merge into the reading list
 *   csv         — a header row naming a url column; optional title, stash/group and date columns
 *   onetab      — OneTab's Export URLs: "url | title" per line, a blank line between groups
 *   text        — anything else: every URL found in it, as one stash
 */

const URL_START = /^(https?|ftp|file|about|moz-extension|chrome|view-source):/i;
const URLS_IN_TEXT = /\b(?:https?|ftp|file|moz-extension):\/\/[^\s<>"'`]+|\babout:[a-z-]+\b/gi;

function parseStashImport(text) {
  const raw = String(text || "").replace(/^﻿/, "").trim();
  if (!raw) return { format: null, stashes: [], skipped: 0 };
  let json;
  try { json = JSON.parse(raw); } catch (e) { json = undefined; }
  if (json !== undefined) {
    if (Array.isArray(json?.sessions)) return fromLinkKeeper(json);
    if (Array.isArray(json?.data?.tabGroups)) return fromTidyTab(json);
    if (Array.isArray(json)) return fromJsonList(json);
  }
  const lines = raw.split(/\r?\n/);
  const captures = fromJsonl(raw);
  if (captures) return captures;
  if (csvHeader(lines[0])) return fromCsv(lines);
  const filled = lines.filter(l => l.trim());
  if (filled.filter(l => URL_START.test(l.trim())).length >= filled.length * 0.6) return fromOneTab(lines);
  return fromText(raw);
}

const tabOf = (url, title) => ({ url: String(url).trim(), ...(title && String(title).trim() && { title: String(title).trim() }) });
const dateOf = v => {
  if (v == null || v === "") return undefined;
  const d = /^\d{10,13}$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function fromLinkKeeper(json) {
  let skipped = 0;
  const stashes = json.sessions.map(s => {
    const tabs = (s.tabs || []).filter(t => {
      const ok = typeof t?.url === "string";
      if (!ok) skipped++;
      return ok;
    }).map(t => ({ ...tabOf(t.url, t.title), ...(t.container && { container: t.container }),
      ...(t.verdict && { verdict: t.verdict }), ...(t.seen_at && { seen_at: t.seen_at }) }));
    return { name: s.name, created_at: dateOf(s.created_at), tabs };
  });
  return { format: "link-keeper", stashes, skipped };
}

function fromTidyTab(json) {
  let skipped = 0;
  const stashes = json.data.tabGroups.map(g => {
    const tabs = (g.tabs || []).filter(t => {
      const ok = typeof t?.url === "string";
      if (!ok) skipped++;
      return ok;
    }).map(t => tabOf(t.url, t.title));
    return { name: g.name || undefined, created_at: dateOf(g.timestamp) || dateOf(g.dateAdded), tabs };
  });
  return { format: "tidytab", stashes, skipped };
}

function fromJsonList(list) {
  let skipped = 0;
  const tabs = [];
  for (const v of list) {
    if (typeof v === "string") tabs.push(tabOf(v));
    else if (typeof v?.url === "string") tabs.push(tabOf(v.url, v.title));
    else skipped++;
  }
  return { format: "json", stashes: [{ tabs }], skipped };
}

/* Capture JSONL when most lines are JSON objects with a url. split("\n") only: U+2028 appears raw
 * inside tweet text and would tear a record in two. */
function fromJsonl(raw) {
  const filled = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (!filled.length || !filled[0].startsWith("{")) return null;
  const records = [];
  let skipped = 0;
  for (const line of filled) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { rec = null; }
    if (rec && typeof rec === "object" && !Array.isArray(rec) && typeof rec.url === "string") records.push(rec);
    else skipped++;
  }
  return records.length && records.length >= filled.length * 0.6 ? { format: "captures", stashes: [], records, skipped } : null;
}

/* RFC 4180-ish: quoted fields may hold the separator, doubled quotes and newlines. */
function splitCsv(text, sep) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

const COLUMNS = {
  url: /^(url|link|href|address)$/i,
  title: /^(title|name|page)$/i,
  stash: /^(stash|group|folder|session|tab ?group|collection)$/i,
  date: /^(date|created|created_at|saved|saved_at|timestamp|added|date ?added)$/i,
};

function csvHeader(line = "") {
  for (const sep of [",", ";", "\t"]) {
    const cells = line.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
    if (cells.length > 1 && cells.some(c => COLUMNS.url.test(c))) return sep;
  }
  return null;
}

function fromCsv(lines) {
  const sep = csvHeader(lines[0]);
  const [head, ...rows] = splitCsv(lines.join("\n"), sep);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, re]) => [k, head.findIndex(h => re.test(h.trim()))]));
  const groups = new Map();
  let skipped = 0;
  for (const r of rows) {
    const url = (r[col.url] || "").trim();
    if (!URL_START.test(url)) { skipped++; continue; }
    const key = col.stash >= 0 ? (r[col.stash] || "").trim() : "";
    if (!groups.has(key)) groups.set(key, { name: key || undefined, created_at: undefined, tabs: [] });
    const g = groups.get(key);
    g.tabs.push(tabOf(url, col.title >= 0 ? r[col.title] : ""));
    const when = col.date >= 0 ? dateOf((r[col.date] || "").trim()) : undefined;
    if (when && (!g.created_at || when < g.created_at)) g.created_at = when;
  }
  return { format: "csv", stashes: [...groups.values()], skipped };
}

function fromOneTab(lines) {
  const stashes = [];
  let cur = null, skipped = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l) { cur = null; continue; }
    const cut = l.indexOf(" | ");
    const url = cut < 0 ? l : l.slice(0, cut);
    if (!URL_START.test(url)) { skipped++; continue; }
    if (!cur) stashes.push(cur = { tabs: [] });
    cur.tabs.push(tabOf(url, cut < 0 ? "" : l.slice(cut + 3)));
  }
  return { format: "onetab", stashes, skipped };
}

function fromText(raw) {
  const urls = [...new Set((raw.match(URLS_IN_TEXT) || []).map(u => u.replace(/[.,;:!?)\]}>]+$/, "")))];
  return { format: "text", stashes: urls.length ? [{ tabs: urls.map(u => tabOf(u)) }] : [], skipped: 0 };
}
