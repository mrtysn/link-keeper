# Instagram direct thread: the data behind the page, 2026-10-15

Second survey of an Instagram direct thread (`/direct/t/<thread_key>/`) by a Claude-in-Chrome agent,
`javascript_tool` only (no scrolling, clicks, keys or focus). The first survey, of the DOM, is
`instagram-survey-2026-10-15.md`. This is what `extension/chat-grab.js` reads: Instagram's Relay store,
which holds every loaded message with its exact time, sender and the shared post's real URL.

The surveyed thread held only the owner's shared reels and posts. Text messages and typed links were
read from other conversations cached on the page (key names and types only); the other person's
messages are assumed to have the same fields with their id in `sender_fbid`, unchecked.

---

## 1. Where the list lives

**Component:** `IGDMessageListBoundaryScrollTriggers.react` (minified `d`).
- It's the grandchild of the scroller: scroller element → its child `div` (`scroller.firstElementChild`) → that div's fiber `.child`.
- Props: `anchor:"bottom"`, `elements[20]`, `hasMoreAbove`, `hasMoreBelow`, `isLoadingAbove`, `isLoadingBelow`, `onLoadMoreAboveExternal`, `onLoadMoreBelowExternal`, `children`.
- `elements` is ordered oldest first. Each entry is `{prevMessage, currentMessage, nextMessage}`; each of those is only a pointer: `{__id:"SlideMessage:mid.$ID", __fragments, __fragmentOwner, id, timestamp_ms, sender_fbid, tombstone_reason, is_tombstone_revealable, client__timestamp_ms, __typename}`.
- From a message article up to this component: 48 fiber steps.
- The component that owns the data is `IGDMessageListOffMsys.react` (minified `f`), 23 steps above; props `threadMessageListRef`, `loadThreadlineQueries`, `isReadOnlyFeatureLimited`; minified hooks, not a useful handle.

**Data store:** the triggers component gets the store from React context as `{environment, getEnvironmentForActor}`.
- Records: `environment.getStore().getSource().get(id)`.
- The thread's message list: `client:XFBIGDirectViewerThread:{thread_fbid}:__IGDMessagesList_slide_messages_connection`.
  - `edges[20]`, newest first. Each edge has `node` (a pointer to the message) and `cursor`.
  - `page_info`: `{has_next_page: true, has_previous_page: false, end_cursor, start_cursor}`.
- 20 `elements`, 20 edges, 20 message records for this thread, 20 DOM rows: the same 20 messages in all four.

```js
function getThreadMessages() {
  const page = o => (o && o.wrappedJSObject) || o;
  const fiberOf = el => { el = page(el); const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k && el[k]; };
  const art = document.querySelector('[role="article"][aria-roledescription="message"]');
  if (!art) return null;
  let t = fiberOf(art);
  while (t && !(t.memoizedProps && Array.isArray(t.memoizedProps.elements) && 'hasMoreAbove' in t.memoizedProps)) t = t.return;
  if (!t) return null;
  let env = null;
  for (let g = t; g && !env; g = g.return)
    for (let c = g.dependencies && g.dependencies.firstContext; c && !env; c = c.next) {
      const v = c.memoizedValue;
      if (v && v.environment && typeof v.environment.getStore === 'function') env = v.environment;
    }
  const src = env.getStore().getSource();
  const msgs = t.memoizedProps.elements.map(e => src.get(e.currentMessage.__id)); // oldest → newest
  const thread = src.get('XFBIGDirectViewerThread:' + msgs[0].thread_fbid);
  return { msgs, thread, src, triggers: t };
}
```

Store records point to others as `{__ref}` and `{__refs:[…]}`; look each up with `src.get(...)`. Clone what you keep. Tested in the page (without `wrappedJSObject`): 20 messages, all resolved. Not run from a Firefox content script.

## 2. One message record (`SlideMessage`)

