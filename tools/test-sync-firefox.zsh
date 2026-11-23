#!/bin/zsh
# DESC: Check sync between Macs end to end: headless Firefoxes with the real helper and a local sync server.
#
# Starts sync-server/server.py on a free loopback port with two device tokens, then runs
# tools/e2e-sync.js three times, each in a fresh throwaway profile: as the seed (writes the first
# snapshot, sends a change), as a second Mac (takes the snapshot, sends its own change), and as the
# first Mac again from scratch (must hold both). The helper gets the server address, token and key from
# the environment, so the Keychain and config.local.sh are never read. Needs native/install.zsh run once.
#
# Usage: tools/test-sync-firefox.zsh

set -euo pipefail

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

here=${0:A:h}
repo=${here:h}
[[ -f "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/link_keeper_bridge.json" ]] ||
  { print -u2 "the bridge is not registered; run native/install.zsh"; exit 1 }

work=$(mktemp -d "${TMPDIR:-/tmp}/lk-sync-ff.XXXXXX")
server_pid=""
trap '[[ -n $server_pid ]] && kill $server_pid 2>/dev/null; rm -rf "$work"' EXIT INT TERM

port=$(( 20000 + RANDOM % 20000 ))
token_a="mac-a.$(openssl rand -hex 16)" token_b="mac-b.$(openssl rand -hex 16)"
mkdir -p "$work/server"
/usr/bin/python3 - "$work/server/tokens.json" "$token_a" "$token_b" <<'EOF'
import hashlib, json, sys
path, *tokens = sys.argv[1:]
json.dump({t.split(".")[0]: hashlib.sha256(t.encode()).hexdigest() for t in tokens}, open(path, "w"))
EOF
LKS_DATA=$work/server LKS_PORT=$port /usr/bin/python3 "$repo/sync-server/server.py" 2> "$work/server.log" &
server_pid=$!
for i in {1..50}; do curl -sf "http://127.0.0.1:$port/healthz" > /dev/null && break; sleep 0.1; done

export LINK_KEEPER_SYNC_URL=http://127.0.0.1:$port LINK_KEEPER_SYNC_KEY=$(openssl rand -base64 32)
failed=0
run_role() {
  local role=$1 token=$2 seed=$3
  print -r -- "const ROLE = \"$role\";" | cat - "$here/e2e-sync.js" > "$work/e2e-$role.js"
  print -r -- "--- $role"
  if ! LINK_KEEPER_SYNC_TOKEN=$token LINK_KEEPER_SYNC_SEED=$seed \
      "$here/run-in-headless-firefox.zsh" --timeout 180 --backup-dir "$work/$role/backups" --state-dir "$work/$role/state" \
      --extension "$repo/extension" "$work/e2e-$role.js"; then
    failed=1
  fi
}
run_role seed "$token_a" 1
run_role join "$token_b" 0
run_role rejoin "$token_a" 0

if grep -q "e2e-seed\|from-seed\|seeded text" "$work/server/sync.db" 2>/dev/null; then
  print "FAIL the server's database holds readable link data"; failed=1
else
  print "ok   the server's database holds no readable link data"
fi
(( failed == 0 ))
