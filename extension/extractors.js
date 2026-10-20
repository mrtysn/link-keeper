/* Per-site extractors, plus a generic fallback.
 *
 * Each entry declares the hosts it handles and returns whatever it can read from the DOM.
 * Every field is independently optional: a site redesign should cost one field, not the
 * whole capture, so nothing here throws on a missing node. The dispatcher in content.js
 * fills in url/source_url/captured_at and merges the generic result underneath the
 * site-specific one, so a broken handler still degrades to og: tags.
 *
 * Adding a site is one object in REGISTRY. Order matters only in that the first host
 * match wins.
 */

const LK = (() => {
  const txt = node => (node ? node.textContent.replace(/\s+/g, " ").trim() || null : null);

  /* Like txt() but keeps the rendered line structure. innerText respects block boundaries,
   * which is the difference between a readable article and one long unbroken line — and it
   * is the only way code blocks survive as code. */
  const blockText = node =>
    node ? node.innerText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null : null;
  const attr = (sel, name = "content") => document.querySelector(sel)?.getAttribute(name) || null;
  const meta = name =>
    attr(`meta[property="${name}"]`) || attr(`meta[name="${name}"]`);

  function jsonLd() {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent);
        for (const entry of [].concat(parsed["@graph"] || parsed)) {
          if (entry && typeof entry === "object") return entry;
        }
      } catch (e) { /* malformed ld+json is common; ignore it */ }
    }
    return {};
  }

  /* --- a page's own text -------------------------------------------------------------
   * For a page no site reader knows: the text of its main content, as it reads on screen, without the
   * menus, sidebars, footers and boxes around it. The main content is the page's <article> or <main>
   * when it marks one (the longest, and of equals the innermost, so <main> around an article gives the
   * article without the title above it), else the element holding most of its paragraphs. */
  const MAIN_MAX = 6000;
  const SKIP = "nav, header, footer, aside, form, button, script, style, noscript, template, svg, canvas, iframe, dialog, " +
    "[role=navigation], [role=banner], [role=contentinfo], [role=complementary], [aria-hidden=true], [hidden], " +
    ".infobox, .navbox, .sidebar, .toc, #toc, .mw-editsection, .reference, .references, sup.reference, .metadata, .ambox, " +
    ".share, .social, .related, .comments, #comments, .cookie, .newsletter, .advert, .ad";
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|LI|UL|OL|DL|DT|DD|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|FIGURE|FIGCAPTION|HR|BR|DETAILS|SUMMARY)$/;

  const shown = node => {
    const r = node.getBoundingClientRect?.();
    if (r && !r.width && !r.height && getComputedStyle(node).display !== "contents") return false;
    return getComputedStyle(node).visibility !== "hidden";
  };
  const paraLength = node => [...node.querySelectorAll("p")].reduce((n, p) => n + (p.textContent || "").trim().length, 0);

  function mainNode() {
    const marked = [...document.querySelectorAll('article, main, [role=main], #mw-content-text, .post-content, .entry-content, .article-body')]
      .filter(n => !n.closest(SKIP) && paraLength(n) > 200);
    if (marked.length) return marked.sort((a, b) => paraLength(b) - paraLength(a) || (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0];
    // Else the parent of the most paragraph text.
    const by = new Map();
    for (const p of document.querySelectorAll("p")) {
      if (p.closest(SKIP)) continue;
      const parent = p.parentElement;
      if (parent) by.set(parent, (by.get(parent) || 0) + (p.textContent || "").trim().length);
    }
    const best = [...by].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 200 ? best[0] : null;
  }

  /* Its text with paragraphs a blank line apart, list items and other blocks on their own lines (an item
   * marked "• "), and code as it is written, up to MAIN_MAX. Breaks are gathered as marks and settled at
   * the end, so nested blocks give one break, not a pile of them. */
  const PARA = /^(P|H[1-6]|PRE|BLOCKQUOTE|TABLE|FIGURE|UL|OL|DL|HR|SECTION|ARTICLE)$/;
  function readableText(root) {
    const LINE = "\u0001", GAP = "\u0002", KEEP = "\u0003";
    const out = [];
    let size = 0;
    const walk = node => {
      if (size > MAIN_MAX) return;
      if (node.nodeType === 3) { const t = node.nodeValue.replace(/\s+/g, " "); out.push(t); size += t.length; return; }
      if (node.nodeType !== 1 || node.matches(SKIP) || !shown(node)) return;
      const brk = PARA.test(node.tagName) ? GAP : BLOCK.test(node.tagName) ? LINE : "";
      if (node.tagName === "PRE") {
        const code = node.textContent.replace(/^\n+|\n+$/g, "");
        out.push(GAP, code.replace(/ /g, KEEP).replace(/\n/g, KEEP + "n"), GAP);
        size += code.length;
        return;
      }
      out.push(brk, node.tagName === "LI" ? "• " : "");
      for (const child of node.childNodes) walk(child);
      out.push(brk);
    };
    walk(root);
    const text = out.join("")
      .replace(/[ \u0001\u0002]*[\u0001\u0002][ \u0001\u0002]*/g, run => (run.includes(GAP) ? "\n\n" : "\n"))
      .replace(/ {2,}/g, " ").split("\n").map(l => l.trim()).join("\n")
      .replace(new RegExp(KEEP + "n", "g"), "\n").replace(new RegExp(KEEP, "g"), " ").trim();
    return text ? text.slice(0, MAIN_MAX) : null;
  }

  /* Its links to other sites, in page order, once each. */
  function mainLinks(root) {
    const seen = new Set();
    return [...root.querySelectorAll('a[href^="http"]')]
      .filter(a => !a.closest(SKIP) && new URL(a.href).hostname !== location.hostname && !seen.has(a.href) && seen.add(a.href))
      .slice(0, 12)
      .map(a => ({ href: a.href, display: txt(a), resolved: a.href }));
  }

  /* --- generic ------------------------------------------------------------------ */

  function generic() {
    const ld = jsonLd();
    return {
      kind: "page",
      title: meta("og:title") || txt(document.querySelector("h1")) || document.title || null,
      text: meta("og:description") || meta("description") || ld.description || null,
      author:
        { name: meta("author") || meta("article:author") || ld.author?.name || null, handle: null },
      posted: meta("article:published_time") || ld.datePublished || attr("time[datetime]", "datetime"),
      site: meta("og:site_name") || location.hostname,
      canonical: attr('link[rel="canonical"]', "href"),
      images: [meta("og:image")].filter(Boolean),
    };
  }

  /* --- x.com ------------------------------------------------------------------- */

  const statusId = url => (String(url).match(/\/status\/(\d+)/) || [])[1] || null;

  function primaryArticle() {
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    if (!articles.length) return null;
    const id = statusId(location.pathname);
    for (const art of articles) {
      const link = art.querySelector('a[href*="/status/"] time')?.closest("a");
      if (link && statusId(link.getAttribute("href")) === id) return art;
    }
    return articles[0];
  }

  function tweetLinks(article) {
    const out = [];
    const seen = new Set();
    const collect = root => {
      if (!root) return;
      for (const a of root.querySelectorAll("a[href]")) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        // Drop in-app navigation. Beyond mentions, hashtags and the permalink, article images
        // are wrapped in links to x.com's own media viewer — those are pictures, not
        // destinations, and belong in `images` rather than inflating the link count.
        if (/^https?:\/\/(x|twitter)\.com\/(hashtag\/|i\/|[^/]+$|[^/]+\/(status|article|photo)\/)/.test(href)) continue;
        seen.add(href);
        out.push({ href, display: txt(a), resolved: null });
      }
    };
    collect(article.querySelector('div[data-testid="tweetText"]'));
    collect(article.querySelector('div[data-testid="card.wrapper"]'));
    collect(article.querySelector(ARTICLE_BODY));
    return out;
  }

  /* The unresized original of an X CDN image: the src in the DOM is whatever size the layout
   * happened to need, and `name=orig` asks for the full one. */
  const originalSize = src =>
    (/[?&]name=/.test(src) ? src.replace(/([?&])name=[^&]*/, "$1name=orig") : src);

  /* Content images only — avatars live under /profile_images/ and emoji under /emoji/, and
   * neither is worth keeping. */
  function tweetImages(root) {
    const urls = [...root.querySelectorAll("img[src]")]
      .map(img => img.src)
      .filter(src => /pbs\.twimg\.com\/(media|card_img)\//.test(src))
      .map(originalSize);
    return [...new Set(urls)];
  }

  /* The still frame a video shows before it plays. */
  function videoPosters(root) {
    const urls = [...root.querySelectorAll("video[poster]")]
      .map(v => v.poster)
      .filter(src => /pbs\.twimg\.com\//.test(src))
      .map(originalSize);
    return [...new Set(urls)];
  }

  /* Text with its line breaks, and emoji (X draws them as <img alt>) put back as characters. */
  function richText(node) {
    if (!node) return null;
    let out = "";
    const walk = n => {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeName === "IMG") out += n.getAttribute("alt") || "";
      else if (n.nodeName === "BR") out += "\n";
      else for (const child of n.childNodes) walk(child);
    };
    walk(node);
    return out.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null;
  }

  /* "1,234", "1.2K" and "3M" as numbers. */
  function parseCount(raw) {
    const m = String(raw ?? "").trim().match(/^(\d[\d,]*(?:\.\d+)?)\s*([KMB])?$/i);
    if (!m) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(parseFloat(m[1].replace(/,/g, "")) * scale);
  }

  /* The counts under a post. Each action button's aria-label opens with its count ("12 Likes.
   * Like") and carries none when the count is zero; the views link works the same way. The action
   * group's own label ("5 replies, 12 likes, 340 views") fills any the buttons do not give. */
  function tweetCounts(article) {
    const lead = el => parseCount((el.getAttribute("aria-label") || "").match(/^\s*([\d.,]+\s*[KMB]?)(?=\s|$)/i)?.[1]);
    const button = ids => article.querySelector(ids.map(id => `[data-testid="${id}"]`).join(", "));
    const fromButton = ids => { const b = button(ids); return b ? lead(b) ?? 0 : null; };
    const views = article.querySelector('a[href$="/analytics"]');
    const counts = {
      replies: fromButton(["reply"]),
      reposts: fromButton(["retweet", "unretweet"]),
      likes: fromButton(["like", "unlike"]),
      views: views ? lead(views) ?? 0 : null,
    };
    const label = article.querySelector('div[role="group"][aria-label]')?.getAttribute("aria-label") || "";
    const words = { replies: /([\d.,]+\s*[KMB]?)\s+repl(?:y|ies)/i, reposts: /([\d.,]+\s*[KMB]?)\s+repost/i,
      likes: /([\d.,]+\s*[KMB]?)\s+like/i, views: /([\d.,]+\s*[KMB]?)\s+view/i };
    for (const [key, re] of Object.entries(words)) {
      if (counts[key] == null) counts[key] = parseCount(label.match(re)?.[1]);
    }
    return counts;
  }

  /* --- replies -----------------------------------------------------------------
   *
   * Half the reason a tweet gets saved is a tool it names but does not link — "repo in the
   * comments". No API exposes reply bodies; they exist only in this rendered, logged-in page, so
   * this is the one thing scraping can do that fetching cannot.
   *
   * Every rendered reply is kept whole in `replies`; `reply_links` is the links among them, the
   * author's own reply first, because that is where "link below" points.
   *
   * x.com renders replies lazily and drops the ones scrolled out of view, so a plain read holds
   * only what is on screen. A page walk (startReplyWalk, noteReplies at each stop, endReplyWalk)
   * gathers them across the scroll and drops repeats by the reply's own address.
   */

  const articleStatusId = article =>
    statusId(article.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href"));

  const handleOf = article => {
    const spans = [...(article?.querySelectorAll('div[data-testid="User-Name"] span') || [])].map(s => s.textContent.trim());
    return spans.find(s => /^@\w+$/.test(s)) || null;
  };

  function readReply(art, primaryHandle) {
    const spans = [...art.querySelectorAll('div[data-testid="User-Name"] span')].map(s => s.textContent.trim());
    const handle = spans.find(s => /^@\w+$/.test(s)) || null;
    const body = art.querySelector('div[data-testid="tweetText"]');
    const stamp = art.querySelector("time[datetime]");
    const links = [];
    for (const a of body?.querySelectorAll("a[href]") || []) {
      const href = a.href;
      if (!href || /^https?:\/\/(x|twitter)\.com\//.test(href)) continue;   // in-app navigation
      if (!links.some(l => l.href === href)) links.push({ href, display: txt(a), resolved: null });
    }
    return {
      handle,
      name: spans.find(s => s && !s.startsWith("@") && s !== "·") || null,
      text: richText(body),
      posted: stamp?.getAttribute("datetime") || null,
      url: stamp?.closest("a")?.href?.split(/[?#]/)[0] || null,
      ...tweetCounts(art),
      self: !!handle && handle === primaryHandle,
      images: tweetImages(art),
      video: !!art.querySelector("video"),
      video_posters: videoPosters(art),
      links,
    };
  }

  /* Where the replies end. Below a thread's replies x.com draws a recommendation section
   * ("Discover more", "More posts", "Sourced from across X") of unrelated posts, in the same
   * timeline and with the same <article data-testid="tweet"> elements, so an article being there
   * does not make it a reply. The section starts at a cell of the conversation list
   * (`div[data-testid="cellInnerDiv"]`, inside the `[aria-label^="Timeline: Conversation"]`
   * timeline when the page has one) that holds a heading (`h2` or `[role="heading"]`) and no post.
   * The cell is the boundary when either holds:
   *   - its heading reads as one of SECTION_HEADINGS (English wording, matched exactly); or
   *   - structure alone: the replies run on as one unbroken list of post cells, so a heading-only
   *     cell that follows a post is a section break whatever language its heading is in.
   * The structural test is an assumption about x.com's markup, not something read from its
   * documentation: it takes a heading cell below a post as the end of the replies, and needs a
   * post above the cell (in the document, or already gathered by a walk). Only articles before
   * the boundary are replies. */
  const SECTION_HEADINGS = /^(discover more|more posts|sourced from across x)$/i;
  const POST = 'article[data-testid="tweet"]';

  function replyBoundary(postSeen = false) {
    const timeline = document.querySelector('[aria-label^="Timeline: Conversation"]');
    const cells = (timeline || document).querySelectorAll('div[data-testid="cellInnerDiv"]');
    const articles = [...document.querySelectorAll(POST)];
    for (const cell of cells) {
      if (cell.querySelector(POST)) continue;
      const title = txt(cell.querySelector('h2, [role="heading"]'));
      if (!title) continue;
      if (SECTION_HEADINGS.test(title)) return cell;
      if (postSeen || articles.some(a => a.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING)) return cell;
    }
    return null;
  }

  const isBefore = (boundary, art) =>
    !boundary || !(boundary.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING);

  /* The replies on screen: every article above the boundary but the post itself, which is the one
   * at `primary` or the one with its address. `ended` says the boundary was in view. */
  function readReplies(primary, primaryHandle, primaryId, postSeen = false) {
    const boundary = replyBoundary(postSeen);
    return {
      ended: !!boundary,
      replies: [...document.querySelectorAll(POST)]
        .filter(art => isBefore(boundary, art))
        .filter(art => art !== primary && !(primaryId && articleStatusId(art) === primaryId))
        .map(art => readReply(art, primaryHandle)),
    };
  }

  const postId = primary => statusId(location.pathname) || (primary && articleStatusId(primary)) || null;

  /* The record's three reply fields from the replies gathered. */
  function replySet(replies) {
    const links = [];
    const seen = new Set();
    for (const r of replies) {
      for (const l of r.links) {
        if (seen.has(l.href)) continue;
        seen.add(l.href);
        links.push({ ...l, from: r.handle, self: r.self, context: (r.text || "").replace(/\s+/g, " ").slice(0, 160) || null });
      }
    }
    links.sort((a, b) => Number(b.self) - Number(a.self));
    return { replies, reply_links: links, replies_scanned: replies.length };
  }

  const replyKey = r => r.url || `${r.handle}|${r.text}`;

  /* A reply seen again keeps what it had and takes what the new render knows. */
  function mergeReply(old, next) {
    const pick = (a, b) => (b == null || (Array.isArray(b) && !b.length) ? a : b);
    return {
      ...old, ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, pick(old[k], v)])),
      text: (next.text || "").length > (old.text || "").length ? next.text : old.text,
      video: old.video || next.video,
    };
  }

  let walk = null;

  /* The post's own article is not always rendered mid-walk, so it is told apart by its address
   * and its author's handle is kept from the start. Once the boundary (replyBoundary) has been in
   * view the replies are complete: later calls read nothing, and the result says `ended` so the
   * caller can stop asking. Null when no walk is running. */
  function noteReplies() {
    if (!walk) return null;
    if (!walk.ended) {
      const read = readReplies(null, walk.handle, walk.id, walk.found.size > 0 || walk.posted);
      for (const r of read.replies) {
        const key = replyKey(r);
        walk.found.set(key, walk.found.has(key) ? mergeReply(walk.found.get(key), r) : r);
      }
      walk.ended = read.ended;
    }
    return { ended: walk.ended };
  }

  function startReplyWalk() {
    const primary = primaryArticle();
    walk = { handle: handleOf(primary), id: postId(primary), posted: !!primary, found: new Map(), ended: false };
    return noteReplies();
  }

  function endReplyWalk() {
    if (!walk) return null;
    const set = replySet([...walk.found.values()]);
    walk = null;
    return set;
  }

  /* Long-form "Articles" reuse the tweet element for author and timestamp but put the title
   * and body in their own nodes, and have no tweetText at all. */
  const ARTICLE_BODY = '[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]';
  const ARTICLE_TITLE = '[data-testid="twitter-article-title"]';

  function tweet() {
    const article = primaryArticle();
    if (!article) return null;   // not hydrated yet — the dispatcher will retry

    const nameBlock = article.querySelector('div[data-testid="User-Name"]');
    const spans = nameBlock ? [...nameBlock.querySelectorAll("span")].map(s => s.textContent.trim()) : [];
    const handle = spans.find(s => /^@\w+$/.test(s)) || null;
    const name = spans.find(s => s && !s.startsWith("@") && s !== "·") || null;

    const timeEl = article.querySelector("time[datetime]");
    const permalink = timeEl?.closest("a")?.href || location.href;

    const quotedBlock = [...article.querySelectorAll('div[role="link"]')]
      .find(d => d.querySelector('div[data-testid="User-Name"]'));

    const replies = replySet(readReplies(article, handle, postId(article)).replies);
    const articleTitle = txt(article.querySelector(ARTICLE_TITLE));
    const articleBody = article.querySelector(ARTICLE_BODY);
    const isLongform = !!(articleTitle || articleBody);

    return {
      kind: isLongform ? "x-article" : "tweet",
      url: permalink.split("?")[0],
      status_id: statusId(permalink) || statusId(location.pathname),
      author: { name, handle },
      // An article has a real headline worth keeping; a plain tweet does not, so its own text
      // carries the meaning and the title is just an identifier.
      title: articleTitle || (handle ? `${handle} on X` : "X post"),
      // A long-form body is kept whole, with its line structure, up to a bound that no real
      // article reaches. A plain tweet is short enough that collapsing whitespace is fine.
      text: txt(article.querySelector('div[data-testid="tweetText"]'))
        || (articleBody ? blockText(articleBody)?.slice(0, 60000) : null),
      code_blocks: [...article.querySelectorAll('[data-testid="markdown-code-block"]')]
        .map(blockText).filter(Boolean),
      images: tweetImages(article),
      replies: replies.replies,
      reply_links: replies.reply_links,
      replies_scanned: replies.replies_scanned,
      posted: timeEl?.getAttribute("datetime") || null,
      links: tweetLinks(article),
      quoted: quotedBlock && {
        handle: [...quotedBlock.querySelectorAll('div[data-testid="User-Name"] span')]
          .map(s => s.textContent.trim()).find(s => /^@\w+$/.test(s)) || null,
        text: txt(quotedBlock.querySelector('div[data-testid="tweetText"]')),
        url: quotedBlock.querySelector('a[href*="/status/"]')?.href || null,
      },
      media: [
        article.querySelector('div[data-testid="tweetPhoto"] img') && "photo",
        article.querySelector("video") && "video",
        article.querySelector('div[data-testid="card.wrapper"]') && "card",
      ].filter(Boolean),
      fallback_text: txt(article)?.slice(0, 1200) || null,
    };
  }

  /* --- github ------------------------------------------------------------------ */

  /* A repo page is its description and its README. GitHub's 2026 layout names its classes per build
   * (SidebarAbout-module_eqNI3a_description) and serves no og: tags, so the description falls back
   * to the About box by class prefix, then to the page title "owner/repo: description". */
  const README_MAX = 6000;
  const isBadge = src => /shields\.io|badge|\.svg(\?|$)/i.test(src);

  function github() {
    const [owner, repo] = location.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    const isIssue = /\/(issues|pull)\/\d+/.test(location.pathname);
    if (isIssue) {
      return {
        kind: "issue",
        title: txt(document.querySelector(".gh-header-title, h1 bdi, [data-testid=issue-title]")) || document.title,
        text: txt(document.querySelector(".comment-body, [data-testid=issue-body]"))?.slice(0, 800),
        author: { name: owner, handle: owner },
      };
    }
    const fromTitle = document.title.match(/^[^:]+\/[^:]+:\s*(.+)$/)?.[1] || null;
    const about = txt(document.querySelector('[class*="SidebarAbout-module"][class*="_description"], p.f4.my-3, [data-testid="repo-description"]'))
      || meta("og:description") || fromTitle;
    const readmeNode = document.querySelector("article.markdown-body");
    const readme = blockText(readmeNode)?.slice(0, README_MAX) || null;
    const seen = new Set();
    const links = [...document.querySelectorAll('.BorderGrid a[href^="http"], [class*="SidebarAbout-module"] a[href^="http"]'),
      ...(readmeNode?.querySelectorAll('a[href^="http"]') || [])]
      .filter(a => !seen.has(a.href) && seen.add(a.href) && !a.querySelector("img"))
      .slice(0, 12)
      .map(a => ({ href: a.href, display: txt(a), resolved: a.href }));
    const images = [...(readmeNode?.querySelectorAll("img[src]") || [])]
      .map(i => i.src).filter(src => /^https?:/.test(src) && !isBadge(src)).slice(0, 4);
    return {
      kind: "repo",
      title: `${owner}/${repo}`,
      text: [about, readme].filter(Boolean).join("\n\n") || null,
      author: { name: owner, handle: owner },
      links,
      ...(images.length ? { images } : {}),
      stars: txt(document.querySelector('#repo-stars-counter-star, a[href$="/stargazers"] strong, [data-testid="star-button"] [data-component="CounterLabel"]')),
      lang: txt(document.querySelector('.BorderGrid [itemprop="programmingLanguage"]')),
    };
  }

  /* --- hacker news ------------------------------------------------------------- */

  function hackernews() {
    const row = document.querySelector(".athing.submission, .athing");
    if (!row) return null;
    const link = row.querySelector(".titleline a");
    const sub = row.nextElementSibling?.querySelector(".subtext");
    return {
      kind: "hn-item",
      title: txt(link) || document.title,
      // The story's own URL is the reason to keep an HN item; the discussion is secondary.
      links: link && !link.href.includes("news.ycombinator.com")
        ? [{ href: link.href, display: txt(link), resolved: link.href }]
        : [],
      text: txt(document.querySelector(".toptext")) || null,
      author: { handle: txt(sub?.querySelector(".hnuser")), name: null },
      points: txt(sub?.querySelector(".score")),
      comments: [...(sub?.querySelectorAll("a") || [])].map(txt).find(t => t && /comment/.test(t)) || null,
    };
  }

  /* --- youtube ----------------------------------------------------------------- */
  /* A video by its preview tags. A search lists its results, each "title — channel · views · age", from
   * the page's own data (ytInitialData, in the HTML YouTube sends) or else the drawn results, so it reads
   * whether or not the page has drawn itself; a page out of sight may not have. Any other page (a
   * channel, the home feed) is kept by its visible text, as a page no site reader knows. */

  /* The JSON YouTube ships in a script as `var ytInitialData = {...};`, or null. */
  function ytInitialData() {
    for (const node of document.querySelectorAll("script:not([src])")) {
      const src = node.textContent;
      const at = src.indexOf("ytInitialData = ");
      if (at < 0) continue;
      const start = src.indexOf("{", at), end = src.lastIndexOf("}");
      try { return JSON.parse(src.slice(start, end + 1)); } catch (e) { return null; }
    }
    return null;
  }
  const ytText = t => t?.simpleText || t?.runs?.map(r => r.text).join("") || null;

  function youtubeResults() {
    const found = [];
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 40 || found.length >= 40) return;
      if (node.videoRenderer?.videoId) { found.push(node.videoRenderer); return; }
      for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, depth + 1);
    };
    walk(ytInitialData()?.contents);
    let items = found.map(v => ({
      href: `https://www.youtube.com/watch?v=${v.videoId}`,
      title: ytText(v.title),
      about: [ytText(v.ownerText), ytText(v.lengthText), ytText(v.viewCountText), ytText(v.publishedTimeText)].filter(Boolean),
    }));
    if (!items.length) {
      items = [...document.querySelectorAll("ytd-video-renderer")].map(r => ({
        href: r.querySelector("a#video-title")?.href || null,
        title: txt(r.querySelector("#video-title")),
        about: [txt(r.querySelector("ytd-channel-name a")), ...[...r.querySelectorAll("#metadata-line span")].map(txt)].filter(Boolean),
      }));
    }
    items = items.filter(i => i.title && i.href);
    if (!items.length) return null;   // not drawn yet
    const query = new URLSearchParams(location.search).get("search_query");
    return {
      kind: "search",
      title: query ? `YouTube search: ${query}` : document.title,
      text: items.map(i => `• ${i.title}${i.about.length ? ` — ${i.about.join(" · ")}` : ""}`).join("\n").slice(0, MAIN_MAX),
      links: items.slice(0, 12).map(i => ({ href: i.href, display: i.title, resolved: i.href })),
    };
  }

  function youtube() {
    if (location.pathname === "/results") return youtubeResults();
    if (!/\/watch|\/shorts\//.test(location.pathname)) return {};
    return {
      kind: "video",
      title: meta("og:title") || txt(document.querySelector("h1.ytd-watch-metadata")) || document.title,
      author: {
        name: txt(document.querySelector("ytd-channel-name a, #owner #channel-name a")),
        handle: null,
      },
      text: meta("og:description")?.slice(0, 800) || null,
      posted: attr('meta[itemprop="datePublished"]') || null,
      duration: meta("og:video:duration") || null,
    };
  }

  /* --- reddit ------------------------------------------------------------------ */
  /* A post with its body and top comments, "u/name: comment" a blank line apart, from new Reddit
   * (shreddit-post, shreddit-comment) or old Reddit (.thing), whichever the account opens. A subreddit
   * or other listing lists its posts. */
  const COMMENTS_MAX = 20;
  const redditLink = href => (href && !/^https?:\/\/([\w-]+\.)*reddit\.com\//.test(href) && !href.startsWith("/")
    ? [{ href, display: href, resolved: href }] : []);
  const joinText = (body, comments) => [body, ...comments].filter(Boolean).join("\n\n").slice(0, MAIN_MAX) || null;

  function redditNew(onPost) {
    const posts = [...document.querySelectorAll("shreddit-post")];
    if (!posts.length) return null;
    if (!onPost) return redditListing(posts.map(p => ({ title: p.getAttribute("post-title"), href: p.getAttribute("permalink"), about: [p.getAttribute("subreddit-prefixed-name"), p.getAttribute("comment-count") && `${p.getAttribute("comment-count")} comments`] })));
    const post = posts[0];
    const body = post.querySelector("[slot=text-body]") || document.querySelector("[data-post-click-location=text-body]");
    const comments = [...document.querySelectorAll("shreddit-comment[depth='0']")].slice(0, COMMENTS_MAX)
      .map(c => { const t = readableText(c.querySelector("[slot=comment]") || c); return t && `u/${c.getAttribute("author")}: ${t}`; });
    return {
      kind: "reddit-post",
      title: post.getAttribute("post-title") || meta("og:title"),
      author: { handle: post.getAttribute("author"), name: null },
      subreddit: post.getAttribute("subreddit-prefixed-name"),
      posted: post.getAttribute("created-timestamp"),
      links: redditLink(post.getAttribute("content-href")),
      text: joinText(body && readableText(body), comments),
    };
  }

  function redditOld(onPost) {
    const things = [...document.querySelectorAll("#siteTable > .thing.link")];
    if (!things.length) return null;
    if (!onPost) return redditListing(things.map(t => ({ title: txt(t.querySelector("a.title")), href: t.getAttribute("data-permalink"), about: [t.getAttribute("data-subreddit-prefixed"), t.getAttribute("data-comments-count") && `${t.getAttribute("data-comments-count")} comments`] })));
    const post = things[0];
    const body = post.querySelector(".usertext-body .md");
    const comments = [...document.querySelectorAll(".commentarea > .sitetable > .thing.comment")].slice(0, COMMENTS_MAX)
      .map(c => { const t = readableText(c.querySelector(":scope > .entry .usertext-body .md") || c); return t && `u/${c.getAttribute("data-author")}: ${t}`; });
    const at = Number(post.getAttribute("data-timestamp"));
    return {
      kind: "reddit-post",
      title: txt(post.querySelector("a.title")) || meta("og:title"),
      author: { handle: post.getAttribute("data-author"), name: null },
      subreddit: post.getAttribute("data-subreddit-prefixed"),
      posted: at ? new Date(at).toISOString() : null,
      links: redditLink(post.getAttribute("data-url")),
      text: joinText(body && readableText(body), comments),
    };
  }

  function redditListing(posts) {
    const items = posts.filter(p => p.title);
    return {
      kind: "reddit-listing",
      text: items.map(p => `• ${p.title}${p.about.filter(Boolean).length ? ` — ${p.about.filter(Boolean).join(" · ")}` : ""}`).join("\n").slice(0, MAIN_MAX) || null,
    };
  }

  function reddit() {
    const onPost = /\/comments\//.test(location.pathname);
    return redditNew(onPost) || redditOld(onPost) || (onPost ? null : {});
  }

  /* --- instagram --------------------------------------------------------------- */
  /* A reel or post names everything in its preview tags: og:title 'Name on Instagram: "caption"',
   * og:description '998 likes, 167 comments - handle on October 13, 2026: "caption"', twitter:title
   * "Name (@handle) • Instagram reel", og:image its cover. The markup is per-build class names; the tags
   * are what lasts. Instagram swaps posts without loading a page, so the tags count only while og:url
   * names the post on screen. Kept under /reel/ID/ or /p/ID/, as the export writes them. */
  function instagram() {
    const id = location.pathname.match(/\/(reels?|p|tv)\/([\w-]+)/);
    if (!id) return {};   // a profile or the feed: its preview tags, as any page
    const ogUrl = meta("og:url") || "";
    if (!ogUrl.includes(`/${id[2]}/`)) return null;
    const tt = (meta("twitter:title") || "").match(/^(.*?)\s*\(@([\w.]+)\)/);
    const reel = /\/(reels?|tv)\//.test(ogUrl) || /\breel\b/i.test(meta("twitter:title") || "");
    const desc = meta("og:description") || meta("description") || "";
    const quoted = str => (str.match(/:\s*"([\s\S]*)"\s*\.?\s*$/) || [])[1]?.trim() || null;
    const caption = quoted(meta("og:title") || "") || quoted(desc);
    const stats = desc.match(/^([\d.,]+[KkMm]?)\s+likes?,\s*([\d.,]+[KkMm]?)\s+comments?\s+-\s+([\w.]+)\s+on\s+([^:]+):/);
    const day = stats && new Date(stats[4]);
    const pad = n => String(n).padStart(2, "0");
    return {
      kind: reel ? "reel" : "ig-post",
      url: `https://www.instagram.com/${reel ? "reel" : "p"}/${id[2]}/`,
      title: caption ? caption.split("\n")[0].slice(0, 100) : null,
      text: caption,
      author: { handle: tt?.[2] || stats?.[3] || null, name: tt?.[1] || null },
      posted: day && !Number.isNaN(day.getTime()) ? `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}` : null,
      likes: stats?.[1] || null,
      comments: stats?.[2] || null,
      images: [meta("og:image")].filter(Boolean),
    };
  }

  /* --- walls ------------------------------------------------------------------
   * A page that stands in front of the one asked for: a login page a site sent us to, a captcha, or a
   * block for too many requests. Kept as a capture it would pass for the page itself, so the capture
   * is refused instead, and the capture queue stops visiting that site. Returns { kind, reason } or
   * null; kind is "login", "captcha" or "blocked". A captcha widget or a block sentence counts only
   * on a short page, since a real article can hold a form with a captcha or quote "too many requests". */
  const LOGIN_PATH = /^\/(accounts\/login|i\/flow\/login|login|signin|sign-in|uas\/login|authwall|checkpoint|ServiceLogin|v3\/signin)(\/|$|\?)/i;
  const CAPTCHA_TITLE = /^(just a moment|attention required|verifying you are human|checking your browser|are you a robot|security check|bot verification)/i;
  const BLOCKED_TITLE = /^(access denied|403 forbidden|forbidden|429 too many requests|too many requests|rate limit)/i;
  // "...requests this quickly" is Hacker News's rate limit, a page of one line.
  const BLOCKED_TEXT = /(you('ve| have) been blocked|unusual traffic|too many requests|rate.limited|temporarily (blocked|restricted)|not able to serve your requests this quickly)/i;

  function wall() {
    const host = location.hostname.toLowerCase();
    const title = (document.title || "").trim();
    const body = (document.body?.innerText || "").trim();
    const short = body.length < 1500;
    if (host === "accounts.google.com" || LOGIN_PATH.test(location.pathname)) return { kind: "login", reason: `${host} asked to log in` };
    if (/(^|\.)google\.[a-z.]+$/.test(host) && location.pathname.startsWith("/sorry/")) return { kind: "captcha", reason: `${host} asked for a captcha` };
    if (CAPTCHA_TITLE.test(title)) return { kind: "captcha", reason: `${host} asked for a captcha ("${title.slice(0, 60)}")` };
    if (short && document.querySelector('#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha.com"]')) {
      return { kind: "captcha", reason: `${host} asked for a captcha` };
    }
    if (BLOCKED_TITLE.test(title)) return { kind: "blocked", reason: `${host} refused the page ("${title.slice(0, 60)}")` };
    if (short && BLOCKED_TEXT.test(body)) return { kind: "blocked", reason: `${host} refused the page: ${body.match(BLOCKED_TEXT)[0]}` };
    return null;
  }

  const REGISTRY = [
    { hosts: /(^|\.)(x|twitter)\.com$/, run: tweet },
    { hosts: /(^|\.)github\.com$/, run: github },
    { hosts: /(^|\.)news\.ycombinator\.com$/, run: hackernews },
    { hosts: /(^|\.)(youtube\.com|youtu\.be)$/, run: youtube },
    { hosts: /(^|\.)reddit\.com$/, run: reddit },
    { hosts: /(^|\.)instagram\.com$/, run: instagram },
  ];

  /* The site handler wins field by field; generic() fills the gaps. */
  /* The site handler wins field by field; generic() fills the gaps. A handler answers null while its
   * page is not ready, and {} for a page it has nothing to add to (a profile, a channel), which is then
   * read as a page no site reader knows. */
  function extract(hostname = location.hostname) {
    const host = hostname.toLowerCase();
    const handler = REGISTRY.find(entry => entry.hosts.test(host));
    const base = generic();
    let specific = null;
    if (handler) {
      try {
        specific = handler.run();
      } catch (e) {
        specific = { extractor_error: String(e.message || e) };
      }
      if (!specific) return null;   // not ready
    }
    // A page no site reader knows is kept by its own text: its description stays only when that text is short.
    // An app, a listing or a dashboard has no block of paragraphs to find; its visible text, without the
    // menus, headers and footers around it, stands in, and is kept whenever there is no description.
    if (!specific || !Object.keys(specific).length) {
      let root = mainNode();
      let own = root && readableText(root);
      if (!own || own.length < 280) {
        const whole = document.querySelector("main, [role=main]") || document.body;
        const all = whole && readableText(whole);
        if (all && all.length > (own?.length || 0)) { root = whole; own = all; }
      }
      if (own && (own.length >= 280 || !base.text)) {
        base.text = base.text && !own.replace(/\s+/g, " ").includes(base.text.replace(/\s+/g, " ").slice(0, 60)) ? `${base.text}\n\n${own}` : own;
        base.links = mainLinks(root);
      }
      if (!specific) return base;
    }

    const merged = { ...base, ...specific };
    merged.author = specific.author?.handle || specific.author?.name ? specific.author : base.author;
    if (!merged.text) merged.text = base.text;
    return merged;
  }

  return { extract, wall, startReplyWalk, noteReplies, endReplyWalk, hasHandler: () => REGISTRY.some(e => e.hosts.test(location.hostname.toLowerCase())) };
})();
