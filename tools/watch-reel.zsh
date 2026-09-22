#!/bin/zsh
# DESC: Download a reel or carousel and build a watch-pack: video, transcript, keyframes, slides — so an agent can watch it.
#
# Instagram reels are video, so "capturing" one means more than a URL: this pulls the MP4
# anonymously — public reels need no login, so no account is involved — transcribes the audio
# locally with mlx-whisper, and extracts one frame per second. The resulting directory is
# everything an agent needs to watch the reel without a browser: read transcript.txt, look at
# frames/, summarise.
#
# A carousel post (/p/ with several slides) is saved slide by slide: image slides as
# slides/NN.jpg, video slides as slides/NN.mp4 with their frames and transcript. The caption is
# in video.info.json either way.
#
# Usage:
#   watch-reel.zsh <url>...                    # one pack per reel or post URL
#   watch-reel.zsh --from captures.jsonl       # every kind:"reel"/"ig-post" record in the file
#   watch-reel.zsh --from captures.jsonl -n 5  # only the 5 newest not yet fetched
#   watch-reel.zsh --retry-failed <url>...     # also retry packs with a recorded failure
#
# Packs land under REELS_DIR (config.local.sh; default $DATA_DIR/reels), one directory per
# shortcode:
#   reels/DBxYz123/video.mp4  transcript.txt  frames/f0001.jpg …  video.info.json  meta.json
#   reels/DCarou45/slides/01.jpg  slides/02.mp4 …  frames/s02-f0001.jpg …  transcript.txt  meta.json
#
# Idempotent: a pack with a meta.json is complete and skipped, so rerunning over the whole capture
# file only fetches what is new. Instagram rate-limits aggressively; posts are spaced a few seconds
# apart.
#
# Requires: yt-dlp, ffmpeg (brew), mlx_whisper (uv tool install mlx-whisper). No login anywhere.

set -euo pipefail

here=${0:A:h}
repo=${here:h}

