# x.com Chat page survey, 2026-10-15

What a Claude-in-Chrome agent reported about the x.com Chat page (`/i/chat/<id>`), read-only, on the
owner's chat with @muratkun, for `extension/chat-grab.js`. Names, handles, text and media paths are
sanitised (TEXT, HANDLE, ID, IMG). The fixture in section 12 is saved on its own as
`tools/extractor-fixtures/x-chat-window.html`.

Open questions it left: whether scrolling loads older messages (the virtualiser snapped every
programmatic scroll back to the bottom), the format of older day separators, the locked state, and a
plain link in message text.

---

**0. Everything is inside a shadow root.** The chat lives in the open `shadowRoot` of `[data-testid="xchatEmbedRoute"]`. `document.querySelector` won't find any of the selectors below. Start from `R = document.querySelector('[data-testid="xchatEmbedRoute"]').shadowRoot` and query `R`.

**1. URL and header**
- The URL pattern is `/i/chat/<id>`. The id here is two numbers joined by a dash (`<8 digits>-<18 digits>`), which look like two user ids. The id appears nowhere in the DOM, so read it from `location.pathname`.
- **Display name:** text of `R.querySelector('[data-testid="dm-conversation-username"] > div > div:first-child')`.
- **Handle:** no `@handle` text appears anywhere. Take it from the path of the link wrapping the avatar: `[data-testid="dm-conversation-header"] a[href^="https://x.com/"]`. It sits next to the back button, `[data-testid="dm-conversation-back-button"]`.

**2. Scroller:** `[data-testid="dm-message-scroller"]` (`role="log"`, `aria-label="Messages"`, `data-virtualizer="tanstack"`). Its third child holds the items and has an inline `height`. Above it is a "Loading messages" spinner, `[data-testid="dm-message-list-spinner-slot"]`.
- **Not confirmed that scrolling loads older messages.** Every scroll I tried snapped back to the bottom: setting `scrollTop`, `scrollTo`, real mouse-wheel events, and Page Up. I traced the snapping to the virtualizer's own `scrollToFn`, which keeps calling `scrollTo({top: bottom})`.
- The data is already in memory: a React component above the scroller has a `chatItems` prop with 186 entries. Their field names are minified (`mfl_1`, `fed_1`…), so they're unlikely to stay stable.

**3. Virtualisation:** yes. Only 13 of 186 items are in the DOM (`data-index` 173–185). Each is absolutely positioned with `transform: translate3d(0px, Npx, 0px)`. Because I couldn't scroll, I didn't see items being removed. The index range makes it clear, though.

**4. Messages**
- **Every item:** `[data-dm-item-key]`, which includes the separators.
- **Messages only:** `[data-dm-message-row]`.
- **Stable id:** `data-dm-message-row="<uuid>"`. The same uuid appears in `data-testid="message-<uuid>"` and in the wrapper's `data-dm-item-key`.
- `data-index` is only a position and will shift when older items load.
- Each row also has `data-send-status="sent"`.

**5. Me vs them** (any of these works):
- `[data-side="end"]` is me, `[data-side="start"]` is them. It sits inside `[data-dm-message-focus-target]`.
- The hidden span `span[id$="-sender"]` says `You` for me and their display name for them.
- The row's class contains `justify-end` for me and `justify-start` for them.
- The inline grid layout is `"content avatar"` for me and `"avatar content"` for them.

**6. Time**
- There is no `<time>` element and no datetime value.
- Each row has hidden spans `span[id$="-time"]` (e.g. `5:07 PM`, `3:49 PM`) and `span[id$="-kind"]` (all here say `Attachment`). The row's `aria-labelledby` points at the kind, sender and time spans.
- On hover, a pill tooltip shows `Today 5:59 PM`.
- **Separators:** `[data-dm-item-key^="dateBoundary-"]`, where the key is `dateBoundary-<uuid of the next message>`. Their text is `<day> <time>`: `Tuesday 5:45 PM`, `Today 12:29 PM`.
- Separators mark time gaps, not day changes: there were three `Today …` separators.
- The message's own time has no day. Take the day from the nearest separator above it. I didn't see the format for older days or years.
- The time inside a post card is the post's own relative time (`7h`, `Oct 2`), not the message's.

**7. Shared post card:** the main link is `[data-side] a[href*="/status/"]` (a video post links to `/status/<id>/video/1`).
- **Author name:** text of `a[href^="https://x.com/"][target="_blank"]` inside `div[id^="base-ui-"]`.
- **Handle:** that link's path. No @ text is shown.
- **Verified badge:** `span[aria-label="Verified account"]`.
- **Post time:** `div[id^="_xchat-embed-r_"]` in the header.
- **Text:** `span[dir="auto"]`. Mentions are `a[id^="base-ui-"][href="https://x.com/HANDLE"]` and hashtags are `a[href^="https://x.com/hashtag/"]`.
- **Quoted post:** a second `a[href*="/status/"]`, a sibling of the first link (not nested inside it).
- **Readable data in React:** the props on the card's React component include `screenName`, `name`, `createdAt` (epoch ms), `text`, `url`, `entities`, `card` and `quotedTweet{author{name,screenName},createdAt,text,url}`. Firefox can reach them through `el.wrappedJSObject`'s `__reactFiber$…` property, about 15 `.return` steps up from the text link.

