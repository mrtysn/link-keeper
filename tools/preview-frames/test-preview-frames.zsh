#!/bin/zsh
# DESC: Check in headless Firefox that the Links detail pane's live preview can frame pages that forbid framing, and nothing else can.
#
# Usage: test-preview-frames.zsh [--port 8791]
# Serves pages with X-Frame-Options and frame-ancestors on 127.0.0.1 (the extension may reach that
# host), then runs e2e-preview-frames.js beside the real extension through run-in-headless-firefox.zsh.

set -euo pipefail

here=${0:A:h}
repo=${here:h:h}
port=8791
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
[[ ${1:-} == --port ]] && port=$2
# Another session's server may hold the port (a studio server took 8791 on 2026-10-20, and every check
# then failed as if framing were broken): move to the next free one.
while lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; do
  print -u2 "port $port is taken; trying $(( port + 1 ))"
  port=$(( port + 1 ))
done

python3 "$here/serve-framing-headers.py" "$port" &
server=$!
work=$(mktemp -d "${TMPDIR:-/tmp}/preview-frames.XXXXXX")
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT
sleep 1
{ print "const PORT = $port;"; cat "$here/e2e-preview-frames.js" } > "$work/probe.js"
"$repo/tools/run-in-headless-firefox.zsh" --extension "$repo/extension" "$work/probe.js"
