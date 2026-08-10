# Link Keeper

A Firefox extension that reads the page you are on — title, author, body text and any URLs
embedded in it — and appends it to a local JSONL file on your own machine.

It exists for the case an export cannot solve. A saved `x.com/i/status/123` is a dead link on
paper: no title, no author, nothing, because X shows none of that to an unauthenticated
fetch. Your logged-in browser is the only place that URL means anything, so the capture
happens there.

**Manual trigger only.** Nothing is captured unless you press the hotkey or click the button.
There are no content scripts and no standing site permissions.

## How it fits together

| Path | Role |
|---|---|
| `extension/` | the add-on — `manifest.json`, `background.js`, `extractors.js`, `popup.*` |
| `link-sink.py` | loopback HTTP listener that appends captures to `link-captures.jsonl` |

The extension holds captures in a queue and POSTs them to the sink. If the sink is not
running the queue simply waits, so you can browse first and start the sink later.

## Setup

Requires Firefox 128+ and Python 3.10+. No dependencies.

1. **Start the sink** in whichever directory you want the log to live:

   ```
   ./link-sink.py
   ```

   It prints a token and writes `./link-captures.jsonl`. Leave it running.

2. **Load the extension.** Go to `about:debugging#/runtime/this-firefox` → *Load Temporary
   Add-on* → select `extension/manifest.json`.

   Temporary add-ons unload when Firefox restarts. For a permanent install, submit the
   `extension/` directory to [AMO](https://addons.mozilla.org/developers/) as an unlisted
   add-on and install the signed `.xpi` it gives back. Unsigned permanent installs work only
   in Developer Edition or Nightly with `xpinstall.signatures.required=false`.

3. **Paste the token** into the popup under *Sink settings* → Save. Once only.

## Use

- **`Ctrl+Shift+K`** captures the current page.
- **The toolbar button** does the same and lets you attach a note first.
- **Sweep** takes a list of URLs, opens each in a background tab, reads it, and closes it.
  This is the path for a pile of links you already have.

If the sink is down the badge turns red and captures wait locally; they send themselves once
it is back. *Export queue* writes them out as JSONL to append by hand instead.

## What gets extracted

`extractors.js` is a registry of site handlers with a generic fallback. A handler that
returns nothing degrades to the generic result rather than failing the capture.

| Site | Beyond title and description |
|---|---|
| x.com, twitter.com | author, handle, full tweet text, posted time, quoted tweet, media kinds, embedded links |
| github.com | repo or issue, owner, description, stars, language |
| news.ycombinator.com | the story's own outbound URL, points, submitter |
| youtube.com | channel, description, duration |
| reddit.com | subreddit, author, the post's outbound URL |
| anything else | `og:` tags, JSON-LD, canonical URL, `<h1>`, your text selection |

Adding a site is one object in `REGISTRY`.

`t.co` links are resolved to their destination by the background script — the destination is
usually the reason the tweet was worth keeping.

## Output

One JSON object per line. A tweet capture looks like:

```json
{
  "kind": "tweet",
  "url": "https://x.com/somehandle/status/2009295329057702081",
  "source_url": "https://x.com/i/status/2009295329057702081",
  "status_id": "2009295329057702081",
  "author": { "name": "Some One", "handle": "@somehandle" },
  "text": "A thread about a tool I built. Repo below.",
  "posted": "2026-08-09T14:50:00.000Z",
  "links": [{ "href": "https://t.co/x", "display": "github.com/a/b", "resolved": "https://github.com/a/b" }],
  "media": ["card"],
  "captured_at": "2026-08-10T17:00:00Z"
}
```

`source_url` is kept alongside `url` on purpose: it is what lets a capture be matched back
to a link you saved elsewhere, since `x.com/i/status/<id>` and
`x.com/<handle>/status/<id>` are the same post under different paths. Join on `status_id`.

## Permissions, and why each one

| Permission | Why |
|---|---|
| `activeTab` | read the tab you triggered on — granted per gesture, no standing access |
| `scripting` | inject `extractors.js` into that one tab |
| `http://127.0.0.1/*` | POST to the sink |
| `*://t.co/*` | resolve shortened links |
| `optional_host_permissions` | requested only when you start a sweep, because reading a tab you are not looking at is outside `activeTab`. Revocable in `about:addons` |

No content scripts means the extension has no mechanism for observing pages you did not ask
it about. That is the reason it is trigger-only rather than a watcher.

## Notes

- The background script is an MV3 event page and is suspended when idle. The queue and the
  sweep cursor live in `storage.local` for that reason, and a one-minute alarm resumes a
  sweep that suspension interrupted — a sweep can pause for up to a minute but does not lose
  its place.
- The sink requires its token on every write. Any page you have open could otherwise POST to
  a known loopback port.
- x.com's markup is read through `data-testid` attributes, the most stable handle it
  exposes. If a capture comes back thin, x.com renamed something; `fallback_text` holds the
  visible article text so the capture is still worth keeping, and the fix is one selector.

## Licence

AGPL-3.0. See `LICENSE`.
