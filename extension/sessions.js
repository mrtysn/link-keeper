/* The Stashed tabs page became the List page grouped by stash in 5.14. A tab pinned on the old
 * address, or a bookmark to it, lands there instead. */
location.replace(`list.html?group=stash${location.hash}`);
