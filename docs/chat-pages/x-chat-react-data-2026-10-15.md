# x.com Chat: the React data behind the page, 2026-10-15

Second survey of the x.com Chat page (`/i/chat/<id>`) by a Claude-in-Chrome agent, read through
`javascript_tool` only (no scrolling, keys or focus), after a reload. The first survey, of the DOM, is
`x-chat-survey-2026-10-15.md`. This one is what `extension/chat-grab.js` reads: the page's own
message objects, which carry exact times, senders and real URLs, so no scrolling or screen reading.

Class names (`BO`, `FD`, `j2`…) are minified and change between builds. Field names marked readable are
real getters on the objects: more stable, still undocumented.

---

After the reload, `chatItems` holds **80 entries, not 186**. It covers only the last few weeks, so it is **not the whole chat**.

**1. Path to chatItems**

From the scroller, take its `__reactFiber$…` property and go **1 `.return` step**. That fiber is function component `j2` (no displayName). The array is `memoizedProps.chatItems`, a real JS Array. The same fiber's other props are `component, headerHeight, topChromeHeight, footerHeight, onVisibleMessagesChanged, renderItem, header, footer, spinnerRef, focusedRowIdRef, canCallBack`.

```js
function getChatFiber() {
  const host = document.querySelector('[data-testid="xchatEmbedRoute"]');
  const S = host?.shadowRoot?.querySelector('[data-testid="dm-message-scroller"]');
  if (!S) return null;
  const w = S.wrappedJSObject || S;                       // Firefox content script
  const k = Object.keys(w).find(k => k.startsWith('__reactFiber$'));
  for (let f = w[k], i = 0; f && i < 10; f = f.return, i++)
    if (f.memoizedProps && f.memoizedProps.chatItems) return f;
  return null;
}
const getChatItems = () => getChatFiber()?.memoizedProps.chatItems ?? null;
// Load state is also on the view-model:
// getChatFiber().memoizedProps.component.state.state.chatItems
//   → { items, olderItemsInfo:{maxSequenceNum, localPaginationMaxSeqNum}, isLoading, hasOlderItems, didPullFail, pullFailureReason, … }
```

**2. Coverage**
- **Count:** 80 entries: 30 separators, 46 received messages, 4 sent messages.
- **Date range:** first entry `2026-09-25T11:34:41.912Z` (a separator), last `2026-10-15T14:59:31.771Z`.
- **Older messages exist:** `state.chatItems.hasOlderItems === true` and `isLoading === false`. More pages have to be loaded to reach 2026-08-25.
- **Time in ms:**

```js
const ms = c => c.epochSeconds * 1000 + Math.floor(c.nanosecondsOfSecond / 1e6); // c = item.created
```

**3. Entry shapes**

Every entry has the readable getters `id`, `created`, `sequenceNumber`, `contentType` and `sequenceNumberForReadState`.

*Separator* (class `FD`, `contentType: "informational"`):
- `id`: string `"dateBoundary-<uuid of the next message>"`.
- `created`: `E_ {epochSeconds:number, nanosecondsOfSecond:number}`.
- `sequenceNumber`: `null`.
- `contents`: `KD {newDate: oO {date: T_ {year, month, day, localDate}, instant: E_ {epochSeconds, nanosecondsOfSecond}}, showTime: boolean, shouldAffectRead: boolean}`.

*Message* (class `BO` received, `WO` sent; both have the same getters, except `encryptedMetadata` is only on BO):

| key | type | meaning |
|---|---|---|
| `id` | string(36) | **message uuid**, equal to `data-dm-message-row` |
| `created` | `E_ {epochSeconds, nanosecondsOfSecond}` | **sent time**: use `ms()` above. `messageInfo.showTimestamp` holds the same value |
| `senderInfo.userId` | `$m {userId: bigint, userIdString: string, isLoggedIn, isLoggedOut, isRegularUser}` | **sender's user id** |
| `senderInfo.user` | `zb {id, screenName, name, displayName, formattedScreenName, profileImageUrl, verifiedType, isVerified, …}` | sender's profile |
| `alignsToViewerSide` | boolean | **true = mine** |
| `contentType` | string | also shows direction: `"ReceivedMessageAttachmentOnly"`, `"SentMessageAttachmentOnly"` |
| `textContent` / `fullText` | string or null | **message text** (null on every loaded entry) |
| `textEntities` | `no {…}` | entities in the message text (empty here) |
| `isTextOnly` | boolean | text-only message |
| `attachment` | `_k` (post) or `fk` (link card) | **the attachment** |
| `attachments` | Kotlin list `ui`, read with `.toArray()` | holds the same object as `attachment` |

