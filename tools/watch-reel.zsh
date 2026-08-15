#!/bin/zsh
# DESC: Download a reel and build a watch-pack: video, transcript, keyframes — so an agent can watch it.
#
# Instagram reels are video, so "capturing" one means more than a URL: this pulls the MP4
# anonymously — public reels need no login, so no account is involved — transcribes the audio
# locally with mlx-whisper, and extracts one frame per second. The resulting directory is
# everything an agent needs to watch the reel without a browser: read transcript.txt, look at
# frames/, summarise.
#
# Usage:
#   watch-reel.zsh <url>...                    # one pack per reel URL
#   watch-reel.zsh --from captures.jsonl       # every kind:"reel" record in the file
#   watch-reel.zsh --from captures.jsonl -n 5  # only the 5 newest not yet fetched
#
# Packs land under REELS_DIR (config.local.sh; default $DATA_DIR/reels), one directory per
# shortcode:
#   reels/DBxYz123/video.mp4  transcript.txt  frames/f0001.jpg …  meta.json
#
# Idempotent: a pack with a transcript is skipped, so rerunning over the whole capture file only
# fetches what is new. Instagram rate-limits aggressively; downloads are spaced a few seconds apart.
#
# Requires: yt-dlp, ffmpeg (brew), mlx_whisper (uv tool install mlx-whisper). No login anywhere.

set -euo pipefail

here=${0:A:h}
repo=${here:h}

if [[ ${1:-} == -h || ${1:-} == --help || $# -eq 0 ]]; then
  sed -n '2,22p' "$0" | sed 's/^# \?//'
  exit 0
fi

DATA_DIR=${DATA_DIR:-$PWD}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
REELS_DIR=${REELS_DIR:-$DATA_DIR/reels}
WHISPER_MODEL=${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}

for tool in yt-dlp ffmpeg mlx_whisper; do
  command -v $tool >/dev/null || { print -u2 "missing: $tool — see the header for install"; exit 1 }
done

# --- collect the URLs -----------------------------------------------------------

urls=()
limit=0
while (( $# )); do
  case $1 in
    --from) shift
      [[ -f ${1:-} ]] || { print -u2 "no such captures file: ${1:-}"; exit 1 }
      urls+=(${(f)"$(python3 -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except ValueError: continue
    if r.get("kind") == "reel": print(r["url"])
' "$1")"}) ;;
    -n) shift; limit=${1:-0} ;;
    *) urls+=$1 ;;
  esac
  shift
done

(( $#urls )) || { print "nothing to fetch"; exit 0 }
mkdir -p "$REELS_DIR"

# --- one pack per shortcode -----------------------------------------------------

shortcode() {
  print -r -- "$1" | sed -nE 's#.*instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+).*#\2#p'
}

built=0 skipped=0 failed=0
for url in $urls; do
  code=$(shortcode "$url")
  [[ -n $code ]] || { print "  ? not a reel/post url, skipping: $url"; continue }
  pack=$REELS_DIR/$code

  if [[ -s $pack/transcript.txt ]]; then
    skipped=$(( skipped + 1 ))
    continue
  fi
  (( limit && built >= limit )) && break

  print "→ $code"
  mkdir -p "$pack/frames"

  if [[ ! -s $pack/video.mp4 ]]; then
    # Anonymous on purpose: public reels serve without login (verified), and no cookies means no
    # account is ever at risk. If Instagram starts refusing, that is a stop sign, not a cue to
    # reach for a logged-in session.
    yt-dlp --no-progress -o "$pack/video.mp4" \
           --write-info-json "$url" >/dev/null 2>"$pack/yt-dlp.err" || {
      print "  ! download failed — $(tail -1 "$pack/yt-dlp.err" 2>/dev/null | head -c 100)"
      failed=$(( failed + 1 ))
      continue
    }
    rm -f "$pack/yt-dlp.err"
    sleep 3   # be a polite client; instagram bans hasty ones
  fi

  # 16 kHz mono is what whisper wants; 1 fps at 640px wide is plenty for reading a reel.
  ffmpeg -y -loglevel error -i "$pack/video.mp4" -ar 16000 -ac 1 "$pack/audio.wav"
  ffmpeg -y -loglevel error -i "$pack/video.mp4" -vf "fps=1,scale=640:-2" "$pack/frames/f%04d.jpg"

  mlx_whisper "$pack/audio.wav" --model "$WHISPER_MODEL" \
              --output-dir "$pack" --output-name transcript --output-format txt >/dev/null
  rm -f "$pack/audio.wav"

  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$pack/video.mp4")
  python3 - "$pack/meta.json" "$url" "$duration" <<'PY'
import json, sys, datetime
out, url, duration = sys.argv[1:4]
json.dump({"url": url, "duration_s": round(float(duration), 1),
           "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat()},
          open(out, "w"), indent=2)
PY
  built=$(( built + 1 ))
done

print "\npacks: $built built, $skipped already had one, $failed failed → ${REELS_DIR/#$HOME/~}"
