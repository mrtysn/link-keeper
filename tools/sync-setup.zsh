#!/bin/zsh
# DESC: Set up sync between Macs: make the key and device tokens, store this Mac's in the Keychain, hand out the rest.
#
# On the first Mac, the one whose data becomes everyone's (the seed):
#   tools/sync-setup.zsh seed --url https://HOST --other NAME [--other NAME ...] --out DIR
#     makes one encryption key and a token per device, stores this Mac's token and the key in the
#     login Keychain (service link-keeper-sync), sets LINK_KEEPER_SYNC_URL and LINK_KEEPER_SYNC_SEED=1
#     in config.local.sh, and writes to DIR: tokens.json (SHA-256 of every token, for the server's
#     data/ folder) and NAME.secrets per other Mac (its token and the key: secret, move it by hand and
#     delete it once joined).
# On every other Mac:
#   tools/sync-setup.zsh join --url https://HOST --secrets FILE
#     stores that Mac's token and the key in the Keychain, sets LINK_KEEPER_SYNC_URL, deletes FILE.
# Anywhere:
#   tools/sync-setup.zsh status      what is set up here (never prints a secret)
#
# This Mac's device name is --name, else its LocalHostName in lower case. Run native/install.zsh too,
# then restart Firefox or open Links: the add-on syncs on its next connection.

set -euo pipefail

script=${0:A}
here=${script:h}
repo=${here:h}
conf=$repo/config.local.sh
service=link-keeper-sync

usage() { sed -n '2,20p' $script | sed 's/^# \{0,1\}//'; exit ${1:-0} }
[[ $# -eq 0 || $1 == -h || $1 == --help ]] && usage

mode=$1; shift
url="" out="" secrets="" name="" others=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) url=${2%/}; shift 2 ;;
    --out) out=${2:A}; shift 2 ;;
    --secrets) secrets=${2:A}; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --other) others+=($2); shift 2 ;;
    *) print -u2 "unknown argument: $1"; usage 2 ;;
  esac
done
[[ -n $name ]] || name=${(L)$(scutil --get LocalHostName)}
[[ $name =~ '^[a-z0-9-]+$' ]] || { print -u2 "device name must be lowercase letters, digits and dashes: $name"; exit 2 }

keychain_set() {   # account value
  security add-generic-password -U -s $service -a $1 -w "$2" > /dev/null
}
keychain_has() { security find-generic-password -s $service -a $1 > /dev/null 2>&1 }

# Set NAME=value in config.local.sh, replacing an earlier line for it.
conf_set() {
  /usr/bin/python3 - $conf $1 $2 <<'EOF'
import os, re, sys
path, key, value = sys.argv[1:]
lines = open(path).read().splitlines() if os.path.exists(path) else []
line = f'{key}="{value}"'
for i, l in enumerate(lines):
    if re.match(rf"^\s*(export\s+)?{key}=", l):
        lines[i] = line
        break
else:
    lines.append(line)
tmp = path + ".tmp"
open(tmp, "w").write("\n".join(lines) + "\n")
os.replace(tmp, path)
EOF
}

new_token() { print -r -- "$1.$(openssl rand -hex 24)" }
sha() { print -rn -- "$1" | shasum -a 256 | cut -d' ' -f1 }

case $mode in
  seed)
    [[ -n $url && -n $out && ${#others} -gt 0 ]] || usage 2
    [[ $url == https://* || $url == http://127.0.0.1:* ]] || { print -u2 "the server address must be https://"; exit 2 }
    if keychain_has key || keychain_has token; then
      print -u2 "this Mac already holds sync secrets (security find-generic-password -s $service); remove them first to start over"
      exit 1
    fi
    mkdir -p -m 700 $out
    key=$(openssl rand -base64 32)
    mine=$(new_token $name)
    hashes=("$name" "$(sha $mine)")
    for other in $others; do
      [[ $other =~ '^[a-z0-9-]+$' && $other != $name ]] || { print -u2 "bad or repeated device name: $other"; exit 2 }
      token=$(new_token $other)
      hashes+=("$other" "$(sha $token)")
      ( umask 077; print -r -- "{\"device\": \"$other\", \"token\": \"$token\", \"key\": \"$key\"}" > $out/$other.secrets )
    done
    /usr/bin/python3 -c 'import json, sys; a = sys.argv[1:]; print(json.dumps(dict(zip(a[::2], a[1::2])), indent=2))' $hashes > $out/tokens.json
    keychain_set key $key
    keychain_set token $mine
    conf_set LINK_KEEPER_SYNC_URL $url
    conf_set LINK_KEEPER_SYNC_SEED 1
    print "this Mac is $name, the seed; its token and the key are in the Keychain ($service)"
    print "for the server's data/ folder: $out/tokens.json"
    for other in $others; do print "for $other, secret, move by hand: $out/$other.secrets"; done
    ;;
  join)
    [[ -n $url && -f $secrets ]] || usage 2
    [[ $url == https://* ]] || { print -u2 "the server address must be https://"; exit 2 }
    device=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["device"])' $secrets)
    token=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["token"])' $secrets)
    key=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["key"])' $secrets)
    keychain_set key $key
    keychain_set token $token
    conf_set LINK_KEEPER_SYNC_URL $url
    rm -f -- $secrets
    print "this Mac is $device; its token and the key are in the Keychain ($service); $secrets deleted"
    ;;
  status)
    print "device token: $(keychain_has token && print 'in the Keychain' || print missing)"
    print "key:          $(keychain_has key && print 'in the Keychain' || print missing)"
    print "server:       $(grep -s '^LINK_KEEPER_SYNC_URL=' $conf | cut -d= -f2- || print 'not set in config.local.sh')"
    print "seed:         $(grep -qs '^LINK_KEEPER_SYNC_SEED="\{0,1\}1' $conf && print yes || print no)"
    ;;
  *) usage 2 ;;
esac