- `__id` `"SlideMessage:mid.$…"`, `__typename` `"SlideMessage"`
- **`id`** `"mid.$…"`, the message id (same as `message_id`)
- **`sender_fbid`** string, 15 digits
- **`timestamp_ms`** string, 13 digits (e.g. `"1792052129227"`)
- `igd_snippet` (newest message only: the inbox preview line)
- `content` → one of:
  - `SlideMessageText`: `{ text_body }` — **the text**.
  - `SlideMessageXMAContent`: `{ xma →, xma_text_body }`, `xma` one of:
    - `SlideMessagePortraitXMA` (reel): `header_title_text` (author's username), `preview_image →`, `is_quoted`, `eyebrow_text`, `collapsible_id`, `header_icon → {url}`, `header_subtitle_text`, `verified_type`, `target_id` (19 digits), **`target_url`**, `favicon`
    - `SlideMessageStandardXMA` (post): the same plus **`title_text`** (the caption, starting with the author's username), `caption_body_text`, `subtitle_text`, `subtitle_decoration_type`, `cta_buttons[]`, `preview_layout_type`, `preview_extra_urls_info[]`, `overlay_title`, `overlay_description`, `overlay_icon_glyph`
    - `preview_image →`: `{ preview_image_decoration_type: "REEL"|"COLLAGE", url, fallback_url, width, height }`
  - Also seen in the cache: `SlideMessageImageContent`, `SlideMessageRavenImageContent`, `SlideMessageAnimatedMediaContent`, `SlideMessageAdminText`; XMA `SlideMessageExpiredPlaceholderXMA`, `SlideMessagePlaceholderXMA`.
- `content_type`: `"TEXT"`, `"MESSAGE_INLINE_SHARE"`, `"MONTAGE_SHARE_XMA"`, `"IMAGES"`, `"REACTION_LOG_XMAT"`, …
- **`text_body`**: the text for text messages, `""` for shares.
- `thread_fbid` string, 15 digits — **not the URL id**.
- `sender` → `SlideUser { name, id, igid, user_dict → XDTUserDict { username, id, profile_pic_url, interop_messaging_user_fbid, is_verified, full_name, friendship_status, ai_agent_type, fbid_v2 } }`
- Others: `is_reported`, `tombstone_reason`, `is_tombstone_revealable`, `message_id`, `offline_threading_id`, `reactions`, `msg_reactions`, `mentions`, `slide_edit_history`, `bot_response_id`, `is_ai_generated`, `igd_is_forwarded`, `replied_to_message_id`, `replied_to_message`, `is_pinned`, `igd_wearables_attribution_*`, `client__timestamp_ms`, `client__send_status`.

**Mine:** `msg.sender_fbid === thread.viewer.interop_messaging_user_fbid` (checked).

**Reel or post URL:** `content.xma.target_url` = `https://www.instagram.com/reel/SHORTCODE/?id=ID&is_sponsored=…` or `/p/SHORTCODE/?carousel_share_child_media_id=ID_ID&…`. No separate shortCode field; take it from the path. `target_id` does not match the URL's ids: use `target_url`.

**Typed link:** plain text inside `text_body`, no separate field and no `l.instagram.com/?u=` wrapper (only an instagram.com link was cached, so outside sites are unchecked).

## 3. Thread record (`XFBIGDirectViewerThread:{thread_fbid}`)

- `thread_key` equals the URL thread id; `id` and `thread_fbid` are the internal id.
- `thread_title` = the other person's display name; `is_group` false; `viewer_id` = my Instagram id.
- **Other participant:** `users.__refs[0]` → `XDTUserDict { username, full_name, interop_messaging_user_fbid, pk, id, fbid_v2, is_verified, profile_pic_url }`.
- **Viewer:** `viewer` → `XDTUserDict`; `viewer.interop_messaging_user_fbid` equals `sender_fbid` on my messages.

## 4. Loading older messages (found, not called)

- Triggers component: `hasMoreAbove: true`, `isLoadingAbove: false`, `onLoadMoreAboveExternal` (no arguments) — what the top spinner fires.
- Store: `connection.page_info.has_next_page: true` with `end_cursor` ("next" is older: edges are newest first).
- `onLoadMoreBelowExternal` with `hasMoreBelow: false`.

## 5. Samples

Reel (mine):

```json
{
 "__id": "SlideMessage:mid.$ID", "__typename": "SlideMessage",
 "sender_fbid": "ID", "timestamp_ms": "1792052129227", "id": "mid.$ID",
 "content": {
  "__typename": "SlideMessageXMAContent",
  "xma": {
   "__typename": "SlideMessagePortraitXMA",
   "header_title_text": "USERNAME",
   "preview_image": { "preview_image_decoration_type": "REEL", "url": "https://scontent.cdninstagram.com/v/X/X?QUERY", "width": 640, "height": 1136 },
   "verified_type": "NOT_VERIFIED", "target_id": "ID",
   "target_url": "https://www.instagram.com/reel/SHORTCODE/?id=ID&is_sponsored=…&is_ineligible_for_clips_chaining=…"
  },
  "xma_text_body": ""
 },
 "content_type": "MESSAGE_INLINE_SHARE", "text_body": "",
 "message_id": "mid.$ID", "thread_fbid": "ID",
 "sender": { "__typename": "SlideUser", "name": "NAME", "id": "ID", "igid": "ID",
  "user_dict": { "__typename": "XDTUserDict", "username": "USERNAME", "interop_messaging_user_fbid": "ID", "full_name": "NAME" } }
}
```

Collage post `content`:

```json
{
 "__typename": "SlideMessageXMAContent",
 "xma": {
  "__typename": "SlideMessageStandardXMA",
  "header_title_text": "USERNAME",
  "title_text": "USERNAME TEXT",
  "preview_image": { "preview_image_decoration_type": "COLLAGE", "width": 1080, "height": 1351 },
  "caption_body_text": null, "target_id": "ID",
  "target_url": "https://www.instagram.com/p/SHORTCODE/?carousel_share_child_media_id=ID_ID&is_sponsored=…&is_ineligible_for_clips_chaining=…",
  "verified_type": "DEFAULT", "preview_layout_type": "SINGLE"
 },
 "xma_text_body": ""
}
```

The full caption is in `title_text` (124 characters, the same as on the page: not cut short).
