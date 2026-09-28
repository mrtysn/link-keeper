/* Shared by the list and sessions pages: a link's host, and the source icon drawn beside it. */

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch (e) { return "(unparseable)"; }
}

/* Source favicons, inlined as SVG so the page makes no network requests. A handful of brands
 * cover nearly the whole list; anything else gets a neutral monogram of its domain's first
 * letter, which is still a scent even for a host seen once. */
const BRAND_ICONS = {
  ig: '<rect width="24" height="24" rx="6" fill="#C13584"/><rect x="5.6" y="5.6" width="12.8" height="12.8" rx="3.4" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.1" cy="7.9" r="1.1" fill="#fff"/>',
  x: '<rect width="24" height="24" rx="6" fill="#000"/><path d="M5.8 5h4l3 4.4L16.2 5h2.6l-4.9 6.3L19.3 19h-4l-3.3-4.8L8.2 19H5.6l5.3-6.9L5.8 5z" fill="#fff"/>',
  gh: '<rect width="24" height="24" rx="6" fill="#181717"/><path transform="translate(3.6 3.6) scale(.7)" fill="#fff" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  yt: '<rect width="24" height="24" rx="6" fill="#FF0000"/><path d="M9.8 8.3v7.4l6.4-3.7z" fill="#fff"/>',
  rd: '<rect width="24" height="24" rx="6" fill="#FF4500"/><circle cx="8.8" cy="13" r="1.4" fill="#fff"/><circle cx="15.2" cy="13" r="1.4" fill="#fff"/><path d="M8.5 16.2c1 .9 2.2 1.3 3.5 1.3s2.5-.4 3.5-1.3" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2" fill="#fff"/><path d="M12 7.6c2.9 0 5.6 1 7.2 2.7M12 7.6C9.1 7.6 6.4 8.6 4.8 10.3" fill="none" stroke="#fff" stroke-width="1.1"/>',
  hn: '<rect width="24" height="24" rx="6" fill="#F60"/><text x="12" y="17" font-family="Verdana,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff">Y</text>',
};

function brandOf(host) {
  if (/(^|\.)instagram\.com$/.test(host)) return "ig";
  if (/(^|\.)(x|twitter)\.com$|^t\.co$/.test(host)) return "x";
  if (/(^|\.)github\.com$/.test(host)) return "gh";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "yt";
  if (/(^|\.)reddit\.com$/.test(host)) return "rd";
  if (host === "news.ycombinator.com") return "hn";
  return null;
}

function srcIcon(url) {
  const icon = document.createElement("span");
  icon.className = "src";
  const host = hostOf(url);
  const glyph = BRAND_ICONS[brandOf(host)] ||
    `<rect width="24" height="24" rx="6" fill="#5a5f6a"/><text x="12" y="17" font-family="Verdana,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#fff">${(host[0] || "•").toUpperCase()}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${glyph}</svg>`;
  icon.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
