#!/bin/zsh
# DESC: Register Link Keeper's native helpers with Firefox: reopening local-file tabs, and the bridge for backups and agents.
#
# Writes Firefox's native-messaging manifests into the per-user host folder, pointing at the
# helpers where this repo sits:
#   link_keeper_open_files  open-local-files.py   reopens stashed file: tabs
#   link_keeper_bridge      link-keeper-bridge.py backs storage up to LINK_KEEPER_BACKUP_DIR and
#                                                 serves tools/link-keeper.mjs (set the folder in
#                                                 config.local.sh)
# Rerun after moving the repo. --uninstall removes both.
#
# Usage: native/install.zsh [--uninstall]

set -euo pipefail

here=${0:A:h}
hosts="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
typeset -A helpers=(
  link_keeper_open_files "open-local-files.py|Reopen Link Keeper's stashed file: tabs"
  link_keeper_bridge "link-keeper-bridge.py|Back Link Keeper up to disk and let local agents reach it"
)

case ${1:-} in
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --uninstall)
    for name in ${(k)helpers}; do rm -f "$hosts/$name.json"; print "removed $hosts/$name.json"; done
    exit 0 ;;
  "") ;;
  *) print -u2 "unknown argument: $1 (see --help)"; exit 2 ;;
esac

[[ -x /usr/bin/python3 ]] || { print -u2 "/usr/bin/python3 is missing; install the Xcode command line tools"; exit 1 }
mkdir -p "$hosts"
for name in ${(k)helpers}; do
  helper=$here/${helpers[$name]%%|*}
  chmod +x "$helper"
  /usr/bin/python3 - "$hosts/$name.json" "$name" "$helper" "${helpers[$name]#*|}" <<'EOF'
import json, sys
path, name, helper, description = sys.argv[1:]
json.dump({
    "name": name,
    "description": description,
    "path": helper,
    "type": "stdio",
    "allowed_extensions": ["link-keeper@mrtysn.github.io"],
}, open(path, "w"), indent=2)
EOF
  print "registered $name → $helper"
done

[[ -f ${here:h}/config.local.sh ]] && grep -q '^LINK_KEEPER_BACKUP_DIR=' "${here:h}/config.local.sh" ||
  print -u2 "note: set LINK_KEEPER_BACKUP_DIR in config.local.sh, or the bridge writes no backups"
