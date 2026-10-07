#!/bin/zsh
# DESC: Ship the extension: bump its version, sign it on AMO, open it in Firefox, commit the release.
#
# One signed release per finished batch, not per change: commit and push changes as they land, and
# run this once when the batch is done. addons.mozilla.org throttles signing per account (3 a
# minute, 10 an hour, 24 a day); a throttled account cannot update the add-on for up to a day.
#
# Usage:
#   tools/release.zsh            # 5.45 → 5.46: sign, fetch, open in Firefox, commit "ship 5.46 …", push
#   tools/release.zsh --dry-run  # say what it would do, change nothing
#
# Needs a clean tree (the batch committed) and Doppler's firefox-signing project for AMO's keys.
# If AMO's approval outlasts web-ext's wait, the version is submitted but not downloaded: the script
# then fetches it with tools/fetch-signed-xpi.py.

set -euo pipefail

here=${0:A:h}
repo=${here:h}
ext=$repo/extension
manifest=$ext/manifest.json

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '4,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
dry=0
[[ ${1:-} == --dry-run ]] && dry=1

if [[ -n $(git -C "$repo" status --porcelain) ]]; then
  print -u2 "the tree has uncommitted changes; commit the batch first"
  exit 1
fi

current=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")
next=${current%.*}.$(( ${current##*.} + 1 ))
print "release: $current → $next"
(( dry )) && { print "dry run: nothing changed"; exit 0 }

set_version() { sed -i '' "s/\"version\": \"$1\"/\"version\": \"$2\"/" "$manifest" }
set_version "$current" "$next"

signing=(doppler run --project firefox-signing --config prd --)
if ! (cd "$ext" && "${signing[@]}" npx web-ext sign --channel unlisted); then
  xpis=("$ext"/web-ext-artifacts/*-"$next".xpi(N))
  if (( ! ${#xpis} )); then
    # A refusal (throttled, invalid) leaves no version on AMO: put the number back.
    if ! (cd "$repo" && "${signing[@]}" tools/fetch-signed-xpi.py --version "$next"); then
      set_version "$next" "$current"
      print -u2 "signing failed; the version is back at $current"
      exit 1
    fi
  fi
fi

xpis=("$ext"/web-ext-artifacts/*-"$next".xpi(N))
(( ${#xpis} )) || { print -u2 "signed, but no $next xpi in web-ext-artifacts"; exit 1 }
print "signed: ${xpis[1]}"

# In front, so Firefox's install prompt is on screen.
open -a Firefox "${xpis[1]}"

git -C "$repo" add extension/manifest.json
git -C "$repo" commit -qm "ship $next as a signed release"
git -C "$repo" push -q
print "committed and pushed; click Add in Firefox to install $next"