**8. Plain links:** I didn't see a link in message text. Links inside post text are `https://t.co/…` with `rel="noopener noreferrer"`, and their text is a cut-off display address (`domain.com/path…`). They have no title or data attribute. The React entity only has `{displayUrl, kind:"TextEntity.Url", url:<t.co>}`, so the real address is not in the page.

**9. Link preview card (my message):** `[data-side] > a[href]` holds the **real URL**, not t.co. Inside is an `svg[data-icon="icon-link"]` followed by the domain as text.

**10. Passcode lock:** I couldn't see this state. The page has a `[data-testid="paywallScrim"]`, but it was invisible (opacity 0).

**11. Samples** — classes removed except where noted; SVG `d` values replaced with `D`. The only meaningful class is `justify-start`/`justify-end` on the row (full: `relative flex w-full px-4 py-1 justify-start`).

Mine (a link card):

```html
<div data-dm-message-row="2a4f6bd0-e8a1-4f8f-a929-b3794b0bb041" data-testid="message-2a4f6bd0-e8a1-4f8f-a929-b3794b0bb041" data-send-status="sent"><div aria-hidden="true"></div><span hidden="" id="_xchat-embed-r_1e9_-sender">TEXT</span><span hidden="" id="_xchat-embed-r_1e9_-time">TEXT</span><span hidden="" id="_xchat-embed-r_1e9_-kind">TEXT</span><div style="grid-template-areas: &quot;content avatar&quot; &quot;message-info .&quot;;"><div style="grid-area: avatar;"></div><div style="grid-area: content;"><div tabindex="-1" data-dm-message-focus-target="2a4f6bd0-e8a1-4f8f-a929-b3794b0bb041:attachment" role="group" aria-labelledby="_xchat-embed-r_1e9_-kind _xchat-embed-r_1e9_-sender _xchat-embed-r_1e9_-time"><div data-side="end"><a href="https://www.reddit.com/PATH" target="_blank"><div><svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" data-icon="icon-link" viewBox="0 0 24 24" width="1em" height="1em" display="flex" role="img" aria-hidden="true"><path d="D"></path></svg></div><div><div>TEXT</div></div></a></div></div></div></div></div>
```

Theirs (a shared post card; a quote-post card with t.co links is item 182 in the fixture):

```html
<div data-dm-message-row="074de86e-dce5-422c-b9cf-d1bcc2f44b30" data-testid="message-074de86e-dce5-422c-b9cf-d1bcc2f44b30" data-send-status="sent"><div aria-hidden="true"></div><span hidden="" id="_xchat-embed-r_17t_-sender">TEXT</span><span hidden="" id="_xchat-embed-r_17t_-time">TEXT</span><span hidden="" id="_xchat-embed-r_17t_-kind">TEXT</span><div style="grid-template-areas: &quot;avatar content&quot; &quot;. message-info&quot;;"><div style="grid-area: avatar;"></div><div style="grid-area: content;"><div tabindex="-1" data-dm-message-focus-target="074de86e-dce5-422c-b9cf-d1bcc2f44b30:attachment" role="group" aria-labelledby="_xchat-embed-r_17t_-kind _xchat-embed-r_17t_-sender _xchat-embed-r_17t_-time"><div data-side="start"><div><a href="https://x.com/HANDLE/status/ID/video/1" target="_blank"><div><div><img draggable="false" alt="user avatar" decoding="async" loading="lazy" sizes="16px" srcset="SRCSET" src="https://pbs.twimg.com/profile_images/IMG"></div><div><div id="base-ui-_xchat-embed-r_17v_"><div><a href="https://x.com/HANDLE" target="_blank">TEXT</a><div><div><div><span role="button" tabindex="0" aria-label="Verified account" type="button" aria-haspopup="dialog" aria-expanded="false" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" data-icon="icon-verified" viewBox="0 0 22 22" width="1em" height="1em" display="flex" role="img" aria-hidden="true"><path d="D"></path></svg></span></div></div></div></div></div><div></div><div><span><div id="_xchat-embed-r_181_">TEXT</div></span></div></div></div><div><div><div><span dir="auto"><span>TEXT</span></span></div></div><div><div><div><video src="https://video.twimg.com/amplify_video/VIDEOID/vid/avc1/1280x720/FILE.mp4?QUERY" autoplay="" loop="" playsinline=""></video></div></div></div></div></a></div></div></div></div></div></div>
```

Day separator (with classes):

```html
<div data-index="176" data-dm-item-key="dateBoundary-0fdb7fe2-e307-410c-b4c9-165cf8073b46" class="absolute top-0 left-0 w-full" style="transform: translate3d(0px, 27973px, 0px);"><div class=""><div class="mt-4 mb-2 flex items-center justify-center"><div class="max-w-full text-subtext2 font-medium text-secondary text-center">TEXT</div></div></div></div>
```

**12. Fixture:** the whole rendered window — 8 messages (one mine) and 5 separators — in
`tools/extractor-fixtures/x-chat-window.html`.

The agent also left `window.__*` helper variables and scroll and wheel listeners on the page (a reload
clears them), and typed `Page_UpPage_UpPage_Up` into the composer by accident: Page Up went to the
message box, not the list. Nothing was sent.
