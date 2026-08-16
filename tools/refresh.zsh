#!/bin/zsh
# DESC: One command: find the newest exports, rebuild everything, hand it to the extension.
#
# After exporting from Telegram (and, optionally, Instagram), run this. Nothing else. It picks the
# newest Telegram export and the newest Instagram export that actually contains messages, resolves
# every link it can without a browser, rebuilds the two HTML views, and then puts the result behind a
# loopback URL — the extension's list page pulls it in by itself, so there is no file to choose and
# nothing to paste.
#
# Usage:
#   refresh.zsh                     # newest export, paths from config.local.sh
#   refresh.zsh <path/to/result.json>
#   refresh.zsh <result.json> <outdir>
#   refresh.zsh --no-serve          # rebuild only, do not offer it to the extension
#   refresh.zsh --no-open           # offer it, but do not open the browser yourself
#
# Paths come from config.local.sh at this repo's root — copy config.local.sh.example and fill it in.
# Nothing machine-specific is committed.
#
# link-captures-extra.jsonl in the output directory is merged and never overwritten: that is where
# records recovered by hand belong, and without it a rerun would silently drop them.
#
# The message view is written to a fixed filename because its per-message marks live in browser
# storage keyed to that file — a new name each time would strand your record of what you deleted.

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
args=()
for a in "$@"; do
  [[ $a == --no-serve ]] && { serve=0; continue }
  [[ $a == --no-open ]] && { open_page=0; continue }
  args+=$a
done

# --- configuration -------------------------------------------------------------
# Precedence: environment > config.local.sh > built-in default. The env value is captured
# before sourcing the config, which would otherwise clobber it.

env_tg=${TELEGRAM_EXPORT_DIR:-} env_ig=${INSTAGRAM_EXPORT_DIR:-} env_data=${DATA_DIR:-} env_port=${SERVE_PORT:-}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"
TELEGRAM_EXPORT_DIR=${env_tg:-${TELEGRAM_EXPORT_DIR:-$HOME/Downloads/Telegram Desktop}}
INSTAGRAM_EXPORT_DIR=${env_ig:-${INSTAGRAM_EXPORT_DIR:-$HOME/Downloads}}
DATA_DIR=${env_data:-${DATA_DIR:-$PWD}}
SERVE_PORT=${env_port:-${SERVE_PORT:-8790}}

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
[[ -d $outdir ]] || { print -u2 "no such directory: $outdir"; exit 1 }
inbox=$outdir/link-inbox.tsv

# Instagram is optional: the newest instagram-* zip or unzipped directory that actually holds
# messages or saved posts. Instagram exports are per-request subsets, so a newer zip requested
# for something else (say, connections only) must not shadow the one with the links in it.
ig_export=""
for c in ${~INSTAGRAM_EXPORT_DIR}/instagram-*(Nom); do
  [[ -d $c || $c == *.zip ]] || continue
  "$repo/importers/instagram.py" "$c" --check 2>/dev/null && { ig_export=$c; break }
done

x_jsonl=$outdir/link-captures-x.jsonl
web_jsonl=$outdir/link-captures-web.jsonl
ig_jsonl=$outdir/link-captures-ig.jsonl
all_jsonl=$outdir/link-captures-all.jsonl
extra_jsonl=$outdir/link-captures-extra.jsonl
unresolved=$outdir/link-unresolved.tsv
captures_html=$outdir/$(date +%Y-%m-%d)-all-captures.html
messages_html=$outdir/saved-messages.html

[[ -n $export_json ]] && print "export : ${export_json/#$HOME/~}"
[[ -n $ig_export ]] && print "instagram : ${ig_export/#$HOME/~}"
print "output : ${outdir/#$HOME/~}\n"

# --- mirror the phone-share inbox from its server, when configured ----------------

