/* Stand-in for a stashed tab Firefox will not let an extension open: an about: page, another
 * extension's page, or a local file the helper could not open. It carries the tab's title, so the
 * tab strip still reads right, and hands over the URL to paste into the address bar. */

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const url = params.get("url") || "";
const title = params.get("title") || "";
const why = params.get("why") || "";

document.title = title || url;
$("title").textContent = title || url.replace(/^[a-z-]+:\/\/\/?/, "");
$("url").textContent = url;

if (why) {
  $("why").hidden = false;
  $("why").append(`Link Keeper could not reopen this local file itself: ${why}.`);
  if (/not installed/.test(why)) {
    $("why").append(" Run ", Object.assign(document.createElement("code"), { textContent: "native/install.zsh" }),
      " in the link-keeper repo once, and restores will open local files directly.");
  }
}

$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(url);
    $("copy").textContent = "Copied";
  } catch (e) {
    getSelection().selectAllChildren($("url"));
    $("copy").textContent = "Press ⌘C";
  }
  setTimeout(() => ($("copy").textContent = "Copy URL"), 1500);
};
