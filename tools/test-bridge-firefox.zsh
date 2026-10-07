#!/bin/zsh
# DESC: Check Link Keeper's bridge in a headless Firefox: backups, restore, agent undo, and the CLI on the live socket.
#
# Runs tools/e2e-bridge.js beside the real extension, with the real helper writing its backups and
# socket into a temporary folder (passed down through Firefox's environment). When the script
# signals, this drives tools/link-keeper.mjs against the live socket, and the script checks what
# landed. Needs the helper registered: native/install.zsh.
#
# Usage: tools/test-bridge-firefox.zsh

set -euo pipefail

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

here=${0:A:h}
repo=${here:h}
[[ -f "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/link_keeper_bridge.json" ]] ||
  { print -u2 "the bridge is not registered; run native/install.zsh"; exit 1 }

work=$(mktemp -d "${TMPDIR:-/tmp}/lk-bridge-ff.XXXXXX")
export LINK_KEEPER_BACKUP_DIR=$work/backups LINK_KEEPER_STATE_DIR=$work/state
trap 'kill $run 2>/dev/null; wait $run 2>/dev/null; rm -rf "$work"' EXIT INT TERM

"$here/run-in-headless-firefox.zsh" --timeout 240 --extension "$repo/extension" "$here/e2e-bridge.js" > "$work/report" 2>&1 &
run=$!

lk() { node "$here/link-keeper.mjs" "$@" }
cli_failed=0
cli_check() {
  local name=$1; shift
  if out=$("$@" 2>&1); then print "ok   cli: $name"; else print "FAIL cli: $name: $out"; cli_failed=1; fi
}

# The script sets the screenshot folder to cli-go when it is ready for the CLI.
for i in {1..120}; do
  [[ -S $LINK_KEEPER_STATE_DIR/bridge.sock ]] && lk call get-folder 2>/dev/null | grep -q '"cli-go"' && break
  kill -0 $run 2>/dev/null || break
  sleep 1
done
if kill -0 $run 2>/dev/null; then
  cli_check "status says live" zsh -c "node '$here/link-keeper.mjs' status | grep -q '^live: Link Keeper'"
  cli_check "links lists the captured link" zsh -c "node '$here/link-keeper.mjs' links --filter captured | grep -q 'https://example.org/cap'"
  cli_check "capture prints the text" zsh -c "node '$here/link-keeper.mjs' capture https://example.org/cap | grep -q 'captured text'"
  cli_check "add" lk add https://example.org/from-cli
  cli_check "tag --add" lk tag https://example.org/from-cli --add cli
  cli_check "history lists the CLI's changes" zsh -c "node '$here/link-keeper.mjs' history | grep -q set-tags"
  cli_check "tabs stay out of reach" zsh -c "! node '$here/link-keeper.mjs' call stash"
  lk tag-create cli-done > /dev/null
fi

wait $run && ff=0 || ff=$?
run=""
cat "$work/report"
(( ff == 0 && cli_failed == 0 ))