if [[ -n ${LINK_INBOX_REMOTE:-} ]]; then
  print "0/7  links shared from the phone"
  r_host=${LINK_INBOX_REMOTE%%:*} r_path=${LINK_INBOX_REMOTE#*:}
  if ssh -o ConnectTimeout=6 -o BatchMode=yes "$r_host" cat "$r_path" > "$inbox.tmp" 2>/dev/null; then
    mv "$inbox.tmp" "$inbox"
    print "  $(grep -c . "$inbox") in the inbox (mirror of $r_host)"
  else
    rm -f "$inbox.tmp"
    print "  ! could not reach $r_host — using the last mirror"
  fi
fi

# --- pull straight from Saved Messages, when a session exists ---------------------

session=${XDG_CONFIG_HOME:-$HOME/.config}/link-keeper/telegram.session
if [[ -n ${TELEGRAM_API_ID:-} && -f $session ]]; then
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
if [[ -n $ig_export ]]; then
  worklist+=$'\n'$("$repo/importers/instagram.py" "$ig_export" --other)
fi
if [[ -z ${worklist//$'\n'/} ]]; then
  print -u2 "nothing to work with: no Telegram export under $TELEGRAM_EXPORT_DIR, no $inbox"
  print -u2 "either export a chat, or set up the puller (importers/telegram-pull.py --login)"
  exit 1
fi

# Instagram post/reel urls skip the enrichers entirely — the reels step below owns them, and a
# generic fetch of instagram.com yields a login wall or a stub record at best.
enrich_input=$(print -r -- "$worklist" | grep -vE '^https?://(www\.)?instagram\.com/(reel|reels|p|tv)/' || true)

print "1/7  x.com via FxTwitter"
print -r -- "$enrich_input" | "$repo/importers/enrich-x.py" > "$x_jsonl"

print "\n2/7  everything else via og: tags and free APIs"
print -r -- "$enrich_input" \
  | "$repo/importers/enrich-web.py" --failed-to "$unresolved" > "$web_jsonl"

print "\n3/7  instagram, from its own export"
if [[ -n $ig_export ]]; then
  "$repo/importers/instagram.py" "$ig_export" --json > "$ig_jsonl"
  print "  $(grep -c . "$ig_jsonl") captures → ${ig_jsonl:t} (no fetching — the export carries the content)"
else
  : > "$ig_jsonl"
  print "  no instagram-* export under ${INSTAGRAM_EXPORT_DIR/#$HOME/~} — skipped"
fi

print "\n4/7  reels — packs for new instagram links, records from all of them"
reels_dir=${REELS_DIR:-$outdir/reels}
reels_jsonl=$outdir/link-captures-reels.jsonl
reel_urls=$(print -r -- "$worklist" | cut -f1 | grep -E '^https?://(www\.)?instagram\.com/(reel|reels|p|tv)/' | sort -u || true)
if [[ -n $reel_urls ]]; then
  print -r -- "$reel_urls" | REELS_DIR=$reels_dir xargs "$repo/tools/watch-reel.zsh" 2>&1 | grep -E "^packs:|! download failed" || true
fi
if [[ -d $reels_dir ]]; then
  "$repo/tools/reels-to-captures.py" "$reels_dir" -o "$reels_jsonl"
else
  : > "$reels_jsonl"
  print "  no packs yet — reels arrive here once links are shared"
fi
# An instagram link whose pack failed (image post, dead reel) must not vanish: it goes onto the
# unresolved queue so the browser handoff still carries it.
if [[ -n $reel_urls ]]; then
  while IFS= read -r u; do
    code=$(print -r -- "$u" | sed -nE 's#.*instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+).*#\2#p')
    [[ -n $code && ! -s $reels_dir/$code/transcript.txt ]] && print -r -- "$u" >> "$unresolved"
  done <<< "$reel_urls"
fi

print "\n5/7  merging"
# reels last, so a pack-backed record wins over a caption-only one for the same url on import.
if [[ -s $extra_jsonl ]]; then
  cat "$x_jsonl" "$web_jsonl" "$ig_jsonl" "$extra_jsonl" "$reels_jsonl" > "$all_jsonl"
  print "  including $(grep -c . "$extra_jsonl") hand-recovered from ${extra_jsonl:t}"
else
  cat "$x_jsonl" "$web_jsonl" "$ig_jsonl" "$reels_jsonl" > "$all_jsonl"
fi
print "  $(grep -c . "$all_jsonl") captures → ${all_jsonl:t}"

print "\n6/7  capture view"
"$repo/tools/captures-to-html.py" "$all_jsonl" -o "$captures_html"

print "\n7/7  message view"
if [[ -n $export_json ]]; then
  "$repo/tools/telegram-messages-to-html.py" "$export_json" -c "$all_jsonl" -o "$messages_html"
else
  print "  no Telegram export on disk — the message replica keeps its last build"
fi

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
