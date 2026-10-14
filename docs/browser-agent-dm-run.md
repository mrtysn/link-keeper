# Browser-agent run: links from Instagram or X DMs

For an agent driving the owner's logged-in Chrome (claude-in-chrome) to collect links from DM threads
when an export or archive will not do. **This is a fallback.** The baseline is the Instagram "Download
your information" export (`importers/instagram.py`) and the X data archive; they are free and carry no
account risk. Use this brief only when the owner has asked for a browser run for this exact job.

## Before anything runs

All of these must hold. If one does not, stop and ask the owner; do not work around it.

1. **The owner approved this run in this session**, naming the account, the platform and the threads.
   An earlier run's approval does not carry over.
2. **A page count was stated and approved first.** Count one page load or one scroll that fetches new
   messages as a request. Say the number before the first one ("about 40 requests to instagram.com
   for account main"). Tens against one site within an hour is already too many.
3. **The account is already logged in** in the Chrome the agent drives. Never type, fill or ask for a
   password, a code or a recovery answer.
4. **The threads are named.** Read only the named threads. Never open the inbox list to "see what is
   there" beyond finding the named ones.

## Pace and stopping

- One thread at a time, one scroll at a time, and wait a few seconds between actions, as a person
  reading would. Never run threads in parallel and never open a second tab on the same site.
- **The first refusal ends the run.** A captcha, a "suspicious activity" or "try again later" notice, a
  login wall, a rate-limit message, a 429 or 403 seen in the network log, or any consent wall: stop,
  report what was done and how many requests it took, and do nothing else on that site. No retry, no
  other tab, no other account to try from.
- Do not record the site as blocked in any file, rule or memory; a refusal today says nothing about
  tomorrow.
- **Opening a thread can mark its messages as read** for the other person, on both platforms. Say so
  in the approval request and let the owner decide. Never send, react, delete or change anything.

## What to collect

For each named thread, every link in the messages, back to the date the owner gives (default: the
last 30 days). Do not open the links themselves; read each message's own card or text:

- **Instagram shared reels and posts:** the card's `href` (an `instagram.com/reel|reels|p|tv/<code>/`
  link), its caption if shown, and the original author's handle if shown.
- **Links to other sites:** the URL as written in the message.
- For each: the date of the message, who sent it (the sender's display name as the page shows it), the
  thread, and the owner's account name as given in the approval.

## What to return

Capture records, one JSON object per line, in the shape the importers already use. The extension
imports any line with a `url`, and fields it does not know are stored untouched.

    {"kind": "reel", "url": "https://www.instagram.com/reel/AAA111/", "source_url": null, "title": null,
     "text": "caption as shown, or null", "author": {"name": null, "handle": "original_poster"},
     "saved_at": "2026-10-12", "images": [], "captured_at": "<now, ISO 8601 UTC>", "via": "chrome-agent",
     "site": "Instagram", "account": "main", "thread": ["alice_123"], "senders": ["Alice"]}

- `kind`: `reel` for `/reel`, `/reels` or `/tv`, `ig-post` for `/p`, `tweet` for an x.com status,
  `page` for any other site.
- `url`: the canonical form, with no query string; for Instagram `https://www.instagram.com/<kind>/<code>/`.
- `saved_at`: the date the message was sent, `YYYY-MM-DD`.
- `via` is always `chrome-agent`.
- `account`: the name the owner gave, not the handle.
- `thread`: the thread's name as the page shows it. A thread slug from an export is not available here.
- **One record per URL.** A link met in several threads is one record whose `thread` lists each of them,
  and whose `senders` lists each distinct person who sent it. The owner, however often, counts once.
- A link to another site with no text may be returned as a bare record with only `kind: "page"`, `url`,
  `saved_at`, `via`, `account`, `thread` and `senders`; `importers/enrich-web.py` and `enrich-x.py`
  work from `URL<TAB>date` and are run by `tools/refresh.zsh`, not by the agent.

Write the lines to `link-captures-extra.jsonl` in the data directory (`DATA_DIR`, from `config.local.sh`;
`data/` in the repo by default). `tools/refresh.zsh` merges that file on every run and never
overwrites it. Append; never rewrite what is there.

## The report

End with: the account, the platform, the threads read, the number of requests made, the number of
records written, and anything that stopped the run. State what was not done.
