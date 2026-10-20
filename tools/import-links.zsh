#!/bin/zsh
# DESC: One command: find the newest exports, rebuild everything, hand it to the extension.
#
# After exporting from Telegram (and, optionally, Instagram or X), run this. Nothing else. It picks the
# newest Telegram export and the newest Instagram export that actually contains messages, resolves
# every link it can without a browser, rebuilds the safe-to-delete and link-triage pages, and then puts the result behind a
# loopback URL — the extension's list page pulls it in by itself, so there is no file to choose and
# nothing to paste.
#
# Usage:
#   import-links.zsh                     # newest export, paths from config.local.sh
#   import-links.zsh <path/to/result.json>
#   import-links.zsh <result.json> <outdir>
#   import-links.zsh --no-serve          # rebuild only, do not offer it to the extension
#   import-links.zsh --no-open           # offer it, but do not open the browser yourself
#   import-links.zsh --offline           # no internet: parse the Instagram dump, keep the last lookups, hand over
#   import-links.zsh --no-watch          # everything but watching reels (download, transcript, resource list)
#
# --offline skips every step that reaches out — the phone-inbox mirror, the Saved Messages puller, the
# x.com and web lookups, the reel downloads — and keeps the files the last full
# run left. Links in the Instagram dump and the X archive's DMs are parsed and merged (X's as bare
# records: where and when they were sent, no text yet); links to other sites in the Instagram dump, and
# Telegram links, wait for the next full run. The extension skips a link it already holds, so it is safe to repeat.
#
# Paths come from config.local.sh at this repo's root — copy config.local.sh.example and fill it in.
# Nothing machine-specific is committed.
#
# link-captures-extra.jsonl in the output directory is merged and never overwritten: that is where
# records recovered by hand belong, and without it a rerun would silently drop them.
#
# The safe-to-delete and link-triage pages cover every source and are written to fixed filenames, since
# their marks and decisions live in browser storage keyed to the file; each is rebuilt only when its
# input changed.

set -euo pipefail

here=${0:A:h}
repo=${here:h}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,24p' "$0" | sed 's/^# \?//'
  exit 0
fi

# NOT `argv` — that name is zsh's alias for $@, and assigning it empties the positional
# parameters before the loop below ever reads them.
serve=1
open_page=1
offline=0
watch=1
args=()
for a in "$@"; do
  [[ $a == --no-serve ]] && { serve=0; continue }
  [[ $a == --no-open ]] && { open_page=0; continue }
  [[ $a == --offline ]] && { offline=1; continue }
  [[ $a == --no-watch ]] && { watch=0; continue }
  args+=$a
done

# --- configuration -------------------------------------------------------------
# Precedence: environment > config.local.sh > built-in default (this repo's own data/). The env
# value is captured before sourcing the config, which would otherwise clobber it.

env_tg=${TELEGRAM_EXPORT_DIR:-} env_ig=${INSTAGRAM_EXPORT_DIR:-} env_data=${DATA_DIR:-} env_port=${SERVE_PORT:-}
env_igacc=${INSTAGRAM_ACCOUNTS_DIR:-} env_x=${X_ARCHIVE_DIR:-}
typeset -A IG_ACCOUNTS    # account folder -> the thread slugs to read besides the self-thread
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
INSTAGRAM_ACCOUNTS_DIR=${env_igacc:-${INSTAGRAM_ACCOUNTS_DIR:-}}
TELEGRAM_EXPORT_DIR=${env_tg:-${TELEGRAM_EXPORT_DIR:-$HOME/Downloads/Telegram Desktop}}
INSTAGRAM_EXPORT_DIR=${env_ig:-${INSTAGRAM_EXPORT_DIR:-$HOME/Downloads}}
DATA_DIR=${env_data:-${DATA_DIR:-$repo/data}}
SERVE_PORT=${env_port:-${SERVE_PORT:-8790}}
X_ARCHIVE_DIR=${env_x:-${X_ARCHIVE_DIR:-$HOME/Downloads}}

