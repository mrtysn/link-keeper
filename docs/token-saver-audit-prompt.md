# Token-saver audit prompt

A prompt for a fresh Claude Code session launched from `~/dev/tools`, so that repo's `CLAUDE.md` loads
at startup. It adapts the prompt Josh Blatchford shows at the end of his reel
(https://www.instagram.com/p/DeR8ZyWxve0/, "94% in token savings"; pack in `data/reels/DeR8ZyWxve0/`).
His original steps 1 to 3 and his closing line are kept; the preamble and the marked edits are added
after two independent reviews, which found the original would hand-roll a transcript parser, rebuild
tools that already exist, and commit before the owner's OK.

His 94% is his own number from one video. The estimate this prompt asks for is how to check it here.

## Paste this

```
Build me a token-saver for Claude Code on this machine. Start by auditing my setup for token efficiency.

Ground rules for this run:
- Read-only until I say OK. Write nothing outside this session's scratchpad until then, and commit nothing.
- Before building anything, list what already exists: `ls ~/bin` (the toolbelt, via `toolbelt`) and the
  skills in `~/.claude/skills`. Anything that already reads text instead of pixels is reused, not rebuilt.
- Installed here: mlx_whisper (~/.local/bin), ffmpeg and yt-dlp (Homebrew). Use mlx_whisper, never pip
  install openai-whisper.
- Tools I invoke by hand go through the /new-tool skill into this repo's bin/. A hook or pane (a mod)
  goes through the plugin-authoring skill. Recommend scripts the agent calls over a hook on Read, and
  say what a hook would add before suggesting one.

1. Look through my recent sessions, the last 30 only, and list the 5 tasks where you spend the most
   tokens. Read transcripts with the mine-chat-logs skill (the shared extract-session-text reader),
   never your own jsonl parser. For each task, tell me what you were reading (images, video frames,
   long files, transcripts, web pages) and roughly how many tokens it costs each time. State how you
   measured it, and say how many tokens the audit itself used.

2. For each one, tell me whether my Mac could do the heavy lifting locally, for free, before you ever
   read it. Check my existing tools first (the list above). Then what is built into macOS: Apple's
   Vision framework (text recognition, face detection, person cutouts) through a small Swift script,
   Spotlight (mdfind) for finding files, and sips for image details. Then free local tools: ffmpeg for
   one contact sheet instead of separate frames (downscaled, and say how many frames it covers),
   mlx_whisper for transcripts, and simple scripts that summarize long files. Where OCR of a frame
   would replace an image read, say so.

3. For the top two, propose a local prep step that saves a one-page summary and at most two images, so
   you read that instead of the raw files. For a video, extend tools/watch-reel.zsh in the link-keeper
   repo rather than writing a second video tool, and keep its raw frames out of the obvious path.
   Do not build it yet.

Show me a before-and-after token estimate for each, and wait for my OK before installing anything.
My OK covers installing; commit each finished piece atomically after that, as usual.
```

## What changed from his prompt, and why

| Edit | Reason |
|---|---|
| Last 30 sessions, `mine-chat-logs`, "say how many tokens the audit used" | A hand-rolled parser over `~/.claude/projects` is forbidden; an unbounded audit can cost more than the tasks it finds |
| Inventory `~/bin` and skills first | `watch-reel.zsh`, `video-use`, `capture-mac-window`, `render-terminal-screen` and others already read text, not pixels |
| mlx_whisper named, with its path | Otherwise a session installs openai-whisper |
| Scripts over a hook, `/new-tool` and `plugin-authoring` named | "Mod" is ambiguous here; a hook on Read is the larger change |
| Step 3 proposes, does not build | His closing line says wait for OK; the commit rule would otherwise land the work first |
| Extend `watch-reel.zsh` | It already emits one JPEG per second, so a 60-second reel is 60 image reads |

## Not settled

- Whether images are where the owner's tokens go. One session does not show it; step 1 measures it.
- Whether a contact sheet or frame OCR is the better video summary. A sheet of a subset of frames lost
  the on-screen prompt text in this reel, which only a full-resolution crop gave back.
- One sentence at the end of the reel's prompt was hidden by a caption; "token estimate" is
  reconstructed from visible fragments.
