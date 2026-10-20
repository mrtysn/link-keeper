#!/usr/bin/env python3
# DESC: Check a reel pack's on-screen text (OCR), its resource list and how both reach the capture record.
"""Build a pack in a temp folder from tools/reel-fixtures/frame-text.jpg, then run watch-reel.zsh
--summarize on it (OCR through tools/read-frame-text.swift, compiled into the temp DATA_DIR),
extract-reel-resources.py with a stand-in for Claude, and reels-to-captures.py's record(). No network,
no Claude call, the real data folder untouched.

    tools/test-reel-resources.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

tools = Path(__file__).resolve().parent
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else f'  ({detail})'}")
    failed |= not ok


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, tools / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


extractor = load("extract_reel_resources", "extract-reel-resources.py")
r2c = load("reels_to_captures", "reels-to-captures.py")

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    pack = tmp / "reels" / "ABC123"
    (pack / "frames").mkdir(parents=True)
    for i in range(1, 4):
        shutil.copy(tools / "reel-fixtures" / "frame-text.jpg", pack / "frames" / f"f{i:04d}.jpg")
    (pack / "meta.json").write_text(json.dumps({"url": "https://www.instagram.com/reel/ABC123/", "kind": "reel",
                                                "duration_s": 3.0, "fetched_at": "2026-10-20T00:00:00+00:00"}))
    (pack / "video.info.json").write_text(json.dumps({"description": "the caption", "channel": "someone"}))
    (pack / "transcript.txt").write_text("Go and try voice box, link in bio.\n")

    env = dict(os.environ, DATA_DIR=str(tmp), REELS_DIR=str(tmp / "reels"))
    done = subprocess.run([str(tools / "watch-reel.zsh"), "--summarize", str(pack)], env=env,
                          capture_output=True, text=True)
    check("watch-reel --summarize builds the pack's summary", done.returncode == 0, done.stdout + done.stderr)
    shown = (pack / "onscreen.txt").read_text() if (pack / "onscreen.txt").exists() else ""
    check("OCR reads the frame's text into onscreen.txt, with its second",
          "[0s] github.com/acme/frame-tool" in shown and "Try Voicebox today" in shown, shown)
    check("a line shown on several frames is kept once", shown.count("frame-tool") == 1, shown)
    summary = (pack / "summary.md").read_text() if (pack / "summary.md").exists() else ""
    check("summary.md has the on-screen text", "## On screen" in summary and "frame-tool" in summary, summary[:300])

    calls = []

    def fake_ask(system: str, user: str, schema: dict) -> dict:
        calls.append(user)
        return {"about": "A reel recommending Voicebox.",
                "resources": [{"name": "Voicebox", "kind": "app", "url": None, "where": "shown"},
                              {"name": "frame-tool", "kind": "repo", "url": "github.com/acme/frame-tool", "where": "shown"}]}

    rc = extractor.main(["--reels-dir", str(tmp / "reels")], ask=fake_ask)
    check("the extractor sends caption, transcript and on-screen text in one call",
          rc == 0 and len(calls) == 1 and all(s in calls[0] for s in ("the caption", "voice box", "frame-tool")),
          calls[0][:300] if calls else "no call")
    res = json.loads((pack / "resources.json").read_text())
    check("resources.json holds the answer and the input's hash", res["about"].startswith("A reel") and res.get("input"))
    extractor.main(["--reels-dir", str(tmp / "reels")], ask=fake_ask)
    check("an unchanged pack is not asked again", len(calls) == 1, f"{len(calls)} calls")
    (pack / "transcript.txt").write_text("Go and try Voicebox.\n")
    extractor.main(["--reels-dir", str(tmp / "reels")], ask=fake_ask)
    check("a changed transcript is asked again", len(calls) == 2, f"{len(calls)} calls")

    def bad_ask(system: str, user: str, schema: dict) -> dict:
        return {"resources": "nope"}

    rc = extractor.main(["--reels-dir", str(tmp / "reels"), "--force"], ask=bad_ask)
    check("a malformed answer fails and leaves resources.json as it was",
          rc == 1 and json.loads((pack / "resources.json").read_text())["about"].startswith("A reel"))

    rec = r2c.record(pack)
    check("the capture text starts with what the reel is about and its resources",
          rec["text"].startswith("— about — A reel recommending Voicebox.\n- Voicebox (app, shown)"), rec["text"][:200])
    check("the on-screen text and the transcript follow",
          "— on screen —" in rec["text"] and "— transcript —" in rec["text"], rec["text"])
    check("resource URLs become the record's links, with a scheme",
          rec["links"] == ["https://github.com/acme/frame-tool"], str(rec["links"]))

    (pack / "transcript.txt").write_text("Music\nMusic\nGo and try Voicebox.\n[Music]\n")
    text = r2c.record(pack)["text"]
    check("whisper's runs of 'Music' become one (music) line in the capture; transcript.txt keeps them",
          "— transcript —\n(music)\nGo and try Voicebox.\n(music)" in text and (pack / "transcript.txt").read_text().count("Music") == 3, text)
    (pack / "resources.json").unlink()
    (pack / "onscreen.txt").unlink()
    rec = r2c.record(pack)
    check("a pack from before OCR still converts, with no links",
          rec["links"] == [] and "— on screen —" not in rec["text"] and "— transcript —" in rec["text"], rec["text"])

with tempfile.TemporaryDirectory() as tmp:
    # The download path with stand-ins: yt-dlp hands over a 3 s MP4 made from the fixture frame, whisper
    # writes a fixed line. Two reels, so the second downloads while the first is processed.
    tmp = Path(tmp)
    stubs = tmp / "bin"
    stubs.mkdir()
    mp4 = tmp / "fixture.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-loop", "1", "-i", str(tools / "reel-fixtures" / "frame-text.jpg"),
                    "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-pix_fmt", "yuv420p", "-shortest", str(mp4)],
                   check=True)
    (stubs / "yt-dlp").write_text(f"""#!/usr/bin/env python3
