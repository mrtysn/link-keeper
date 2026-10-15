/* The Tags page became the tag row and tag bar on Links in 5.59. A tab pinned on the old address,
 * or a bookmark to it, lands there instead, on the tag it named. */
{
  const tag = new URLSearchParams(location.search).get("tag");
  location.replace(tag ? `list.html?tag=${encodeURIComponent(tag)}` : "list.html?tags");
}
