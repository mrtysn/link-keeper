#!/bin/zsh
# DESC: Build the page preview, serve it, and run the shared-keys checks against List, Cards, Explore and Tag.
#
# Usage: test-keys.zsh [--port 8767]
# Playwright and its Chromium are installed once into .deps/ beside this script (gitignored).

set -euo pipefail

here=${0:A:h}
port=8767
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
[[ ${1:-} == --port ]] && port=$2

deps=$here/.deps
if [[ ! -d $deps/node_modules/playwright ]]; then
  mkdir -p "$deps"
  npm install --prefix "$deps" --silent playwright@1 >/dev/null
  "$deps/node_modules/.bin/playwright" install chromium >/dev/null
fi

"$here/preview.zsh" --no-serve >/dev/null
python3 -m http.server "$port" --bind 127.0.0.1 -d "$here/out" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
PLAYWRIGHT=$deps/node_modules/playwright/index.mjs node "$here/test-keys.mjs" "http://127.0.0.1:$port/"
