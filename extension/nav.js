/* The bar across the top of every Link Keeper page: one link to each page, the current one marked.
 * Loaded as the first thing in <body>, without defer, so the bar is in place before the page paints
 * and every page gets the same one. Styles are in nav.css. */

(() => {
  const PAGES = [
    ["list.html", "List", "Every link you captured"],
    ["cards.html", "Cards", "Judge what you have read as a shuffled card deck"],
    ["sessions.html", "Stashed", "Tabs you have stashed"],
    ["stash-cards.html", "Explore", "Browse every stashed tab with details and a live preview"],
  ];
  const here = location.pathname.split("/").pop() || "list.html";

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  nav.setAttribute("aria-label", "Link Keeper pages");

  const brand = document.createElement("span");
  brand.className = "app-brand";
  const logo = document.createElement("img");
  logo.src = "icon.svg";
  logo.alt = "";
  brand.append(logo, "Link Keeper");
  nav.append(brand);

  for (const [href, label, title] of PAGES) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.title = title;
    if (href === here) a.setAttribute("aria-current", "page");
    nav.append(a);
  }

  document.currentScript.replaceWith(nav);
})();