if [[ ${1:-} == -h || ${1:-} == --help || $# -eq 0 ]]; then
  sed -n '2,22p' "$0" | sed 's/^# \?//'
  exit 0
fi

env_data=${DATA_DIR:-}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
DATA_DIR=${env_data:-${DATA_DIR:-$repo/data}}
REELS_DIR=${REELS_DIR:-$DATA_DIR/reels}
WHISPER_MODEL=${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}

for tool in yt-dlp ffmpeg mlx_whisper; do
  command -v $tool >/dev/null || { print -u2 "missing: $tool — see the header for install"; exit 1 }
done

# --- collect the URLs -----------------------------------------------------------

urls=()
limit=0
retry_failed=0
while (( $# )); do
  case $1 in
    --retry-failed) retry_failed=1 ;;
    --from) shift
      [[ -f ${1:-} ]] || { print -u2 "no such captures file: ${1:-}"; exit 1 }
      urls+=(${(f)"$(python3 -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except ValueError: continue
    if r.get("kind") in ("reel", "ig-post"): print(r["url"])
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

# frames + transcript for one video; $2 prefixes the frame names and heads the transcript section
watch_video() {
  local mp4=$1 prefix=$2 txt
  ffmpeg -y -loglevel error -i "$mp4" -vf "fps=1,scale=640:-2" "$pack/frames/${prefix}f%04d.jpg"
  # Silent reels are common — probe before extracting, or ffmpeg dies on a stream-less wav.
  if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$mp4" | grep -q .; then
    ffmpeg -y -loglevel error -i "$mp4" -ar 16000 -ac 1 "$pack/audio.wav"
    mlx_whisper "$pack/audio.wav" --model "$WHISPER_MODEL" \
                --output-dir "$pack" --output-name part --output-format txt >/dev/null
    txt=$(<"$pack/part.txt")
    rm -f "$pack/audio.wav" "$pack/part.txt"
  else
    # Anonymous delivery withholds the audio track on some reels (licensed music); the reel
    # itself usually does have sound on Instagram.
    txt="(no audio in the anonymous download — the reel may have music on Instagram)"
  fi
  [[ -n $prefix ]] && print -r -- "— slide ${${prefix#s}%-} —" >> "$pack/transcript.txt"
  print -r -- "$txt" >> "$pack/transcript.txt"
}

for url in $urls; do
  code=$(shortcode "$url")
  [[ -n $code ]] || { print "  ? not a reel/post url, skipping: $url"; continue }
  pack=$REELS_DIR/$code

  if [[ -s $pack/meta.json ]]; then
    skipped=$(( skipped + 1 ))
    continue
  fi
  # A recorded failure (deleted reel, private post) is permanent until told otherwise — retrying
  # it on every run would hammer instagram for nothing.
  if [[ -s $pack/yt-dlp.err && $retry_failed == 0 ]]; then
    skipped=$(( skipped + 1 ))
    continue
  fi
  (( limit && built >= limit )) && break

  print "→ $code"
  mkdir -p "$pack/frames"
  rm -f "$pack/transcript.txt"

  # Anonymous on purpose: public posts serve without login (verified), and no cookies means no
  # account is ever at risk. If Instagram starts refusing, that is a stop sign, not a cue to
  # reach for a logged-in session.
  # One request to instagram: the metadata. Every download after it goes to the CDN URLs it holds.
  # --ignore-no-formats-error keeps image slides, which have no video format, from failing the post.
  if ! yt-dlp -J --ignore-no-formats-error "$url" >"$pack/video.info.json" 2>"$pack/yt-dlp.err"; then
    print "  ! download failed — $(grep ERROR "$pack/yt-dlp.err" | tail -1 | head -c 100)"
    failed=$(( failed + 1 ))
    continue
  fi
  sleep 3   # be a polite client; instagram bans hasty ones

  kind=$(python3 -c 'import json,sys; print("carousel" if json.load(open(sys.argv[1])).get("_type") == "playlist" else "reel")' "$pack/video.info.json")

  if [[ $kind == reel ]]; then
    if [[ ! -s $pack/video.mp4 ]] && ! yt-dlp --no-progress --load-info-json "$pack/video.info.json" \
         -o "$pack/video.mp4" >/dev/null 2>"$pack/yt-dlp.err"; then
      print "  ! download failed — $(grep ERROR "$pack/yt-dlp.err" | tail -1 | head -c 100)"
      failed=$(( failed + 1 ))
      continue
    fi
    watch_video "$pack/video.mp4" ""
    duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$pack/video.mp4")
    slides=0
  else
    mkdir -p "$pack/slides"
    # Image slides are the entry's thumbnails. The one without an stp= resize parameter is the
    # uncropped original; the rest are squares and downscales. Instagram serves WebP or JPEG, so
    # the extension follows the bytes.
    python3 - "$pack/video.info.json" "$pack/slides" <<'PY'
import json, sys, urllib.request
info, out = sys.argv[1:3]
for i, e in enumerate(json.load(open(info))["entries"], 1):
    thumbs = [t["url"] for t in e.get("thumbnails") or [] if t.get("url")]
    if e.get("formats") or not thumbs:
        continue
    url = next((u for u in thumbs if "stp=" not in u), e.get("thumbnail") or thumbs[-1])
    req = urllib.request.Request(url, headers=e.get("http_headers") or {})
    data = urllib.request.urlopen(req, timeout=30).read()
    ext = "webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else "jpg"
    open(f"{out}/{i:02d}.{ext}", "wb").write(data)
PY
    # Video slides: yt-dlp downloads the ones with a format and passes over the images.
    yt-dlp --no-progress --ignore-no-formats-error --load-info-json "$pack/video.info.json" \
           -o "$pack/slides/%(playlist_index)02d.%(ext)s" >/dev/null 2>"$pack/yt-dlp.err" || true
    for mp4 in $pack/slides/*.mp4(N); do
      watch_video "$mp4" "s${mp4:t:r}-"
    done
    files=($pack/slides/*(N))
    slides=$#files
    duration=0
  fi
  rm -f "$pack/yt-dlp.err"

  python3 - "$pack/meta.json" "$url" "${duration:-0}" "$kind" "$slides" <<'PY'
import json, sys, datetime
out, url, duration, kind, slides = sys.argv[1:6]
meta = {"url": url, "kind": kind, "duration_s": round(float(duration or 0), 1),
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
if kind == "carousel":
    meta["slides"] = int(slides)
json.dump(meta, open(out, "w"), indent=2)
PY
  built=$(( built + 1 ))
done

print "\npacks: $built built, $skipped already had one, $failed failed → ${REELS_DIR/#$HOME/~}"