Other keys:
- **Simple values:** `isEncrypted`, `isUndecryptable`, `isGrokMessage`, `usesCreatorBubbleStyle`, `showGrokAttribution` (bool); `senderDisplayName` (null).
- **Enums:** `avatarDisplayMode` is `QO {name: "None", ordinal}`; `burstState` is `jO {name: "Solo", ordinal}`.
- **Sequence numbers:** `sequenceNumber` and `sequenceNumberForReadState` are `Ib {num: bigint, str}`.
- **messageInfo:** `tk {readStatus (null for theirs, an object for mine), showTimestamp, showEdited, timeToLive}`.
- **Kotlin lists:** `editHistory`, `reactions`, `ctas`, `userSentReactionEmoji`.
- **Always null in this range:** `replyPreview`, `forwardedMessage`, `quickReply`, `avCallCard`, `grokReply`, `supersizeEmoji`, `grokBot`, `contentsEncryptionVersion`, `encryptedMetadata`.
- **Minified-only:** `hiddenState`.

**4. Attachments**

*Shared post*, `attachment` class `_k`:
- `postId: Um {value: bigint, str}`
- `url`: `"https://x.com/HANDLE/status/ID"` — the status URL, there even when the post isn't loaded.
- `displayUrl`: `"x.com"`; `messageId`
- `postState.post`: class `AM`, or `null`. In four entries `postState` was class `wb {id}`: the post was not loaded or not available.

Inside `post` (`AM`):
- **Post fields:** `url`, `text`, `createdAt: E_ {epochSeconds, nanosecondsOfSecond}`, `id: Um`, `language`, `media`, `legacyCard`, `article`.
- **Author:** `author.screenName`, `author.name`, `author.id.userIdString`.
- **Display range:** `displayTextRange {startIdx, endIdx}`.
- **Entities:** `entityList {mentions, urls, media, hashtags, cashtags, timestamps, postEntities}`.
- **Links:** each `entityList.urls.toArray()[i]` has **`expandedUrl` (the real address)**, plus `url` (t.co), `displayUrl`, `startIdx`, `endIdx`.
- **Quoted post:** `post.displayQuotedPost` is another `AM` with the same shape, or `null`.
- **Not readable:** `post.canonicalPost` only has minified keys.

*Link card*, `attachment` class `fk`:
- `urlToOpen`: **the real URL** (also `source.urlToOpen`).
- `displayTitle` (null in this card), `displayHostname`.
- `source: Tk {displayHostname, displayTitle, urlToOpen, bannerImageSource, faviconImageSource}`.
- `bannerImage`, `faviconImage`, `showTapToLoadPrompt`, `id: Xw {id}`, `messageId`.

*Plain text with a link*: none of the 80 loaded entries has text. The best guess is `textEntities`, unverified.

**5. Other participant**

`state = getChatFiber().memoizedProps.component.state.state`:
- **Profile:** `state.toolbarState.otherParticipant` is `fw {conversationId, userId: $m, user: zb, isAdmin, isCurrentMember, lastSeenSequenceNumber, …}`. Read `user.screenName`, `user.name`, `userId.userIdString`.
- **Header title:** `state.toolbarState.title` is their name.
- **Conversation id:** `state.convId.id` is `"<theirId>:<myId>"`, the URL id with `:` in place of `-`.
- **Both ids:** `state.convId.userIds.toArray()`.
- **From any received message:** `senderInfo.user` gives the same profile.

**6. Loading older messages**
- **No such function prop** (`loadMore`, `fetchOlder`, `onReachTop`, `hasMore`…) on `j2` or above.
- **The trigger** is a hook-stored callback inside `j2`:

```js
()=>{ C2(r, o.current) && (o.current = r, e.onEvent(new Y.ScrolledToTop(r))) }
```

  `e` is the `component` prop (`S7`, which has `onEvent`); `r` is probably `olderItemsInfo`.
- **Where:** held in a ref at hook #24 of `j2.memoizedState`; hook #26 holds a stable wrapper, `[ (...e)=>t.current(...e), … ]`. Probably fired by the virtualizer at the top or the spinner (unconfirmed). Not called. Hook positions are fragile.
- **Flags:** `state.chatItems.hasOlderItems`, `state.chatItems.isLoading`, `state.chatItems.olderItemsInfo`.

**7. Samples** (getters evaluated; classes as `$class`; lists show their first item)

Message with a shared post (received):

