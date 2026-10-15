/* The bar across the top of every Link Keeper page: a link to each viewer, the current one marked.
 * Loaded as the first thing in <body>, without defer, so the bar is in place before the page paints
 * and every page gets the same one. Styles are in nav.css.
 *
 * Every page shows one pile: every link, wherever it came from. The source chips that narrowed it
 * to stashed tabs, imports or the reading list went in 5.58; a choice stored before then is unread.
 * window.LinkSources stays for the pages that read it, always every source. */

(() => {
  const PAGES = [
    ["list.html", "Links", "Every link, the selected one in full beside the list"],
    ["cards.html", "Cards", "Go through links one card at a time"],
  ];
  const ALL = ["tabs", "import", "list"];
  const here = location.pathname.split("/").pop() || "list.html";

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  nav.setAttribute("aria-label", "Link Keeper");

  const brand = document.createElement("span");
  brand.className = "app-brand";
  const logo = document.createElement("img");
  logo.src = "icon.svg";
  logo.alt = "";
  brand.append(logo, "Link Keeper");
  // The installed build, read from the manifest so it cannot go stale.
  const version = browser.runtime.getManifest?.()?.version;
  if (version) {
    const v = document.createElement("span");
    v.className = "app-version";
    v.textContent = `v${version}`;
    v.title = `Link Keeper ${version}`;
    brand.append(v);
  }

  const pages = document.createElement("div");
  pages.className = "app-pages";
  for (const [href, label, title] of PAGES) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.title = title;
    if (href === here) a.setAttribute("aria-current", "page");
    pages.append(a);
  }

  nav.append(brand, pages);
  document.currentScript.replaceWith(nav);

  window.LinkSources = {
    ready: Promise.resolve(ALL),
    get: () => ALL,
    onChange: () => {},
    setCounts: () => {},
  };
})();

/* A sticky side pane marked data-fit-window="<gap px>" ends at the window's bottom edge. Its CSS
 * max-height assumes it sticks at the top, but at scroll 0 it starts lower, below the bar above. */
(() => {
  const fit = () => {
    for (const el of document.querySelectorAll("[data-fit-window]")) {
      const gap = Number(el.dataset.fitWindow) || 0;
      if (getComputedStyle(el).position !== "sticky") { el.style.removeProperty("max-height"); continue; }
      const top = Math.max(parseFloat(getComputedStyle(el).top) || 0, el.getBoundingClientRect().top);
      el.style.maxHeight = `${Math.max(160, window.innerHeight - top - gap)}px`;
    }
  };
  addEventListener("scroll", fit, { passive: true });
  addEventListener("resize", fit);
  addEventListener("load", fit);
  document.addEventListener("DOMContentLoaded", fit);
  new MutationObserver(fit).observe(document.documentElement, { childList: true, subtree: true });
})();
