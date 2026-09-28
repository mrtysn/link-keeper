#!/bin/zsh
# DESC: Register the open-local-files helper with Firefox so restored file: tabs reopen for real.
#
# Writes Firefox's native-messaging manifest for the helper into the per-user host folder, pointing
# at open-local-files.py where this repo sits. Rerun after moving the repo. --uninstall removes it.
#
# Usage: native/install.zsh [--uninstall]

set -euo pipefail

name=link_keeper_open_files
here=${0:A:h}
helper=$here/open-local-files.py
hosts="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
manifest=$hosts/$name.json

case ${1:-} in
  -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --uninstall) rm -f "$manifest"; print "removed $manifest"; exit 0 ;;
  "") ;;
  *) print -u2 "unknown argument: $1 (see --help)"; exit 2 ;;
esac

[[ -x /usr/bin/python3 ]] || { print -u2 "/usr/bin/python3 is missing; install the Xcode command line tools"; exit 1 }
chmod +x "$helper"
mkdir -p "$hosts"
/usr/bin/python3 - "$manifest" "$name" "$helper" <<'EOF'
import json, sys
path, name, helper = sys.argv[1:]
json.dump({
    "name": name,
    "description": "Reopen Link Keeper's stashed file: tabs",
    "path": helper,
    "type": "stdio",
    "allowed_extensions": ["link-keeper@mrtysn.github.io"],
}, open(path, "w"), indent=2)
EOF
print "registered $name → $helper"
