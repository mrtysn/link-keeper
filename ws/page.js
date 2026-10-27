(function () {
  var media = matchMedia("(prefers-color-scheme: light)");
  function theme() {
    document.documentElement.dataset.theme = media.matches ? "light" : "dark";
  }
  theme();
  media.addEventListener("change", theme);
})();
document.addEventListener("DOMContentLoaded", function () {
  [].forEach.call(document.querySelectorAll('a[href]:not([href^="#"])'), function (a) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
  var links = [].slice.call(document.querySelectorAll(".ws-toc a"));
  if (!links.length) return;
  var sections = links.map(function (a) {
    return document.getElementById(a.getAttribute("href").slice(1));
  });
  function mark() {
    var at = window.innerHeight * 0.3, current = 0, k;
    for (k = 0; k < sections.length; k++) {
      if (sections[k] && sections[k].getBoundingClientRect().top <= at) current = k;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = sections.length - 1;
    links.forEach(function (a, n) {
      a.setAttribute("aria-current", n === current ? "true" : "false");
    });
  }
  addEventListener("scroll", mark, { passive: true });
  addEventListener("resize", mark);
  mark();
});
(function () {
  var KEY = "ws-font";
  var CHOICES = [
    ["default", "Page default", null],
    ["new-york", "New York", 'ui-serif, "New York", Charter, Georgia, serif'],
    ["charter", "Charter", 'Charter, "Iowan Old Style", Georgia, serif'],
    ["georgia", "Georgia", "Georgia, serif"],
    ["sf-pro", "SF Pro", "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"],
    ["avenir", "Avenir Next", '"Avenir Next", Avenir, system-ui, sans-serif'],
    ["rounded", "SF Rounded", 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif'],
    ["mono", "SF Mono", 'ui-monospace, "SF Mono", Menlo, monospace']
  ];
  var root = document.documentElement;
  function sizeOf(name) {
    var value = getComputedStyle(root).getPropertyValue(name).trim();
    return value.split(/\s+/)[0];
  }
  var size = { "--font-p": sizeOf("--font-p"), "--font-h": sizeOf("--font-h") };
  function find(id) {
    for (var i = 0; i < CHOICES.length; i++) if (CHOICES[i][0] === id) return CHOICES[i];
    return CHOICES[0];
  }
  function apply(id) {
    var stack = find(id)[2];
    ["--font-p", "--font-h"].forEach(function (name) {
      if (stack && size[name]) root.style.setProperty(name, size[name] + " " + stack);
      else root.style.removeProperty(name);
    });
  }
  function stored() {
    try { return localStorage.getItem(KEY) || "default"; } catch (e) { return "default"; }
  }
  function remember(id) {
    try { localStorage.setItem(KEY, id); } catch (e) {}
  }
  apply(stored());
  function build() {
    if (document.body.classList.contains("ws-deck")) return;
    var bar = document.createElement("div");
    bar.className = "ws-fontpick";
    var label = document.createElement("label");
    label.textContent = "Font ";
    var select = document.createElement("select");
    CHOICES.forEach(function (choice) {
      var option = document.createElement("option");
      option.value = choice[0];
      option.textContent = choice[1];
      select.appendChild(option);
    });
    select.value = find(stored())[0];
    select.addEventListener("change", function () {
      apply(select.value);
      remember(select.value);
    });
    label.appendChild(select);
    bar.appendChild(label);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
