/* Every source of links as one dataset — the stashes made from open tabs, the stashes brought in by
 * an import, and the reading list with its captures — so that any page can show any mix of them.
 *
 * Pure: loaded ahead of background.js (which owns storage and calls joinLinks with what it read),
 * and by the page previews and tests, which call it with made-up data.
 *
 * A link is one URL, however many places hold it:
 *   { key, url, title, sources: ["tabs" | "import" | "list"], list, cap, copies, date,
 *     tags, kinds, guessed }
 *   list    — its reading-list entry { added_at, saved_at, note, current, loose }, or null
 *   cap     — what was read off the page, or null
 *   copies  — one per stash that holds it: { stash, tab, container }
 *   date    — when it was set aside: saved, added to the list, or stashed, whichever is known
 *   tags    — the tags set by hand, or [] (stored in linkTags, keyed like the link)
 *   suggested — a local model's stored suggestions [{ tag, p, by }], best first, while tags is empty, else []
 *               (stored in tagSuggestions, keyed like the link; by is "system-one", "gutsy" or "model";
 *               one tag may come from several sources, one entry each)
 *   agentTags — the tags a Claude agent wrote, [] when none; a layer of their own, apart from tags and
 *               suggested, and never counted as the owner's (stored in agentTags, keyed like the link)
 *   agentBy — the model that wrote them (e.g. "haiku"), else null
 *   kinds   — what kind of thing it is, read off its site or capture ("code", "video", …); never stored
 *   guessed — kinds while tags is empty, else []: what the pages show dimmed in place of tags
 */

const LINK_SOURCES = ["tabs", "import", "list"];

/* Same normalisation on both sides of a comparison: x.com/i/status/<id> and
 * x.com/<handle>/status/<id> are the same post, and a trailing slash is never meaningful. A
 * #fragment that is a route (it holds a "/": Gmail's #inbox/<message id>) names a page of its own and
 * stays; a plain anchor (#section) or a text fragment (#:~:text=) is the same page and goes. */
const routeFragment = hash => (/^#.*\//.test(hash) && !hash.startsWith("#:~:") ? hash : "");
function keyOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const status = u.pathname.match(/\/status\/(\d+)/);
    if (/^(x|twitter)\.com$/.test(host) && status) return `status:${status[1]}`;
    return host + u.pathname.replace(/\/$/, "") + u.search + routeFragment(u.hash);
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

/* The sources a suggestion may name; any other value is stored as "system-one". */
const SUGGESTION_SOURCES = ["system-one", "gutsy", "model"];

/* A link's stored suggestions, cleaned: tags named, p within 0..1, best first, one entry per tag
 * and source. */
function suggestionsFor(map, key) {
  const list = map?.[key]?.tags;
  if (!Array.isArray(list)) return [];
  const out = list.filter(s => s && cleanTag(s.tag))
    .map(s => ({ tag: cleanTag(s.tag), p: Math.min(1, Math.max(0, Number(s.p) || 0)), by: SUGGESTION_SOURCES.includes(s.by) ? s.by : "system-one" }))
    .sort((a, b) => b.p - a.p);
  return out.filter((s, i) => out.findIndex(o => o.tag === s.tag && o.by === s.by) === i);
}

/* A link's agent tags, cleaned: { tags, by }, each tag once. Empty tags and by null when it has none. */
function agentTagsFor(map, key) {
  const entry = map?.[key];
  const tags = Array.isArray(entry?.tags) ? [...new Set(entry.tags.map(cleanTag).filter(Boolean))] : [];
  return { tags, by: tags.length && entry.by ? String(entry.by) : null };
}

const hrefOf = l => (typeof l === "string" ? l : l?.resolved || l?.href) || null;

/* What the pages show of a capture. */
/* Whether a capture record holds anything read from the page. An importer that knows only where a
 * link was sent (importers/x-archive.py) writes a record with none: the link is not captured, and only
 * its origin is kept. */
const capHasContent = c => !!(c.text || c.title || c.images?.length || c.screenshot || c.links?.length || c.replies?.length || c.code_blocks?.length);

/* Where a DM link came from, when an importer recorded it, or null. */
function originOf(c) {
  const o = {
    account: Array.isArray(c?.account) ? c.account.join(", ") : c?.account || null,
    thread: Array.isArray(c?.thread) ? c.thread : [],
    senders: Array.isArray(c?.senders) ? c.senders : [],
  };
  return o.account || o.thread.length || o.senders.length ? o : null;
}

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
    reply_count: (c.replies || []).length,
    replies: c.replies || [],
    images: c.images || [],
    screenshot: c.screenshot?.filename || null,
    shotThumb: thumbs[c.screenshot?.filename] || null,
    shotId: c.screenshot?.downloadId ?? null,
    code_blocks: (c.code_blocks || []).length,
  };
}

/* items and captures as stored, sessions as getSessions gives them, currentKey the reading list's
 * current entry. Returns { links, stashes }, stashes in their own order with each tab's link key. */
function joinLinks({ items = [], captures = [], sessions = [], thumbs = {}, currentKey = null, tags = {}, suggestions = {}, agentTags = {}, previews = {} }) {
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
      link = { key, url, title: null, sources: [], list: null, cap: c && capHasContent(c) ? capView(c, thumbs) : null, origin: originOf(c), copies: [] };
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
      added_at: i.added_at || null, saved_at: i.saved_at || null,
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
    // saved_at is when an importer found it sent (a DM's date); posted, when the post was made.
    link.list = { added_at: c.captured_at || null, saved_at: isoDate(c.saved_at) || isoDate(c.posted), note: c.note || null, current: false, loose: true };
    addSource(link, "list");
  }

  const stashes = sessions.map(s => {
    const source = s.source === "import" ? "import" : "tabs";
    const tabs = s.tabs.map(t => {
      const link = linkFor(t.url, t.title);
      link.copies.push({ stash: s.id, tab: t.id, container: t.container || null });
      addSource(link, source);
      // A tab's own date (a chat message's sending): the link's date unless the list has one.
      if (t.saved_at && (!link.sentAt || t.saved_at < link.sentAt)) link.sentAt = t.saved_at;
      if (t.note && !link.note) link.note = t.note;
      return { id: t.id, key: link.key, url: t.url, title: t.title || null, container: t.container || null };
    });
    return { id: s.id, name: s.name, created_at: s.created_at, source, format: s.format || null, tabs };
  });
  const stashAt = new Map(stashes.map(s => [s.id, s.created_at]));

  for (const link of byKey.values()) {
    const stashed = link.copies.map(c => stashAt.get(c.stash)).filter(Boolean).sort()[0] || null;
    link.date = link.list?.saved_at || link.sentAt || link.list?.added_at || stashed;
    // A note written when it was added: on its list entry, or since 5.64 on its tab.
    link.note = link.list?.note || link.note || null;
    // Its preview, as a chat app shows under a link (background.js, previews): a picture and a line.
    const p = previews[link.key];
    // image is true when the picture is stored apart (background.js, PREVIEW_IMG); the page fills it in.
    link.preview = p && !p.none ? { title: p.title || null, text: p.text || null, image: p.image || null, at: p.at || null } : null;
    delete link.sentAt;
    link.tags = (tags[link.key] || []).slice();
    link.suggested = link.tags.length ? [] : suggestionsFor(suggestions, link.key);
    const agent = agentTagsFor(agentTags, link.key);
    link.agentTags = agent.tags;
    link.agentBy = agent.by;
    link.kinds = guessTags(link.url, link.cap);
    link.guessed = link.tags.length ? [] : link.kinds;
  }
  return { links: [...byKey.values()], stashes };
}
