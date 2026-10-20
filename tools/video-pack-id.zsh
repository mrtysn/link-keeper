#!/bin/zsh
# DESC: Print the watch-pack name for a video link (Instagram reel or post, YouTube video, X post), or fail for any other link.
#
# One rule for every tool that names a pack: an Instagram reel or post keeps its bare shortcode (the
# packs made before YouTube and X), a YouTube video is yt-<id>, an X post is x-<status id>. The helper
# (native/link-keeper-bridge.py WATCHABLE) and the extension (background.js WATCHABLE) keep the same
# patterns; tools/test-reel-resources.py checks the three agree.
#
# Usage: video-pack-id.zsh URL      prints the name and exits 0, or exits 1 for a link no pack is made for

set -euo pipefail

url=${1:-}
[[ $url == -h || $url == --help ]] && { sed -n '2,9p' "$0" | sed -E 's/^# ?//'; exit 0 }

if [[ $url =~ '^https?://(www\.)?instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+)' ]]; then
  print -r -- $match[3]
elif [[ $url =~ '^https?://((www|m)\.)?youtube\.com/(watch\?(.*&)?v=|shorts/)([A-Za-z0-9_-]{11})' ]]; then
  print -r -- yt-$match[5]
elif [[ $url =~ '^https?://youtu\.be/([A-Za-z0-9_-]{11})' ]]; then
  print -r -- yt-$match[1]
elif [[ $url =~ '^https?://((www|mobile)\.)?(x|twitter)\.com/[A-Za-z0-9_]+/status/([0-9]+)' ]]; then
  print -r -- x-$match[4]
else
  exit 1
fi
