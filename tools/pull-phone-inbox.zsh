#!/bin/zsh
# DESC: Mirror the phone-share inbox from its server into DATA_DIR, and say which links are new since the last mirror.
#
# The phone's share sheet posts to receiver/link-inbox-receiver.py on an always-on box, which appends
# `URL<TAB>YYYY-MM-DD<TAB>client` lines to its inbox. This copies that file over ssh to
# $DATA_DIR/link-inbox.tsv (LINK_INBOX_REMOTE=host:/path in config.local.sh). The import runs it as its
# first step, and the helper runs it when Links opens, so a link shared from the phone shows up without
# an Import.
#
# Usage:
#   pull-phone-inbox.zsh                # mirror; print a one-line summary
#   pull-phone-inbox.zsh --print-new    # mirror; print the new lines (URL<TAB>date) on stdout only
#
# Exit: 0 mirrored, 2 the server could not be reached (the last mirror stays), 3 not configured.
# A new line is one whose URL the previous mirror did not have: the inbox only grows, so this is what
# arrived since the last pull by either path.

set -euo pipefail

here=${0:A:h}
repo=${here:h}

print_new=0
case ${1:-} in
  --print-new) print_new=1 ;;
  -h|--help) sed -n '2,15p' "$0" | sed -E 's/^# ?//'; exit 0 ;;
  "") ;;
  *) print -u2 "unknown argument: $1"; exit 1 ;;
esac

env_data=${DATA_DIR:-} env_remote=${LINK_INBOX_REMOTE:-}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
DATA_DIR=${env_data:-${DATA_DIR:-$repo/data}}
LINK_INBOX_REMOTE=${env_remote:-${LINK_INBOX_REMOTE:-}}

say() { (( print_new )) && print -u2 -r -- "$1" || print -r -- "$1" }

[[ -n $LINK_INBOX_REMOTE ]] || { say "  phone inbox not configured (LINK_INBOX_REMOTE in config.local.sh)"; exit 3 }
mkdir -p "$DATA_DIR"
inbox=$DATA_DIR/link-inbox.tsv
r_host=${LINK_INBOX_REMOTE%%:*} r_path=${LINK_INBOX_REMOTE#*:}

if ! ssh -o ConnectTimeout=6 -o BatchMode=yes "$r_host" cat "$r_path" > "$inbox.tmp" 2>/dev/null; then
  rm -f "$inbox.tmp"
  say "  ! could not reach $r_host — using the last mirror"
  exit 2
fi

typeset -A had
if [[ -s $inbox ]]; then
  for line in ${(f)"$(<$inbox)"}; do had[${line%%$'\t'*}]=1; done
fi
new=()
for line in ${(f)"$(<$inbox.tmp)"}; do
  [[ -n $line && -z ${had[${line%%$'\t'*}]:-} ]] && new+=$line
done
mv "$inbox.tmp" "$inbox"

if (( print_new )); then
  for line in $new; do
    url=${line%%$'\t'*} day=""
    [[ $line == *$'\t'* ]] && { day=${line#*$'\t'}; day=${day%%$'\t'*} }
    print -r -- "$url"$'\t'"$day"
  done
else
  print "  $(grep -c . "$inbox" || true) in the inbox (mirror of $r_host), $#new new"
fi