import json, shutil, sys
a = sys.argv[1:]
if "-J" in a:
    url = a[-1]
    if "youtube" in url:
        print(json.dumps({{"title": "A YouTube talk", "description": "about the talk", "channel": "Some Channel", "uploader_id": "@somechannel"}}))
    elif "x.com" in url:
        print(json.dumps({{"description": "a post with a video", "uploader": "Poster", "uploader_id": "poster"}}))
    else:
        print(json.dumps({{"description": "stub caption", "channel": "someone"}}))
elif "--write-subs" in a:
    # YouTube's captions, as yt-dlp names them beside -o, with auto-captions' rolling repeat.
    open(a[a.index("-o") + 1] + ".en.vtt", "w").write("WEBVTT\\nKind: captions\\n\\n00:00.000 --> 00:02.000\\nsaid in the captions\\n\\n00:02.000 --> 00:04.000\\nsaid in the captions\\nand then more\\n")
else:
    shutil.copy({str(mp4)!r}, a[a.index("-o") + 1])
""")
    (stubs / "mlx_whisper").write_text("""#!/usr/bin/env python3
import sys
a = sys.argv[1:]
open(a[a.index("--output-dir") + 1] + "/" + a[a.index("--output-name") + 1] + ".txt", "w").write("hello from the stub\\n")
""")
    for f in stubs.iterdir():
        f.chmod(0o755)
    env = dict(os.environ, DATA_DIR=str(tmp), REELS_DIR=str(tmp / "reels"), PATH=f"{stubs}:{os.environ['PATH']}")
    done = subprocess.run([str(tools / "watch-reel.zsh"), "https://www.instagram.com/reel/AAA111/",
                           "https://www.instagram.com/reel/BBB222/"], env=env, capture_output=True, text=True)
    check("watch-reel builds two packs with the downloads overlapping the processing",
          done.returncode == 0 and "packs: 2 built" in done.stdout, done.stdout + done.stderr)
    for code in ("AAA111", "BBB222"):
        p = tmp / "reels" / code
        check(f"{code}: meta, transcript, on-screen text and summary are there",
              all((p / f).is_file() for f in ("meta.json", "transcript.txt", "onscreen.txt", "summary.md"))
              and "hello from the stub" in (p / "transcript.txt").read_text()
              and "frame-tool" in (p / "onscreen.txt").read_text(), str(sorted(x.name for x in p.iterdir())))
        check(f"{code}: the MP4 is deleted once the pack is done", not (p / "video.mp4").exists())
    again = subprocess.run([str(tools / "watch-reel.zsh"), "https://www.instagram.com/reel/AAA111/"], env=env,
                           capture_output=True, text=True)
    check("a finished pack is skipped on the next run", "0 built, 1 already had one" in again.stdout, again.stdout)

    # The helper's worker: a queued link becomes a pack and a record, and leaves the queue.
    queue, out = tmp / "queue", tmp / "records.jsonl"
    queue.mkdir()
    (queue / "CCC333.url").write_text("https://www.instagram.com/reel/CCC333/")
    (queue / "nope.url").write_text("https://example.com/not-a-video")
    done = subprocess.run([str(tools / "watch-links.zsh"), "--queue", str(queue), "--out", str(out)],
                          env=dict(env, WATCH_NO_RESOURCES="1"), capture_output=True, text=True)
    recs = [json.loads(l) for l in out.read_text().splitlines()] if out.exists() else []
    check("watch-links turns a queued reel into a record and empties the queue",
          done.returncode == 0 and not list(queue.iterdir()) and len(recs) == 1
          and recs[0]["url"].endswith("/reel/CCC333/") and recs[0]["via"] == "watch-reel"
          and "hello from the stub" in recs[0]["text"], done.stdout + done.stderr)
    check("a link it cannot watch is said and dropped", "not a video link" in done.stdout, done.stdout)

    # YouTube: the captions are the transcript, whisper is not run, and the record is a YouTube video.
    done = subprocess.run([str(tools / "watch-reel.zsh"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ"], env=env,
                          capture_output=True, text=True)
    yt = tmp / "reels" / "yt-dQw4w9WgXcQ"
    tr = (yt / "transcript.txt").read_text() if (yt / "transcript.txt").exists() else ""
    check("a YouTube video's pack is yt-<id>, its transcript its captions, repeats dropped, no whisper",
          done.returncode == 0 and tr.split("\n")[:2] == ["said in the captions", "and then more"] and "stub" not in tr,
          done.stdout + done.stderr + tr)
    rec = r2c.record(yt) if yt.exists() else {}
    check("...and its record is a YouTube video titled by the video, by its channel",
          rec.get("kind") == "video" and rec.get("site") == "YouTube" and rec.get("title") == "A YouTube talk"
          and rec.get("author", {}).get("name") == "Some Channel", str(rec)[:300])
    check("...with no caption file or MP4 left behind", not list(yt.glob("*.vtt")) and not (yt / "video.mp4").exists(),
          str(sorted(x.name for x in yt.iterdir())) if yt.exists() else "no pack")

    # X: a post with a video is whispered like a reel, and its record is a tweet by its @handle.
    done = subprocess.run([str(tools / "watch-reel.zsh"), "https://x.com/poster/status/123456"], env=env,
                          capture_output=True, text=True)
    xp = tmp / "reels" / "x-123456"
    rec = r2c.record(xp) if xp.exists() else {}
    check("an X post's pack is x-<id> and its record a tweet with the transcript",
          rec.get("kind") == "tweet" and rec.get("site") == "X" and rec.get("author", {}).get("handle") == "@poster"
          and "hello from the stub" in (rec.get("text") or ""), done.stdout + str(rec)[:300])

# One rule for a video link's pack name, in three places: the tools' script, the helper and the extension.
urls = ["https://www.instagram.com/reel/AbC_12-x/", "https://www.instagram.com/p/XyZ/", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3",
        "https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ",
        "https://x.com/someone/status/2094427822064279870", "https://twitter.com/a_b/status/123", "https://example.com/",
        "https://www.youtube.com/@channel", "https://x.com/someone"]
spec = importlib.util.spec_from_file_location("bridge", tools.parent / "native" / "link-keeper-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
zsh_ids = [subprocess.run([str(tools / "video-pack-id.zsh"), u], capture_output=True, text=True).stdout.strip() or None for u in urls]
js = subprocess.run(["node", "-e", """
const src = require("fs").readFileSync(process.argv[1], "utf8");
const re = eval(src.match(/^const WATCHABLE = (\/.*\/);$/m)[1]);
console.log(JSON.stringify(JSON.parse(process.argv[2]).map(u => re.test(u))));
""", str(tools.parent / "extension" / "background.js"), json.dumps(urls)], capture_output=True, text=True)
check("the tools' script and the helper name every pack the same", zsh_ids == [bridge.video_pack_id(u) for u in urls],
      f"{zsh_ids} vs {[bridge.video_pack_id(u) for u in urls]}")
check("the extension watches exactly the links that get a pack", json.loads(js.stdout or "[]") == [i is not None for i in zsh_ids],
      js.stdout + js.stderr)

print("all passed" if not failed else "FAILED")
sys.exit(1 if failed else 0)
