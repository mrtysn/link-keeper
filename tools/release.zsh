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
#   tools/release.zsh --no-open  # the same release, the signed xpi's path printed instead of opened
#   tools/release.zsh --finish   # a version already submitted but not yet signed: fetch it, open it, commit it
#
# Refuses while a capture run is going or paused: installing the release would reset it.
# Needs a clean tree (the batch committed) and Doppler's firefox-signing project for AMO's keys.
# If AMO's approval outlasts web-ext's wait, the version is submitted but not downloaded: the script
# then waits for it (up to 15 minutes) and fetches it with tools/fetch-signed-xpi.py. Still unsigned
# after that, the manifest keeps the new version and --finish completes the release later; running the
# whole release again would only be refused as "already submitted".

set -euo pipefail

here=${0:A:h}
repo=${here:h}
ext=$repo/extension
manifest=$ext/manifest.json

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '4,19p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
dry=0
no_open=0
finish=0
[[ ${1:-} == --dry-run ]] && dry=1
[[ ${1:-} == --no-open ]] && no_open=1
[[ ${1:-} == --finish ]] && finish=1

# Installing a release reloads the add-on, which drops a capture run in progress (its state is in
# storage.session). On 2026-10-20 releases shipped mid-run reset the owner's run four times; a run that is
# going or paused holds every release until it ends, is stopped, or is dismissed.
queue=$(node "$repo/tools/link-keeper.mjs" call capture-queue-status 2>/dev/null \
  | python3 -c 'import json,sys; q=json.load(sys.stdin); print(q.get("status",""), q.get("captured",0)+q.get("skipped",0)+len(q.get("failed",[])), q.get("total",0))' 2>/dev/null || true)
if [[ $queue == running* || $queue == paused* ]]; then
  read -r qstatus qdone qtotal <<< "$queue"
  print -u2 "a capture run is $qstatus ($qdone of $qtotal done); a release now would reset it."
  print -u2 "Wait for it to finish, or Stop it on the Capture page, then release."
  exit 1
fi

signing=(doppler run --project firefox-signing --config prd --)
version_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest" }
set_version() { sed -i '' "s/\"version\": \"$1\"/\"version\": \"$2\"/" "$manifest" }

# Fetches a submitted version, waiting while AMO has it unsigned. 0 fetched, 3 still unsigned, 4 not on AMO.
fetch_signed() {
  local code
  for i in {1..30}; do
    (cd "$repo" && "${signing[@]}" tools/fetch-signed-xpi.py --version "$1") && return 0
    code=$?
    (( code == 3 )) || return $code
    (( i == 1 )) && print "waiting for AMO to sign $1 (up to 15 minutes)"
    sleep 30
  done
  return 3
}

if (( finish )); then
  next=$(version_of)
  if [[ -n $(git -C "$repo" status --porcelain | grep -v ' extension/manifest.json$') ]]; then
    print -u2 "--finish expects only the manifest's version changed; commit the rest first"
    exit 1
  fi
  print "finishing: $next"
  if ! fetch_signed "$next"; then
    print -u2 "$next is not signed yet; run tools/release.zsh --finish again later"
    exit 1
  fi
else
  if [[ -n $(git -C "$repo" status --porcelain) ]]; then
    print -u2 "the tree has uncommitted changes; commit the batch first"
    exit 1
  fi

  current=$(version_of)
  next=${current%.*}.$(( ${current##*.} + 1 ))
  print "release: $current → $next"
  (( dry )) && { print "dry run: nothing changed"; exit 0 }

  set_version "$current" "$next"

  if ! (cd "$ext" && "${signing[@]}" npx web-ext sign --channel unlisted); then
    xpis=("$ext"/web-ext-artifacts/*-"$next".xpi(N))
    if (( ! ${#xpis} )); then
      fetch_signed "$next" && code=0 || code=$?
      if (( code == 3 )); then
        # Submitted: the number is AMO's now, and a new release would be refused as already submitted.
        print -u2 "$next is submitted but AMO has not signed it yet; the manifest stays at $next."
        print -u2 "Run tools/release.zsh --finish later to fetch, open and commit it."
        exit 1
      elif (( code != 0 )); then
        # A refusal (throttled, invalid) leaves no version on AMO: put the number back.
        set_version "$next" "$current"
        print -u2 "signing failed; the version is back at $current"
        exit 1
      fi
    fi
  fi
fi

xpis=("$ext"/web-ext-artifacts/*-"$next".xpi(N))
(( ${#xpis} )) || { print -u2 "signed, but no $next xpi in web-ext-artifacts"; exit 1 }
print "signed: ${xpis[1]}"

# In front, so Firefox's install prompt is on screen.
(( no_open )) || open -a Firefox "${xpis[1]}"

git -C "$repo" add extension/manifest.json
git -C "$repo" commit -qm "ship $next as a signed release"
git -C "$repo" push -q
if (( no_open )); then
  print "committed and pushed; open this in Firefox to install $next:"
  print "${xpis[1]:A}"
else
  print "committed and pushed; click Add in Firefox to install $next"
fi
