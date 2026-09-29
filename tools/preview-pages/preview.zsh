#!/bin/zsh
# DESC: Render the popup and list pages outside Firefox, with a fake extension API and real capture text.
#
# Builds out/ beside this script: each extension page with the fake API injected ahead of its own
# script, and mock data drawn from a capture JSONL. Then serves it on loopback until interrupted.
# Script URLs carry a build stamp, so a rebuild is never masked by the browser cache.
#
# Usage:
#   preview.zsh                          # build, then serve on 127.0.0.1:8766
#   preview.zsh --port 9000
#   preview.zsh --no-serve               # build only; rerun after editing a page
#   preview.zsh --captures file.jsonl    # default: $DATA_DIR/link-captures-all.jsonl
#
# Pages: frame.html shows three popup states side by side; popup.html, list.html, cards.html and
# sessions.html open alone.
# Query flags on either page:
#   msg      restore a message, as if a keep just happened
#   add      open "Add links"            house   open "Export and housekeeping"
#   onpage   a list item is open in the current tab
#   light    drop the dark-scheme rules to show the light palette
#   empty    sessions.html with nothing stashed
#   settings, import   sessions.html with that panel open
#   import-run         sessions.html importing 300 tabs, slowly enough to see the progress
#   view=day|month     sessions.html grouped by date
#
# DATA_DIR comes from the environment, else from config.local.sh at the repo root, else this
# repo's own data/. out/ holds captured text and is gitignored.

set -euo pipefail

here=${0:A:h}
repo=${here:h:h}
ext=$repo/extension
out=$here/out

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

port=8766
serve=1
captures=""
while (( $# )); do
  case $1 in
    --port) port=${2:?--port needs a number}; shift 2 ;;
    --no-serve) serve=0; shift ;;
    --captures) captures=${2:?--captures needs a file}; shift 2 ;;
    *) print -u2 "unknown argument: $1 (see --help)"; exit 2 ;;
  esac
done

if [[ -z $captures ]]; then
  env_data=${DATA_DIR:-}
  [[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
  data=${env_data:-${DATA_DIR:-$repo/data}}
  captures=$data/link-captures-all.jsonl
fi
[[ -f $captures ]] || { print -u2 "no such capture file: $captures"; exit 1 }

mkdir -p "$out"
stamp=$(date +%s)
for page in popup list cards sessions standin stash-cards; do
  sed -e "s#<meta charset=\"utf-8\">#<meta charset=\"utf-8\"><meta name=\"darkreader-lock\">#" \
      -e "s#<script src=\"$page.js\"></script>#<script src=\"mock-data.js?v=$stamp\"></script><script src=\"mock-browser.js?v=$stamp\"></script><script src=\"$page.js?v=$stamp\"></script>#" \
      "$ext/$page.html" > "$out/$page.html"
  ln -sf "$ext/$page.js" "$out/$page.js"
done
ln -sf "$ext/icons.js" "$out/icons.js"
ln -sf "$ext/stash-import.js" "$out/stash-import.js"
ln -sf "$here/mock-browser.js" "$out/mock-browser.js"
ln -sf "$here/frame.html" "$out/frame.html"
python3 "$here/make-mock.py" "$captures" "$out/mock-data.js"

(( serve )) || exit 0
print "http://127.0.0.1:$port/frame.html"
print "http://127.0.0.1:$port/list.html"
print "http://127.0.0.1:$port/cards.html"
print "http://127.0.0.1:$port/sessions.html"
print "http://127.0.0.1:$port/stash-cards.html"
print "http://127.0.0.1:$port/standin.html?url=file:///tmp/x.html&title=Report&why=the+helper+is+not+installed"
cd "$out"
exec python3 -m http.server "$port" --bind 127.0.0.1
