#!/bin/zsh
# DESC: Screenshot a preview page (Cards, List, ...) at chosen widths into the gitignored out/ folder.
#
# Usage: shoot-page.zsh PAGE [--widths 600,1200] [--name NAME] [--deal VALUE] [--until SELECTOR] [--click SELECTOR]... [--port 8768]
#   PAGE      page path with its query flags, e.g. "cards.html?suggest" (see preview.zsh --help)
#   --deal    Cards only: the deck selector's option: "suggested" (the Suggested deck), else its value
#   --until   Cards only: press S until this CSS selector matches, e.g. ".card.top .suggestrow .src"
#   --click   click this CSS selector before the shot; repeat it to click several, in order
# Writes out/NAME-WIDTH.png beside the preview and prints each path. Playwright and its Chromium
# are installed once into .deps/ beside this script (gitignored).

set -euo pipefail

here=${0:A:h}
if [[ ${1:-} == -h || ${1:-} == --help || $# -eq 0 ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
page=$1; shift
widths=600,1200
name=${page%%[.?]*}
port=8768
extra=()
while (( $# )); do
  case $1 in
    --widths) widths=${2:?--widths needs a list}; shift 2 ;;
    --name) name=${2:?--name needs a name}; shift 2 ;;
    --port) port=${2:?--port needs a number}; shift 2 ;;
    --deal) extra+=(--deal "${2:?--deal needs a value}"); shift 2 ;;
    --until) extra+=(--until "${2:?--until needs a selector}"); shift 2 ;;
    --click) extra+=(--click "${2:?--click needs a selector}"); shift 2 ;;
    *) print -u2 "unknown argument: $1 (see --help)"; exit 2 ;;
  esac
done

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
OUT_DIR=$here/out PLAYWRIGHT=$deps/node_modules/playwright/index.mjs \
  node "$here/shoot-page.mjs" "http://127.0.0.1:$port/" "$page" "$widths" "$name" "${extra[@]}"