# --- what to read, what to write ------------------------------------------------

if [[ -n ${args[1]:-} ]]; then
  export_json=${args[1]:A}
  [[ -f $export_json ]] || { print -u2 "no such export: $export_json"; exit 1 }
else
  # Newest export wins, by mtime rather than name: two exports on one day would tie lexically.
  # No export at all is tolerated: once the Saved Messages puller has a session, the export is
  # only the historical seed and the inbox carries everything since.
  newest=(${~TELEGRAM_EXPORT_DIR}/ChatExport_*/result.json(.Nom))
  export_json=${newest[1]:-}
fi

outdir=${args[2]:-$DATA_DIR}
if [[ -z ${args[2]:-} && $outdir == $repo/data ]]; then
  mkdir -p "$outdir"
else
  [[ -d $outdir ]] || { print -u2 "no such directory: $outdir"; exit 1 }
fi
inbox=$outdir/link-inbox.tsv

# Every run leaves a log, however it was started: a terminal run used to leave none, and a reel step
# that skipped 291 reels on 2026-10-15 could not be told apart from one that died.
exec > >(tee -a "$outdir/import.log") 2>&1
print -- "--- import $(date '+%F %T')${${offline:#0}:+ (offline)}"

# Instagram is optional: the newest instagram-* zip or unzipped directory that actually holds
# messages or saved posts. Instagram exports are per-request subsets, so a newer zip requested
# for something else (say, connections only) must not shadow the one with the links in it.
#
# With IG_ACCOUNTS set (config.local.sh), that is done once per account, in its own folder under
# INSTAGRAM_ACCOUNTS_DIR: an export carries no account name, so the folder is what says whose it is.
# Without it, the one newest export under INSTAGRAM_EXPORT_DIR is read, as before.
newest_ig_export() {   # $1: a directory holding instagram-* exports; prints the newest valid one
  local c
  for c in ${~1}/instagram-*(Nom); do
    [[ -d $c || $c == *.zip ]] || continue
    "$repo/importers/instagram.py" "$c" --check 2>/dev/null && { print -r -- "$c"; return 0 }
  done
  return 1
}

