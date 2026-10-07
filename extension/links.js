/* Every source of links as one dataset — the stashes made from open tabs, the stashes brought in by
 * an import, and the reading list with its captures — so that any page can show any mix of them.
 *
 * Pure: loaded ahead of background.js (which owns storage and calls joinLinks with what it read),
 * and by the page previews and tests, which call it with made-up data.
 *
 * A link is one URL, however many places hold it:
 *   { key, url, title, sources: ["tabs" | "import" | "list"], list, cap, copies, verdict, seen, date,
 *     tags, kinds, guessed }
 *   list    — its reading-list entry { status, added_at, saved_at, note, current, loose }, or null
 *   cap     — what was read off the page, or null
 *   copies  — one per stash that holds it: { stash, tab, seen_at, verdict, judged_at, container }
 *   verdict — "keep", "drop" or null, the same across every copy (see judgeLink in background.js)
 *   seen    — opened, restored or read at some point
 *   date    — when it was set aside: saved, added to the list, or stashed, whichever is known
 *   tags    — the tags set by hand, or [] (stored in linkTags, keyed like the link)
 *   kinds   — what kind of thing it is, read off its site or capture ("code", "video", …); never stored
 *   guessed — kinds while tags is empty, else []: what the pages show dimmed in place of tags
 */

const LINK_SOURCES = ["tabs", "import", "list"];

/* Same normalisation on both sides of a comparison: x.com/i/status/<id> and
 * x.com/<handle>/status/<id> are the same post, and a trailing slash is never meaningful. */
function keyOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const status = u.pathname.match(/\/status\/(\d+)/);
    if (/^(x|twitter)\.com$/.test(host) && status) return `status:${status[1]}`;
    return host + u.pathname.replace(/\/$/, "") + u.search;
  } catch (e) {
    return String(url);
  }
}

/* X's API dates ("Wed Sep 09 14:06:01 +0000 2026") neither sort nor slice like ISO strings, and
 * Date.parse is not required to read them, so that shape is converted by hand. */
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function isoDate(value) {
  if (!value) return null;
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/.exec(value);
  const text = m && MONTHS[m[1]]
    ? `${m[6]}-${String(MONTHS[m[1]]).padStart(2, "0")}-${m[2]}T${m[3]}${m[4]}:${m[5]}`
    : value;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* A tag as stored: lowercase, single spaces, at most 40 characters. */
const cleanTag = t => String(t || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);

/* What kind of thing a link is, read off its site or its capture — dimmed in the pages, never
 * saved. A tag set by hand replaces these. */
const SITE_KINDS = [
  [/(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|sourcehut\.org)$/, "code"],
  [/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv)$/, "video"],
  [/(^|\.)(x\.com|twitter\.com|bsky\.app|threads\.net|mastodon\.social|instagram\.com)$/, "post"],
  [/(^|\.)(reddit\.com|news\.ycombinator\.com|lobste\.rs)$/, "discussion"],
  [/(^|\.)(store\.steampowered\.com|itch\.io|gog\.com)$/, "game"],
  [/(^|\.)(arxiv\.org|doi\.org|semanticscholar\.org)$/, "paper"],
  [/(^|\.)(docs\.google\.com|notion\.so)$/, "doc"],
];
function guessTags(url, cap) {
  if (/^file:/.test(url)) return ["local file"];
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return []; }
  const site = SITE_KINDS.find(([re]) => re.test(host));
  if (site) return [site[1]];
  if (cap?.kind === "article" || cap?.kind === "x-article") return ["article"];
  return [];
}

const hrefOf = l => (typeof l === "string" ? l : l?.resolved || l?.href) || null;

/* What the pages show of a capture. */
function capView(c, thumbs = {}) {
  return {
    title: c.title || null,
    handle: c.author?.handle || c.handle || null,
    name: c.author?.name || null,
    text: c.text || null,
    kind: c.kind || null,
    note: c.note || null,
    posted: c.posted || null,
    captured_at: c.captured_at || null,
    links: (c.links || []).map(hrefOf).filter(Boolean),
    reply_links: (c.reply_links || []).map(l => ({ href: hrefOf(l), from: l.from || null, self: !!l.self })).filter(l => l.href),
    images: c.images || [],
    screenshot: c.screenshot?.filename || null,
    shotThumb: thumbs[c.screenshot?.filename] || null,
    shotId: c.screenshot?.downloadId ?? null,
    code_blocks: (c.code_blocks || []).length,
    verdict: c.verdict || null,
  };
}

