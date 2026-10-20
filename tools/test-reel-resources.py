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

    (pack / "resources.json").unlink()
    (pack / "onscreen.txt").unlink()
    rec = r2c.record(pack)
    check("a pack from before OCR still converts, with no links",
          rec["links"] == [] and "— on screen —" not in rec["text"] and "— transcript —" in rec["text"], rec["text"])

print("all passed" if not failed else "FAILED")
sys.exit(1 if failed else 0)
