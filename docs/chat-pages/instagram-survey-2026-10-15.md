# Instagram direct thread page survey, 2026-10-15

What a Claude-in-Chrome agent reported about an Instagram direct thread (`/direct/t/<id>/`), read-only,
for `extension/chat-grab.js`. Names, text and image paths are sanitised (USERNAME, TEXT, PATH). The
agent's stitched fixture is `tools/extractor-fixtures/ig-thread-window.html` once saved there.

Open questions it left: the other person's side (all 20 loaded messages were the owner's), a plain
typed link, whether scrolling up loads older messages (nothing loaded in about 10 seconds at the top),
and the separator format for older days.

---

**1. URL and header**
- URL pattern: `https://www.instagram.com/direct/t/{threadId}/` (numeric id). The thread id is only in the URL; no attribute in the DOM contains it.
- Header link: `main a[role="link"][aria-label^="Open the profile page of "]`.
  - Username: the part of `aria-label` after that prefix, or `href="/USERNAME/"`.
  - Display name: `h2[dir="auto"] span[title]`. The `title` attribute holds the name.
  - The username also appears as text in a `span[dir="auto"]` under the `h2`.

**2. Scroll container**
- It has no role, aria or data attributes. Find it by computed style: a `div` inside `main` with `overflow-y: auto|scroll` and `flex-direction: column-reverse`.
- An easier way: from any `[role=article][aria-roledescription=message]`, walk up `parentElement` until `getComputedStyle(el).flexDirection === 'column-reverse'`.
- Layout: scroller > `div` > [list `div`, empty `div`]. List children are rows, oldest first. The first child is the spinner (`[role=progressbar]`, svg `aria-label="Loading..."`).
- `scrollTop` is `0` at the newest message and goes negative as you scroll up.
- Not confirmed: whether scrolling up loads older messages. The spinner at the top looks like the trigger, but nothing loaded here.

**3. Virtualisation: yes, off-screen content is removed**
- The row element itself stays (the list kept 21 children throughout).
- The row's content is swapped for `<div><div style="height: 416px;"></div></div>`. The last row went from 53 descendants to 1, and its article was detached from the page.
- Only about 3 rows are rendered at a time. Scrolling back re-renders them with new `_r_…` ids.
- Rows only render when the page actually paints. Setting `scrollTop` while the tab wasn't painting left the rows as placeholders. Use a `MutationObserver` on the list and collect rows as they appear.

**4. Message selector and id**
- Selector: `[role="article"][aria-roledescription="message"]`. It matches messages only.
- Row: the list child that contains it. Rows have no attributes at all.
- There is no stable id in the DOM. `aria-labelledby` / `id` (like `_r_4n_`) are React `useId` values and change on re-render.
- A stable id exists in React props. About 17 `.return` steps up the fiber from the article, the props are `{messageBubble, outgoing, slideMessageRef, threadRef, userRef}`.
  - `slideMessageRef.id` = `"mid.$cAAA…"` (also `__id: "SlideMessage:mid.$…"`).
  - The fiber key is on the element and starts with `__reactFiber$`.
  - In a Firefox content script, read it through `el.wrappedJSObject`.

