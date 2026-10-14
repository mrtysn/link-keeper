#!/bin/zsh
# DESC: Download a reel or carousel and build a watch-pack: video, transcript, keyframes, slides — so an agent can watch it.
#
# Instagram reels are video, so "capturing" one means more than a URL: this pulls the MP4
# anonymously — public reels need no login, so no account is involved — transcribes the audio
# locally with mlx-whisper, and extracts one frame per second. The resulting directory is
# everything an agent needs to watch the reel without a browser. An agent reads summary.md and
# sheet.jpg first (caption, duration, the start of the transcript, and a contact sheet of the
# distinct frames); frames/ and the full transcript.txt only on demand.
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
#   watch-reel.zsh --summarize <packdir|shortcode>...   # sheet + summary for existing packs
#   watch-reel.zsh --summarize-all             # the same for every finished pack in REELS_DIR
#   (--summarize touches no network; it skips a pack that has summary.md unless --force)
#
# Packs land under REELS_DIR (config.local.sh; default $DATA_DIR/reels), one directory per
# shortcode:
#   reels/DBxYz123/video.mp4  transcript.txt  frames/f0001.jpg …  video.info.json  meta.json
#                  summary.md  sheet.jpg (sheet-2.jpg when over 24 distinct frames)
#   reels/DCarou45/slides/01.jpg  slides/02.mp4 …  frames/s02-f0001.jpg …  transcript.txt  meta.json
#                  summary.md  s02-sheet.jpg …   (one sheet set per video slide)
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
  sed -n '2,30p' "$0" | sed 's/^# \?//'
  exit 0
fi

env_data=${DATA_DIR:-}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
DATA_DIR=${env_data:-${DATA_DIR:-$repo/data}}
REELS_DIR=${REELS_DIR:-$DATA_DIR/reels}
WHISPER_MODEL=${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}

# --- contact sheet + summary for one pack -----------------------------------------
# What an agent reads instead of the per-second frames: sheet.jpg tiles only the DISTINCT frames
# (ffmpeg scene change on the 1 fps frames already in frames/), at most 24 per sheet and two
# sheets; summary.md holds the caption, duration, the start of the transcript and the tile times.
# Works from files on disk only — no network.

sheet_tile_w=240    # tile width in px
sheet_cols=6        # tiles per row, at most
sheet_per=24        # tiles per sheet
sheet_max=2         # sheets per video
sheet_scene=0.1     # scene-change score that makes a frame "distinct"
force=0
sheet_specs=()      # "file|t1 t2 …" lines, filled by build_sheets for the summary