ig_accts=() ig_paths=()   # parallel: the account ("" without IG_ACCOUNTS) and its newest export
if (( ${#IG_ACCOUNTS} )); then
  [[ -n $INSTAGRAM_ACCOUNTS_DIR ]] || {
    print -u2 "IG_ACCOUNTS is set but INSTAGRAM_ACCOUNTS_DIR is not: set it in config.local.sh to the"
    print -u2 "folder whose subfolders are the accounts (see config.local.sh.example)"
    exit 1
  }
  for acct in ${(ko)IG_ACCOUNTS}; do
    found=$(newest_ig_export "$INSTAGRAM_ACCOUNTS_DIR/$acct") || found=""
    if [[ -n $found ]]; then
      ig_accts+=("$acct") ig_paths+=("$found")
    else
      print -u2 "! no instagram-* export for account $acct under ${INSTAGRAM_ACCOUNTS_DIR/#$HOME/~}/$acct"
    fi
  done
else
  found=$(newest_ig_export "$INSTAGRAM_EXPORT_DIR") || found=""
  [[ -z $found ]] || { ig_accts+=("") ig_paths+=("$found") }
fi

# instagram.py's arguments for the account at index $1 -> $reply. Without IG_ACCOUNTS there is one
# unnamed account, and the threads to read besides the self-thread come from IG_THREADS.
ig_account_args() {
  local acct=${ig_accts[$1]} s threads
  reply=()
  if [[ -n $acct ]]; then
    reply+=(--account "$acct")
    threads=${IG_ACCOUNTS[$acct]}
  else
    threads=${IG_THREADS:-}
  fi
  for s in ${=threads}; do reply+=(--thread "$s"); done
}

# X is optional too: the newest twitter-* archive (zip or folder) that holds direct messages. It reads
# the conversation with yourself, and the conversations named in X_THREADS.
x_archive=""
for c in ${~X_ARCHIVE_DIR}/twitter-*(Nom); do
  [[ -d $c || $c == *.zip ]] || continue
  "$repo/importers/x-archive.py" "$c" --check 2>/dev/null && { x_archive=$c; break }
done
x_args=()
[[ -n ${X_ACCOUNT:-} ]] && x_args+=(--account "$X_ACCOUNT")
for s in ${=X_THREADS:-}; do x_args+=(--thread "$s"); done

x_jsonl=$outdir/link-captures-x.jsonl
xdm_jsonl=$outdir/link-captures-xdm.jsonl
web_jsonl=$outdir/link-captures-web.jsonl
ig_jsonl=$outdir/link-captures-ig.jsonl
all_jsonl=$outdir/link-captures-all.jsonl
extra_jsonl=$outdir/link-captures-extra.jsonl
unresolved=$outdir/link-unresolved.tsv
safe_html=$outdir/safe-to-delete.html
triage_html=$outdir/link-triage.html

[[ -n $export_json ]] && print "export : ${export_json/#$HOME/~}"
for (( i = 1; i <= ${#ig_paths}; i++ )); do
  print "instagram : ${ig_paths[$i]/#$HOME/~}${ig_accts[$i]:+  (account ${ig_accts[$i]})}"
done
[[ -n $x_archive ]] && print "x archive : ${x_archive/#$HOME/~}${X_ACCOUNT:+  (account $X_ACCOUNT)}"
print "output : ${outdir/#$HOME/~}\n"

# --- mirror the phone-share inbox from its server, when configured ----------------

if (( offline )); then
  print "--offline: no internet steps (phone inbox, Saved Messages, lookups, reel downloads)"
elif [[ -n ${LINK_INBOX_REMOTE:-} ]]; then
  print "0/7  links shared from the phone"
  DATA_DIR=$outdir LINK_INBOX_REMOTE=$LINK_INBOX_REMOTE "$repo/tools/pull-phone-inbox.zsh" || true
fi

# --- pull straight from Saved Messages, when a session exists ---------------------

session=${XDG_CONFIG_HOME:-$HOME/.config}/link-keeper/telegram.session
if (( offline )); then
  :
elif [[ -n ${TELEGRAM_API_ID:-} && -f $session ]]; then
  print "0/7  new links from Saved Messages, no export needed"
  "$repo/importers/telegram-pull.py" --inbox "$inbox" \
    || print "  ! pull failed — continuing with what is already on disk"
elif [[ -n ${TELEGRAM_API_ID:-} ]]; then
  print "0/7  Saved Messages puller configured but not logged in"
  print "  run once: $repo/importers/telegram-pull.py --login"
fi

# --- rebuild --------------------------------------------------------------------

# One combined worklist: Telegram links (export and/or pulled inbox), plus whatever
# non-instagram links sit in the IG self-thread. The instagram.com links themselves never touch
# the enrichers — the IG export already carries their caption and author, and instagram.com
# stonewalls resolvers anyway.
worklist=""
[[ -n $export_json ]] && worklist=$("$repo/importers/telegram.py" "$export_json")
[[ -s $inbox ]] && worklist+=$'\n'$(grep -h . "$inbox")
# Each account also writes where its links came from; the enrichers read only URL and date, so the
# origin is put back on their records after the merge.
origins_files=()
for (( i = 1; i <= ${#ig_paths}; i++ )); do
  ig_account_args $i
  origins=$outdir/link-dm-origins-${ig_accts[$i]:-default}.jsonl
  worklist+=$'\n'$("$repo/importers/instagram.py" "${ig_paths[$i]}" --other "${reply[@]}" --origins-out "$origins")
  origins_files+=("$origins")
done
# The X archive's DM links go to the enrichers too (x.com ones to FxTwitter), their origin likewise.
if [[ -n $x_archive ]]; then
  origins=$outdir/link-dm-origins-x.jsonl
  worklist+=$'\n'$("$repo/importers/x-archive.py" "$x_archive" --other "${x_args[@]}" --origins-out "$origins")
  origins_files+=("$origins")
fi
if [[ -z ${worklist//$'\n'/} ]] && (( ! ${#ig_paths} )) && [[ -z $x_archive ]] && (( ! offline )); then
  print -u2 "nothing to work with: no Telegram export under $TELEGRAM_EXPORT_DIR, no $inbox, no Instagram export, no X archive"
  print -u2 "either export a chat, or set up the puller (importers/telegram-pull.py --login)"
  exit 1
fi

# Instagram post/reel urls skip the enrichers entirely — the reels step below owns them, and a
# generic fetch of instagram.com yields a login wall or a stub record at best.
enrich_input=$(print -r -- "$worklist" | grep -vE '^https?://(www\.)?instagram\.com/(reel|reels|p|tv)/' || true)

if (( offline )); then
  print "1/7  x.com via FxTwitter — skipped (--offline), keeping the last run's records"
  print "\n2/7  everything else via og: tags and free APIs — skipped (--offline), keeping the last run's records"
  [[ -e $x_jsonl ]] || : > "$x_jsonl"
  [[ -e $web_jsonl ]] || : > "$web_jsonl"
else
  print "1/7  x.com via FxTwitter"
  # The previous run's records are reused, so only new ids are fetched and a transient failure
  # cannot erase a capture that already exists. The output must not be the reuse file itself.
  x_prev=$outdir/link-captures-x.prev.jsonl
  [[ -s $x_jsonl ]] && cp "$x_jsonl" "$x_prev"
  print -r -- "$enrich_input" | "$repo/importers/enrich-x.py" --reuse "$x_prev" > "$x_jsonl"

  print "\n2/7  everything else via og: tags and free APIs"
  print -r -- "$enrich_input" \
    | "$repo/importers/enrich-web.py" --failed-to "$unresolved" > "$web_jsonl"
fi

print "\n3/7  instagram, from its own export"
: > "$ig_jsonl"
if (( ${#ig_paths} )); then
  for (( i = 1; i <= ${#ig_paths}; i++ )); do
    ig_account_args $i
    "$repo/importers/instagram.py" "${ig_paths[$i]}" --json "${reply[@]}" >> "$ig_jsonl"
  done
  # The same reel read from two accounts is one record that names both, with every sender.
  if (( ${#ig_paths} > 1 )); then
    "$repo/importers/attach-dm-origin.py" --merge-duplicates --captures "$ig_jsonl" > "$ig_jsonl.tmp"
    mv "$ig_jsonl.tmp" "$ig_jsonl"
  fi
  print "  $(grep -c . "$ig_jsonl") captures → ${ig_jsonl:t} (no fetching — the export carries the content)"
else
  print "  no instagram-* export under ${INSTAGRAM_EXPORT_DIR/#$HOME/~} — skipped"
fi

# The X archive holds no tweet or page content, only where and when a link was sent: bare records,
# which the enriched ones fill in on import, and which alone bring the links in under --offline.
if [[ -n $x_archive ]]; then
  "$repo/importers/x-archive.py" "$x_archive" --json "${x_args[@]}" > "$xdm_jsonl"
  print "  $(grep -c . "$xdm_jsonl") links from X direct messages → ${xdm_jsonl:t} (where they were sent; text comes from step 1)"
else
  : > "$xdm_jsonl"
fi

print "\n4/7  videos — packs for new reels, YouTube videos and X videos, records from all of them"
reels_dir=${REELS_DIR:-$outdir/reels}
reels_jsonl=$outdir/link-captures-reels.jsonl
# The worklist holds only Telegram and phone reels: instagram.py --other leaves instagram.com links
# out, so the export's own reels (the DMs) come from its capture records. Until 2026-10-20 they were
# never downloaded, and 291 DM reels had only their caption.
reel_urls=$( {
  print -r -- "$worklist" | cut -f1
  [[ -s $ig_jsonl ]] && python3 -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    r = json.loads(line) if line.strip() else {}
    if r.get("kind") in ("reel", "ig-post"): print(r["url"])
' "$ig_jsonl"
} | grep -E '^https?://(www\.)?instagram\.com/(reel|reels|p|tv)/' | sort -u || true)
# YouTube videos from the worklist, and X posts whose record (FxTwitter's) carries a video.
video_urls=$( {
  print -r -- "$reel_urls"
  print -r -- "$worklist" | cut -f1 | grep -E '^https?://(((www|m)\.)?youtube\.com/(watch\?|shorts/)|youtu\.be/)' || true
  [[ -s $x_jsonl ]] && python3 -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    r = json.loads(line) if line.strip() else {}
    if "video.twimg.com" in json.dumps(r.get("images") or []): print(r["url"])
' "$x_jsonl"
} | grep . | sort -u || true)
reels_unwatched=0
while IFS= read -r u; do
  code=$("$repo/tools/video-pack-id.zsh" "$u" 2>/dev/null) || code=""
  [[ -n $code && ! -s $reels_dir/$code/meta.json && ! -s $reels_dir/$code/yt-dlp.err ]] && reels_unwatched=$(( reels_unwatched + 1 ))
done <<< "$video_urls"
if (( reels_unwatched )) && (( offline || ! watch )); then
  print "  skipped (${${offline:#0}:+--offline}${${watch:#1}:+--no-watch}): $reels_unwatched videos have no pack yet; a run that watches downloads them"
elif (( reels_unwatched )); then
  # watch-reel's own errors (a missing tool, a failed contact sheet) pass through: filtering them out
  # once hid that the Import button's PATH had no mlx_whisper, so no reel was ever transcribed from it.
  reel_rc=0
  print -r -- "$video_urls" | REELS_DIR=$reels_dir xargs "$repo/tools/watch-reel.zsh" 2>&1 \
    | grep -E "^packs:|!|^missing:" || reel_rc=$?
  (( reel_rc )) && print "  ! video downloads did not finish ($reels_unwatched were waiting); see the lines above"
fi
# What each pack points to (Claude Haiku over caption, transcript and on-screen text): spends tokens, so
# full runs only; a pack whose input has not changed is not asked again.
if [[ -d $reels_dir ]] && (( ! offline && watch )); then
  "$repo/tools/extract-reel-resources.py" --reels-dir "$reels_dir" 2>&1 | grep -E "^resources:|!" || true
fi
if [[ -d $reels_dir ]]; then
  "$repo/tools/reels-to-captures.py" "$reels_dir" -o "$reels_jsonl"
else
  : > "$reels_jsonl"
  print "  no packs yet — reels arrive here once links are shared"
fi
# An instagram link whose pack failed (deleted reel, private post) must not vanish: it goes onto the
# unresolved queue so the browser handoff still carries it.
if [[ -n $reel_urls ]] && (( ! offline )); then
  while IFS= read -r u; do
    code=$(print -r -- "$u" | sed -nE 's#.*instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+).*#\2#p')
    [[ -n $code && ! -s $reels_dir/$code/meta.json ]] && print -r -- "$u" >> "$unresolved"
  done <<< "$reel_urls"
fi

print "\n5/7  merging"
# reels last, so a pack-backed record wins over a caption-only one for the same url on import; the
# bare X DM records first, so any record with text fills them in.
if [[ -s $extra_jsonl ]]; then
  cat "$xdm_jsonl" "$x_jsonl" "$web_jsonl" "$ig_jsonl" "$extra_jsonl" "$reels_jsonl" > "$all_jsonl"
  print "  including $(grep -c . "$extra_jsonl") hand-recovered from ${extra_jsonl:t}"
else
  cat "$xdm_jsonl" "$x_jsonl" "$web_jsonl" "$ig_jsonl" "$reels_jsonl" > "$all_jsonl"
fi
if (( ${#origins_files} )); then
  "$repo/importers/attach-dm-origin.py" "${origins_files[@]}" --captures "$all_jsonl" > "$all_jsonl.tmp"
  mv "$all_jsonl.tmp" "$all_jsonl"
fi
print "  $(grep -c . "$all_jsonl") captures → ${all_jsonl:t}"

# The two pages cover every source (Telegram, Instagram DMs, X DMs, the phone inbox) and are rebuilt only
# when their input changed: each keeps a fingerprint beside it, and says so when it skips. The triage page
# reads its decisions from $outdir/link-triage-decisions.json (or the telegram-links-triage.json it replaced).
page_inputs=(--instagram "$ig_jsonl" --x "$xdm_jsonl" --inbox "$inbox" -c "$all_jsonl" --only-if-changed)
[[ -n $export_json ]] && page_inputs=("$export_json" "${page_inputs[@]}")

print "\n6/7  safe-to-delete page"
DATA_DIR=$outdir "$repo/tools/build-safe-to-delete-page.py" "${page_inputs[@]}" -o "$safe_html" \
  || print "  ! the safe-to-delete page was not built; see above"

print "\n7/7  link-triage page"
DATA_DIR=$outdir "$repo/tools/build-link-triage-page.py" "${page_inputs[@]}" -o "$triage_html" \
  || print "  ! the link-triage page was not built; see above"

# --- hand it over ---------------------------------------------------------------

if [[ -s $unresolved ]]; then
  print "\n$(grep -c . "$unresolved") links resolved to nothing — they go onto the queue for the browser"
fi

if (( ! serve )); then
  exit 0
fi

# One handover carrying both halves: what could be read, and what could not. The unresolved ones are
# the only links that still need a browser, so they are queued rather than printed as a command.
handoff=$outdir/link-handoff.json
python3 - "$all_jsonl" "$unresolved" "$handoff" <<'PY'
import json, sys
captures_path, unresolved_path, out_path = sys.argv[1:4]
captures = []
with open(captures_path, encoding="utf-8") as fh:
    for line in fh.read().split("\n"):
        line = line.strip()
        if line:
            try:
                captures.append(json.loads(line))
            except json.JSONDecodeError:
                pass
queue = []
try:
    with open(unresolved_path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if parts and parts[0].startswith(("http://", "https://")):
                queue.append({"url": parts[0], "saved_at": parts[1] if len(parts) > 1 else None})
except FileNotFoundError:
    pass
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump({"captures": captures, "queue": queue}, fh, ensure_ascii=False)
print(f"  handover: {len(captures)} captures, {len(queue)} for the browser")
PY

# Hold the file on loopback and let the add-on's own page collect it. Firefox records the internal
# uuid of each install in its profile, so that page's URL can be looked up and opened — which removes
# the last manual step. If the lookup fails (a fresh install Firefox has not flushed yet), fall back
# to waiting for you to open it.
"$repo/tools/serve-once.py" "$handoff" --port "$SERVE_PORT" &
serve_pid=$!

list_url=$("$repo/tools/extension-url.py" list.html 2>/dev/null) || list_url=""

if [[ -n $list_url ]] && (( open_page )); then
  print "\nopening the list page to hand it over…"
  open -a Firefox "$list_url" 2>/dev/null || open "$list_url" 2>/dev/null || {
    print "  could not open Firefox; open the extension's list page yourself"
  }
else
  print "\nNow open the extension's list page — it imports this by itself."
fi

wait $serve_pid