**5. Mine vs. theirs**
- DOM: the hidden action buttons are present even without hover, e.g. `[aria-label^="Reply to message from "]` (also "React to…" and "See more options for…"). On my messages the suffix is my own username.
- Layout: my bubbles are right-aligned (their right edge is about 31 px from the scroller's right edge).
- React: `outgoing: true`, and `slideMessageRef.sender_fbid` equals `threadRef.viewer.interop_messaging_user_fbid`.
- Their messages are expected to show their username and sit on the left, but this was not checked.

**6. Time**
- There is no `<time>`, `title` or time `aria-label`, and hovering showed no tooltip (`[role=tooltip]`). Only the separators carry a time.
- A separator sits in the row, before `div[role=group]` and outside the article: `span[dir="auto"]` with no article ancestor.
- Formats seen: `Mon 2:53 PM` (weekday within the past week) and `11:14 AM` (today). There's a U+202F narrow no-break space before AM/PM. No date format for older messages was seen.
- Not every row has a separator.
- An exact time per message is only in React: `slideMessageRef.timestamp_ms` (a string). Example: `"1792052129227"` = Thu 15 Oct 2026 11:15:29 +03:00, for the message under the `11:14 AM` separator.

**7. Shared reel or post**
- The article contains a `div[role=button]` with:
  - the author header: avatar `img` 35×35, `a[href="/USERNAME/"]`, and an optional `svg[aria-label="Verified"]`;
  - the preview `img` (200 wide) and `svg[aria-label="Clip"]`.
- There is no `/reel/` or `/p/` href anywhere in the DOM. The URL is in React props on that button, about 4 fiber steps up: `{isReel, shortCode, targetId, targetUrl}`.
  - Example: `targetUrl = https://www.instagram.com/reel/SHORTCODE/?id=…&is_sponsored=…&is_ineligible_for_clips_chaining=…`.
- Reels: no caption in the DOM.
- Multi-image posts (`svg[aria-label="Collage"]`, 300 wide): the author header sits outside the button. The caption is a `span` styled `-webkit-line-clamp: 3` and starts with the author's username. Here it held 124 characters; whether Instagram cuts longer captions is unknown.

**8. Typed links:** none in the loaded messages, so whether the href is `l.instagram.com/?u=…` or the real address is unknown.

**9. Samples** — `class` removed; svg path `d` shortened to `D`; `img src` reduced to host + `/v/PATH.jpg`; `_r_…` ids, styles and separator times kept.

Mine (reel, no separator):

```html
<div><div style="opacity: 1;"><div><div role="group" tabindex="-1"><div><div><div><div aria-labelledby="_r_4n_" aria-roledescription="message" role="article" tabindex="0"><div id="_r_4n_" role="none"><div role="none"><div><div role="button" tabindex="0"><div style="--x-width: 100%;"><img height="35" width="35" alt="" referrerpolicy="origin-when-cross-origin" src="https://scontent.cdninstagram.com/v/PATH.jpg"><div><div><a href="/USERNAME/" role="link" tabindex="0"><span dir="auto" style="--x---base-line-clamp-line-height: 18px; --x-lineHeight: 18px;"><span>USERNAME</span></span></a></div></div></div><div style="--x-width: 100%;"><img height="355.55555555555554" width="200" alt="" referrerpolicy="origin-when-cross-origin" src="https://scontent.cdninstagram.com/v/PATH.jpg"><div><svg aria-label="Clip" fill="currentColor" height="24" role="img" viewBox="0 0 24 24" width="24"><title>Clip</title><path d="D"></path></svg></div></div><div role="none" data-visualcompletion="ignore"></div></div></div></div></div></div><div style="--x-width: 96px;"><div aria-label="Message actions" data-igd-message-actions-hidden="true" role="group"><div><span aria-describedby="_r_4o_"><div><div aria-expanded="false" aria-haspopup="dialog" aria-label="React to message from USERNAME" role="button" tabindex="0"><div><svg aria-label="React to message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>React to message from USERNAME</title><path d="D"></path></svg></div></div></div></span><span aria-describedby="_r_4p_"><div><div aria-label="Reply to message from USERNAME" role="button" tabindex="0"><div><svg aria-label="Reply to message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>Reply to message from USERNAME</title><path d="D"></path></svg></div></div></div></span><span aria-describedby="_r_4q_"><div><div aria-expanded="false" aria-haspopup="menu" aria-label="See more options for message from USERNAME" role="button" tabindex="0"><div><svg aria-label="See more options for message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>See more options for message from USERNAME</title><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="6" r="1.5"></circle><circle cx="12" cy="18" r="1.5"></circle></svg></div></div></div></span></div></div></div></div><div style="--x-width: 16px;"><div></div></div></div></div></div></div></div></div>
```

Shared post with caption (mine):

```html
<div><div style="opacity: 1;"><div><div role="group" tabindex="-1"><div><div><div><div aria-labelledby="_r_63_" aria-roledescription="message" role="article" tabindex="0"><div id="_r_63_" role="none"><div role="none"><div><div><div style="--x-width: 100%;"><img height="35" width="35" alt="" referrerpolicy="origin-when-cross-origin" src="https://scontent.cdninstagram.com/v/PATH.jpg"><div><div><a href="/USERNAME/" role="link" tabindex="0"><span dir="auto" style="--x---base-line-clamp-line-height: 18px; --x-lineHeight: 18px;"><span>USERNAME</span></span></a><div><svg aria-label="Verified" fill="currentColor" height="14" role="img" viewBox="0 0 40 40" width="14"><title>Verified</title><path d="D" fill-rule="evenodd"></path></svg></div></div></div></div><div role="button" tabindex="0"><div style="--x-width: 100%;"><img height="375.27777777777777" width="300" alt="" referrerpolicy="origin-when-cross-origin" src="https://scontent.cdninstagram.com/v/PATH.jpg"><div><svg aria-label="Collage" fill="currentColor" height="24" role="img" viewBox="0 0 48 48" width="24"><title>Collage</title><path d="D"></path></svg></div></div><div style="--x-width: 100%;"><div style="--x-width: 100%;"><span dir="auto" style="--x---base-line-clamp-line-height: 16px; --x-lineHeight: 16px;"><span style="-webkit-box-orient: vertical; -webkit-line-clamp: 3; display: -webkit-box;">USERNAME TEXT</span></span></div></div><div role="none" data-visualcompletion="ignore"></div></div></div></div></div></div></div><div style="--x-width: 96px;"><div aria-label="Message actions" data-igd-message-actions-hidden="true" role="group"><div><span aria-describedby="_r_64_"><div><div aria-expanded="false" aria-haspopup="dialog" aria-label="React to message from USERNAME" role="button" tabindex="0"><div><svg aria-label="React to message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>React to message from USERNAME</title><path d="D"></path></svg></div></div></div></span><span aria-describedby="_r_65_"><div><div aria-label="Reply to message from USERNAME" role="button" tabindex="0"><div><svg aria-label="Reply to message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>Reply to message from USERNAME</title><path d="D"></path></svg></div></div></div></span><span aria-describedby="_r_66_"><div><div aria-expanded="false" aria-haspopup="menu" aria-label="See more options for message from USERNAME" role="button" tabindex="0"><div><svg aria-label="See more options for message from USERNAME" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16"><title>See more options for message from USERNAME</title><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="6" r="1.5"></circle><circle cx="12" cy="18" r="1.5"></circle></svg></div></div></div></span></div></div></div></div><div style="--x-width: 16px;"><div></div></div></div></div></div></div></div></div>
```

Time separator (start of a row; the message's `div[role=group]` follows as its sibling):

```html
<div><div style="opacity: 1;"><div><div><div><span dir="auto" style="--x---base-line-clamp-line-height: 16px; --x-lineHeight: 16px;">Mon 2:53 PM</span></div></div><div role="group" tabindex="-1">…</div></div></div></div>
```

Off-screen row placeholder:

```html
<div><div style="height: 416px;"></div></div>
```

**10. Fixture** — attached in the agent's panel as `ig-thread-fixture.html` (29 KB): scroller > `div` > list [spinner row, rows 1–10, placeholder rows 11–20] + empty `div`; 8 time separators, Verified and non-Verified authors, all reels, real ids, image and placeholder heights. Stitched from rows captured one at a time (about 3 render at once), each checked against the live page. Rows are separated by line breaks; strip them with `.replace(/>\s+</g,'><')`. The scroller has no attributes, so tests should find it structurally rather than by computed style.