```json
{"$class":"BO","id":"UUID","created":{"$class":"E_","epochSeconds":1792067608,"nanosecondsOfSecond":954000000},
 "senderInfo":{"$class":"AO","userId":{"$class":"$m","userId":"bigint:ID","isLoggedOut":false,"isLoggedIn":true,"userIdString":"ID","isRegularUser":true},
   "user":{"$class":"zb","id":{"$class":"$m"},"screenName":"HANDLE","name":"NAME","profileImageUrl":"https://pbs.twimg.com/PATH","verifiedType":{"$class":"eh"},"isVerified":false},
   "grokBot":null,"isSubscriberChatCreator":false},
 "attachments":{"$list":1,"items":["(same object as attachment)"]},
 "isEncrypted":true,"contentType":"ReceivedMessageAttachmentOnly","isUndecryptable":false,
 "textContent":null,"fullText":null,"textEntities":{"$class":"no"},
 "attachment":{"$class":"_k","postId":{"$class":"Um","value":"bigint:ID","str":"ID"},"url":"https://x.com/HANDLE/status/ID","displayUrl":"x.com","messageId":"UUID","id":{"$class":"Xw","id":"UUID"},
   "postState":{"$class":"Cb","post":{"$class":"AM","id":{"$class":"Um","value":"bigint:ID","str":"ID"},"url":"https://x.com/HANDLE/status/ID","text":"TEXT",
     "createdAt":{"$class":"E_","epochSeconds":1792053747,"nanosecondsOfSecond":0},"displayTextRange":{"$class":"Zv","startIdx":0,"endIdx":103},
     "author":{"$class":"Dy","id":{"$class":"$m","userIdString":"ID"},"screenName":"HANDLE","name":"NAME","isVerified":true},
     "entityList":{"$class":"$v","mentions":{"$list":0},"hashtags":{"$list":0},"cashtags":{"$list":0},"timestamps":{"$list":0},
       "urls":{"$list":1,"items":[{"$class":"sy","displayUrl":"TEXT","expandedUrl":"https://www.youtube.com/PATH","url":"https://t.co/XXXX","startIdx":80,"endIdx":103}]},
       "media":{"$list":1,"items":[{"$class":"ly","id":"ID","displayUrl":"TEXT","expandedUrl":"https://x.com/HANDLE/status/ID/photo/1","url":"https://t.co/XXXX","startIdx":104,"endIdx":127}]},
       "postEntities":{"$list":2}},
     "media":{"$list":1,"items":[{"$class":"j_","imageUrl":"https://pbs.twimg.com/PATH","altText":null,"mediaId":"ID"}]},
     "legacyCard":null,"language":"en","article":null,
     "displayQuotedPost":"AM — same shape as post, or null"}}},
 "alignsToViewerSide":false,"senderDisplayName":null,"encryptedMetadata":null}
```

Message with a link card (mine):

```json
{"$class":"WO","id":"UUID","created":{"$class":"E_","epochSeconds":1792068589,"nanosecondsOfSecond":25000000},
 "senderInfo":{"$class":"AO","userId":{"$class":"$m","userIdString":"ID"},"user":{"$class":"zb","screenName":"HANDLE","name":"NAME"}},
 "contentType":"SentMessageAttachmentOnly","alignsToViewerSide":true,"isTextOnly":false,"textContent":null,"fullText":null,
 "attachment":{"$class":"fk",
   "source":{"$class":"Tk","displayHostname":"www.reddit.com","displayTitle":null,"urlToOpen":"https://www.reddit.com/PATH","bannerImageSource":null,"faviconImageSource":null},
   "displayHostname":"www.reddit.com","displayTitle":null,"urlToOpen":"https://www.reddit.com/PATH",
   "bannerImage":null,"faviconImage":null,"showTapToLoadPrompt":false,"id":{"$class":"Xw","id":"UUID"},"messageId":"UUID"}}
```

Separator:

```json
{"$class":"FD","id":"dateBoundary-UUID","contentType":"informational","sequenceNumber":null,"sequenceNumberForReadState":null,
 "created":{"$class":"E_","epochSeconds":1790336081,"nanosecondsOfSecond":912000000},
 "contents":{"$class":"KD","showTime":true,"shouldAffectRead":false,
   "newDate":{"$class":"oO","date":{"$class":"T_","year":2026,"month":9,"day":25,"localDate":{"$class":"a_"}},
              "instant":{"$class":"E_","epochSeconds":1790336081,"nanosecondsOfSecond":912000000}}}}
```

Firefox notes:
- **Reading:** the getters run page code through `wrappedJSObject`. Copy the values into plain objects (or use `cloneInto`) before passing them to extension code.
- **Bigints:** `userId` and `sequenceNumber.num` are bigints. Use `userIdString` or `.str` instead.
- **Kotlin lists:** read them with `.toArray()`.
