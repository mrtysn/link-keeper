/* Explore's old address. Explore became the Links page's detail pane in 5.43, so a bookmark or an
 * open tab of it forwards to Links with the pane on, keeping ?stash=<id> as a one-stash filter. */
const stash = new URLSearchParams(location.search).get("stash");
location.replace(`list.html?pane=1${stash ? `&stash=${encodeURIComponent(stash)}` : ""}`);