# Tile the distinct frames of one video ($2 = the s02- prefix, empty for a reel) into
# ${prefix}sheet.jpg and ${prefix}sheet-2.jpg; appends one sheet_specs line per sheet written.
build_sheets() {
  local p=$1 pre=$2 glob t i m sel cols rows out k
  local -a frames times picks chunk
  frames=($p/frames/${pre}f[0-9]*.jpg(N))
  (( $#frames )) || return 0
  glob="$p/frames/${pre}f*.jpg"

  # Frame n of the 1 fps input is second n, so the time ffmpeg reports for a kept frame is its index.
  # The first frame is always kept: a static clip would otherwise select nothing.
  times=(${(f)"$(ffmpeg -nostdin -hide_banner -loglevel info -framerate 1 -pattern_type glob -i "$glob" \
      -vf "select='eq(n,0)+gt(scene,$sheet_scene)',showinfo" -f null - 2>&1 \
      | sed -nE 's/.*Parsed_showinfo.*pts_time:([0-9.]+).*/\1/p' || true)"})
  times=(${times%.*})
  times=(${(M)times:#<->})
  # Keep only indexes that name a frame.
  picks=()
  for t in $times; do (( t < $#frames )) && picks+=$t; done
  times=($picks)

  if (( ! $#times )); then
    # The scene filter selected nothing (it has failed on a 2 s clip): sample uniformly instead.
    m=$(( $#frames < sheet_per ? $#frames : sheet_per ))
    times=()
    for (( i = 0; i < m; i++ )); do times+=$(( i * $#frames / m )); done
  fi

  # More distinct frames than two sheets hold: thin them evenly.
  m=$(( sheet_per * sheet_max ))
  if (( $#times > m )); then
    picks=()
    for (( i = 0; i < m; i++ )); do picks+=$times[$(( 1 + i * ($#times - 1) / (m - 1) ))]; done
    times=($picks)
  fi

  k=1
  while (( $#times )); do
    chunk=(${times[1,$sheet_per]})
    times=(${times[$(( sheet_per + 1 )),-1]})
    sel=""
    for t in $chunk; do sel+="${sel:+\+}eq(n,$t)"; done
    cols=$(( $#chunk < sheet_cols ? $#chunk : sheet_cols ))
    rows=$(( ($#chunk + cols - 1) / cols ))
    out=${pre}sheet${${k:#1}:+-$k}.jpg
    # yuvj420p: the mjpeg encoder refuses the full-range input otherwise.
    ffmpeg -nostdin -y -loglevel error -framerate 1 -pattern_type glob -i "$glob" \
      -vf "select='$sel',scale=$sheet_tile_w:-2,tile=${cols}x${rows}" \
      -frames:v 1 -update 1 -q:v 4 -pix_fmt yuvj420p "$p/$out" || return 1
    sheet_specs+="$out|$chunk"
    k=$(( k + 1 ))
  done
}

# Returns 0 built, 1 failed, 2 skipped (summary.md already there and no --force).
summarize_pack() {
  local p=${1:A} f pre   # absolute, so the rm -f below can never resolve against another cwd
  local -a prefixes
  [[ -s $p/meta.json ]] || { print "  ? ${p:t}: no meta.json — not a finished pack"; return 1 }
  [[ -s $p/summary.md && $force == 0 ]] && return 2
  sheet_specs=()
  prefixes=()
  for f in $p/frames/*f[0-9]*.jpg(N); do pre=${f:t}; prefixes+="x${pre%%f[0-9]*}"; done
  prefixes=(${(u)prefixes})   # "x" keeps the reel's empty prefix from vanishing out of the list
  for pre in "${(@)prefixes#x}"; do
    rm -f "$p/${pre}sheet.jpg" "$p/${pre}sheet-2.jpg"
    build_sheets "$p" "$pre" || return 1
  done
  python3 - "$p" "${sheet_specs[@]}" <<'PY' || return 1
import json, os, re, sys
pack, specs = sys.argv[1], sys.argv[2:]
name = os.path.basename(pack)
def load(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return {}
meta, info = load(f"{pack}/meta.json"), load(f"{pack}/video.info.json")
caption = info.get("description") or info.get("title") or ""
if not caption:
    for e in info.get("entries") or []:
        caption = e.get("description") or ""
        if caption: break
caption = re.sub(r"\s+", " ", caption).strip()
if len(caption) > 500: caption = caption[:500].rsplit(" ", 1)[0] + " …"
kind = meta.get("kind", "reel")
slides = sorted(os.listdir(f"{pack}/slides")) if os.path.isdir(f"{pack}/slides") else []
if kind == "carousel":
    dur = f"carousel, {meta.get('slides', len(slides))} slides ({sum(s.endswith('.mp4') for s in slides)} video)"
else:
    dur = f"reel, {meta.get('duration_s', 0)} s"
try:
    tr = open(f"{pack}/transcript.txt", encoding="utf-8").read().strip()
except OSError:
    tr = ""
limit = 1200
if len(tr) > limit:
    cut = tr[:limit].rsplit(None, 1)[0]
    head = f"first {len(cut)} of {len(tr)} characters; full text in transcript.txt"
    body = cut + " …"
else:
    head, body = "complete", tr or "(no transcript)"
out = [f"# {name}", "", f"- source: {meta.get('url', '')}", f"- kind: {dur}",
       f"- caption: {caption or '(none)'}", ""]
if specs:
    out += ["## Contact sheet", "",
            "Distinct frames only, left to right then top to bottom. Tile times in seconds:", ""]
    for s in specs:
        f, times = s.split("|", 1)
        out.append(f"- {f} ({len(times.split())} tiles): {times}")
    out += ["", "Every other second is in frames/ (f0001.jpg = second 0); open one only to check a detail.", ""]
else:
    out += ["## Contact sheet", "", "No video frames in this pack."]
    if slides:
        out.append(f"The content is the {len(slides)} image slides in slides/ ({slides[0]} …); read those.")
    out.append("")
out += [f"## Transcript ({head})", "", body, ""]
tmp = f"{pack}/summary.md.tmp"
open(tmp, "w", encoding="utf-8").write("\n".join(out))
os.replace(tmp, f"{pack}/summary.md")
PY
}

# --- collect the URLs -----------------------------------------------------------

urls=()
limit=0
retry_failed=0
summarize=0 summarize_all=0
dirs=()
while (( $# )); do
  case $1 in
    --force) force=1 ;;
    --summarize) summarize=1 ;;
    --summarize-all) summarize=1 summarize_all=1 ;;
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
    *) if (( summarize )); then dirs+=$1; else urls+=$1; fi ;;
  esac
  shift
done

if (( summarize )); then
  (( $#urls )) && { print -u2 "--summarize takes pack directories, not urls"; exit 1 }
  command -v ffmpeg >/dev/null || { print -u2 "missing: ffmpeg"; exit 1 }
  if (( summarize_all )); then
    dirs=()
    # Unfinished packs (no meta.json) are a run in progress or a recorded failure: left alone.
    for d in $REELS_DIR/*(N/); do [[ -s $d/meta.json ]] && dirs+=$d; done
  fi
  s_built=0 s_skipped=0 s_failed=0
  for d in $dirs; do
    # A bare shortcode names a pack under REELS_DIR.
    [[ -d $d ]] || d=$REELS_DIR/$d
    [[ -d $d ]] || { print "  ? no such pack: $d"; s_failed=$(( s_failed + 1 )); continue }
    rc=0
    summarize_pack "$d" || rc=$?
    case $rc in
      0) print "→ ${d:t}: summary.md + sheet"; s_built=$(( s_built + 1 )) ;;
      2) s_skipped=$(( s_skipped + 1 )) ;;
      *) print "  ! ${d:t}: summary failed"; s_failed=$(( s_failed + 1 )) ;;
    esac
  done
  print "\nsummaries: $s_built built, $s_skipped already had one, $s_failed failed"
  exit $(( s_failed ? 1 : 0 ))
fi

for tool in yt-dlp ffmpeg mlx_whisper; do
  command -v $tool >/dev/null || { print -u2 "missing: $tool — see the header for install"; exit 1 }
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
  # The sheet and summary come last: a pack without summary.md can be completed offline later
  # with --summarize.
  rm -f "$pack/summary.md"
  rc=0
  summarize_pack "$pack" || rc=$?
  (( rc )) && print "  ! contact sheet failed — rerun with --summarize $code"
  built=$(( built + 1 ))
done

print "\npacks: $built built, $skipped already had one, $failed failed → ${REELS_DIR/#$HOME/~}"
print "agent reads: summary.md and sheet.jpg in each pack first; frames/ and transcript.txt only on demand"
