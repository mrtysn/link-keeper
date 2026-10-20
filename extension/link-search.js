/* Ranked word search over links, shared by the Links page and tools/search-saved-links.mjs.
 *
 * Every word of a query must match. A word matches when the link holds its stem as a whole token,
 * or when the link's lowercased text holds the word as a substring, so nothing the page's old
 * single-substring filter found is lost. Links are scored with BM25 over weighted fields: a hit in
 * a title or tag counts for more than one in the captured text.
 *
 * Callers pass `fieldsOf(link)`, returning { title, url, tags, note, text, links }: strings, or
 * arrays of strings for tags and links. A link's tokens are cached until its fields change. */

var LinkSearch = (() => {
  const WEIGHTS = { title: 3, tags: 3, url: 2, note: 2, text: 1, links: 1 };
  const K1 = 1.2, B = 0.75, SUBSTRING_ONLY = 0.1;
  const cache = new WeakMap();

  const stem = w => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
  const tokens = text => (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stem);
  const joined = v => (Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v || ""));

  function docOf(link, fieldsOf) {
    const f = fieldsOf(link);
    const sig = Object.keys(WEIGHTS).map(k => joined(f[k]).length).join("|");
    const hit = cache.get(link);
    if (hit && hit.sig === sig) return hit;
    const tf = new Map();
    let len = 0;
    for (const [field, weight] of Object.entries(WEIGHTS)) {
      for (const t of tokens(joined(f[field]))) {
        tf.set(t, (tf.get(t) || 0) + weight);
        len += weight;
      }
    }
    const doc = { sig, tf, len, hay: Object.keys(WEIGHTS).map(k => joined(f[k])).join(" ").toLowerCase() };
    cache.set(link, doc);
    return doc;
  }

  /* The links that match every word of `query`, best first. Ties keep the order given. */
  function rank(links, query, fieldsOf) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return links.map(link => ({ link, score: 0 }));
    const wordStems = words.map(w => [...new Set(tokens(w))]);
    const docs = links.map(l => docOf(l, fieldsOf));
    const avgLen = docs.reduce((n, d) => n + d.len, 0) / (docs.length || 1) || 1;
    const df = new Map();
    for (const stems of wordStems) {
      for (const s of stems) if (!df.has(s)) df.set(s, docs.reduce((n, d) => n + (d.tf.has(s) ? 1 : 0), 0));
    }
    const scored = [];
    links.forEach((link, i) => {
      const d = docs[i];
      let score = 0;
      for (let w = 0; w < words.length; w++) {
        const stems = wordStems[w];
        if (stems.length && stems.every(s => d.tf.has(s))) {
          for (const s of stems) {
            const idf = Math.log(1 + (docs.length - df.get(s) + 0.5) / (df.get(s) + 0.5));
            const tf = d.tf.get(s);
            score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * d.len / avgLen));
          }
        } else if (d.hay.includes(words[w])) {
          score += SUBSTRING_ONLY;
        } else {
          return;
        }
      }
      scored.push({ link, score, i });
    });
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(({ link, score }) => ({ link, score }));
  }

  return { rank, tokens };
})();
