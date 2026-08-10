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
        // Drop in-app navigation: mentions, hashtags, the permalink itself.
        if (/^https?:\/\/(x|twitter)\.com\/(hashtag\/|i\/|[^/]+\/status\/|[^/]+$)/.test(href)) continue;
        seen.add(href);
        out.push({ href, display: txt(a), resolved: null });
      }
    };
    collect(article.querySelector('div[data-testid="tweetText"]'));
    collect(article.querySelector('div[data-testid="card.wrapper"]'));
    return out;
  }

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

    return {
      kind: "tweet",
      url: permalink.split("?")[0],
      status_id: statusId(permalink) || statusId(location.pathname),
      author: { name, handle },
      title: handle ? `${handle} on X` : "X post",
      text: txt(article.querySelector('div[data-testid="tweetText"]')),
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

  function github() {
    const [owner, repo] = location.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    const isIssue = /\/(issues|pull)\/\d+/.test(location.pathname);
    return {
      kind: isIssue ? "issue" : "repo",
      title: isIssue
        ? txt(document.querySelector(".gh-header-title, h1 bdi")) || document.title
        : `${owner}/${repo}`,
      text: isIssue
        ? txt(document.querySelector(".comment-body, [data-testid=issue-body]"))?.slice(0, 800)
        : txt(document.querySelector('p.f4.my-3, [data-testid="repo-description"]')) || meta("og:description"),
      author: { name: owner, handle: owner },
      links: [...document.querySelectorAll('.BorderGrid a[href^="http"]')]
        .slice(0, 4)
        .map(a => ({ href: a.href, display: txt(a), resolved: a.href })),
      stars: txt(document.querySelector('#repo-stars-counter-star, a[href$="/stargazers"] strong')),
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

  function youtube() {
    if (!/\/watch|\/shorts\//.test(location.pathname)) return null;
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

  function reddit() {
    const post = document.querySelector("shreddit-post");
    if (!post) return null;
    const outbound = post.getAttribute("content-href");
    return {
      kind: "reddit-post",
      title: post.getAttribute("post-title") || meta("og:title"),
      author: { handle: post.getAttribute("author"), name: null },
      subreddit: post.getAttribute("subreddit-prefixed-name"),
      posted: post.getAttribute("created-timestamp"),
      links: outbound && !outbound.includes("reddit.com")
        ? [{ href: outbound, display: outbound, resolved: outbound }]
        : [],
      text: txt(document.querySelector("[data-post-click-location=text-body]"))?.slice(0, 800) || null,
    };
  }

  const REGISTRY = [
    { hosts: /(^|\.)(x|twitter)\.com$/, run: tweet },
    { hosts: /(^|\.)github\.com$/, run: github },
    { hosts: /(^|\.)news\.ycombinator\.com$/, run: hackernews },
    { hosts: /(^|\.)(youtube\.com|youtu\.be)$/, run: youtube },
    { hosts: /(^|\.)reddit\.com$/, run: reddit },
  ];

  /* The site handler wins field by field; generic() fills the gaps. */
  function extract() {
    const host = location.hostname.toLowerCase();
    const handler = REGISTRY.find(entry => entry.hosts.test(host));
    const base = generic();
    let specific = null;
    if (handler) {
      try {
        specific = handler.run();
      } catch (e) {
        specific = { extractor_error: String(e.message || e) };
      }
    }
    if (!specific) return handler ? null : base;   // handler present but page not ready

    const merged = { ...base, ...specific };
    merged.author = specific.author?.handle || specific.author?.name ? specific.author : base.author;
    if (!merged.text) merged.text = base.text;
    return merged;
  }

  return { extract, hasHandler: () => REGISTRY.some(e => e.hosts.test(location.hostname.toLowerCase())) };
})();
