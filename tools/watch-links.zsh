#!/bin/zsh
# DESC: Watch the videos queued by the helper, one at a time: pack, resource list, and a capture record for Links.
#
# The helper (native/link-keeper-bridge.py, watch-start) writes one file per video link into the queue
# folder and starts this worker when none runs. For each, oldest first: watch-reel.zsh builds the pack
# (download, frames, transcript, on-screen text), extract-reel-resources.py lists what it points to, and
# reels-to-captures.py --pack appends its record to the out file, which Links reads back (watch-status)
# and imports. The queue file goes once the link is done, failed or not: a failed pack keeps its
# yt-dlp.err, and watch-reel.zsh will not retry it unasked. Exits when the queue is empty.
#
# Usage:
#   watch-links.zsh --queue DIR --out FILE
#
# Instagram reels and posts, YouTube videos and X posts with a video, as watch-reel.zsh. No login anywhere; the resource list spends Claude
# tokens (set WATCH_NO_RESOURCES=1 to skip it).

set -euo pipefail

here=${0:A:h}

queue= out=
while (( $# )); do
  case $1 in
    --queue) shift; queue=${1:-} ;;
    --out) shift; out=${1:-} ;;
    -h|--help) sed -n '2,15p' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) print -u2 "unknown argument: $1"; exit 1 ;;
  esac
  shift
done
[[ -d $queue && -n $out ]] || { print -u2 "usage: watch-links.zsh --queue DIR --out FILE"; exit 1 }
queue=${queue:A} out=${out:A}


done_n=0
while true; do
  jobs_left=($queue/*.url(N.Om))
  (( $#jobs_left )) || break
  job=$jobs_left[1]
  url=$(<$job)
  code=$("$here/video-pack-id.zsh" "$url" 2>/dev/null) || code=""
  print -- "--- $url"
  if [[ -n $code ]]; then
    "$here/watch-reel.zsh" "$url" || print "  ! watch-reel failed for $code"
    if [[ -z ${WATCH_NO_RESOURCES:-} ]]; then
      "$here/extract-reel-resources.py" "$code" | grep -E "^resources:|!" || true
    fi
    "$here/reels-to-captures.py" --pack "$code" >> "$out" || print "  ! no record for $code (the pack did not finish)"
  else
    print "  ? not a video link this worker can watch: $url"
  fi
  rm -f "$job"
  done_n=$(( done_n + 1 ))
done
print -- "--- watched $done_n"