const LIST_VERDICT = { kept: "keep", skipped: "drop" };

/* items and captures as stored, sessions as getSessions gives them, currentKey the reading list's
 * current entry. Returns { links, stashes }, stashes in their own order with each tab's link key. */
function joinLinks({ items = [], captures = [], sessions = [], thumbs = {}, currentKey = null, tags = {} }) {
  const capBy = new Map();
  for (const c of captures) {
    if (c.source_url) capBy.set(keyOf(c.source_url), c);
  }
  for (const c of captures) capBy.set(keyOf(c.url), c);

  const byKey = new Map();
  const linkFor = (url, title) => {
    const key = keyOf(url);
    let link = byKey.get(key);
    if (!link) {
      const c = capBy.get(key);
      link = { key, url, title: null, sources: [], list: null, cap: c ? capView(c, thumbs) : null, copies: [] };
      byKey.set(key, link);
    }
    if (!link.title && title) link.title = title;
    return link;
  };
  const addSource = (link, s) => { if (!link.sources.includes(s)) link.sources.push(s); };

  for (const i of items) {
    const link = linkFor(i.url, i.title);
    link.url = i.url;   // the list's spelling is the one its own actions match on
    link.list = {
      status: i.status, added_at: i.added_at || null, saved_at: i.saved_at || null,
      note: i.note || link.cap?.note || null, current: currentKey === link.key, loose: false,
    };
    addSource(link, "list");
  }
  // Captures with no list entry — kept from a page you happened to be on — belong to the reading list too.
  const listed = new Set(items.map(i => keyOf(i.url)));
  for (const c of captures) {
    if (listed.has(keyOf(c.url))) continue;
    const link = linkFor(c.url, c.title);
    if (link.list) continue;
    // Captured, never queued: done with as a queue item, but not judged — keep is a separate press.
    link.list = { status: "seen", added_at: c.captured_at || null, saved_at: isoDate(c.posted), note: c.note || null, current: false, loose: true };
    addSource(link, "list");
  }

  const stashes = sessions.map(s => {
    const source = s.source === "import" ? "import" : "tabs";
    const tabs = s.tabs.map(t => {
      const link = linkFor(t.url, t.title);
      link.copies.push({ stash: s.id, tab: t.id, seen_at: t.seen_at || null, verdict: t.verdict || null, judged_at: t.judged_at || null, container: t.container || null });
      addSource(link, source);
      return { id: t.id, key: link.key, url: t.url, title: t.title || null, seen_at: t.seen_at || null, verdict: t.verdict || null, container: t.container || null };
    });
    return { id: s.id, name: s.name, created_at: s.created_at, locked: !!s.locked, starred: !!s.starred, source, format: s.format || null, tabs };
  });
  const stashAt = new Map(stashes.map(s => [s.id, s.created_at]));

  for (const link of byKey.values()) {
    // Newest judgement first: a capture's, then any stash copy's, then what the reading list says.
    const judged = link.copies.filter(c => c.verdict).sort((a, b) => String(b.judged_at).localeCompare(String(a.judged_at)));
    link.verdict = link.cap?.verdict || judged[0]?.verdict || LIST_VERDICT[link.list?.status] || null;
    link.seen = !!(link.cap || (link.list && link.list.status !== "pending") || link.copies.some(c => c.seen_at));
    const stashed = link.copies.map(c => stashAt.get(c.stash)).filter(Boolean).sort()[0] || null;
    link.date = link.list?.saved_at || link.list?.added_at || stashed;
    link.tags = (tags[link.key] || []).slice();
    link.kinds = guessTags(link.url, link.cap);
    link.guessed = link.tags.length ? [] : link.kinds;
  }
  return { links: [...byKey.values()], stashes };
}
