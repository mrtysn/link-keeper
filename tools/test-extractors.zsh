#!/bin/zsh
# DESC: Check in headless Firefox that an x.com capture holds every rendered reply, and that a page walk gathers the ones x.com drops while scrolling.
#
# Usage: test-extractors.zsh [--port 8793]
# Serves the saved x.com pages in tools/extractor-fixtures/ on 127.0.0.1 (the extension may reach that
# host), then runs e2e-extractors.js beside the real extension through run-in-headless-firefox.zsh.

set -euo pipefail

here=${0:A:h}
repo=${here:h}
port=8793
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
[[ ${1:-} == --port ]] && port=$2

python3 "$here/extractor-fixtures/serve.py" "$port" &
server=$!
work=$(mktemp -d "${TMPDIR:-/tmp}/extractors.XXXXXX")
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT
sleep 1
{ print "const PORT = $port;"; cat "$here/e2e-extractors.js" } > "$work/probe.js"
"$here/run-in-headless-firefox.zsh" --extension "$repo/extension" "$work/probe.js"
