#!/bin/zsh
# DESC: One command: find the newest Telegram export, rebuild everything, hand it to the extension.
#
# After exporting a chat from Telegram, run this. Nothing else. It picks the newest export, resolves
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
  sed -n '2,22p' "$0" | sed 's/^# \?//'
  exit 0
fi

serve=1
open_page=1
argv=()
for a in "$@"; do
  [[ $a == --no-serve ]] && { serve=0; continue }
  [[ $a == --no-open ]] && { open_page=0; continue }
  argv+=$a
done

# --- configuration -------------------------------------------------------------

TELEGRAM_EXPORT_DIR=${TELEGRAM_EXPORT_DIR:-$HOME/Downloads/Telegram Desktop}
DATA_DIR=${DATA_DIR:-$PWD}
SERVE_PORT=${SERVE_PORT:-8790}
[[ -r $repo/config.local.sh ]] && source "$repo/config.local.sh"

# --- what to read, what to write ------------------------------------------------

if [[ -n ${argv[1]:-} ]]; then
  export_json=${argv[1]:A}
else
  # Newest export wins, by mtime rather than name: two exports on one day would tie lexically.
  newest=(${~TELEGRAM_EXPORT_DIR}/ChatExport_*/result.json(.Nom))
  (( $#newest )) || {
    print -u2 "no export found under: $TELEGRAM_EXPORT_DIR"
    print -u2 "pass one explicitly, or set TELEGRAM_EXPORT_DIR in $repo/config.local.sh"
    exit 1
  }
  export_json=${newest[1]}
fi

outdir=${argv[2]:-$DATA_DIR}
[[ -f $export_json ]] || { print -u2 "no such export: $export_json"; exit 1 }
[[ -d $outdir ]] || { print -u2 "no such directory: $outdir"; exit 1 }

x_jsonl=$outdir/link-captures-x.jsonl
web_jsonl=$outdir/link-captures-web.jsonl
all_jsonl=$outdir/link-captures-all.jsonl
extra_jsonl=$outdir/link-captures-extra.jsonl
unresolved=$outdir/link-unresolved.tsv
captures_html=$outdir/$(date +%Y-%m-%d)-all-captures.html
messages_html=$outdir/saved-messages.html

print "export : ${export_json/#$HOME/~}"
print "output : ${outdir/#$HOME/~}\n"

# --- rebuild --------------------------------------------------------------------

print "1/5  x.com via FxTwitter"
"$repo/importers/telegram.py" "$export_json" | "$repo/importers/enrich-x.py" > "$x_jsonl"

print "\n2/5  everything else via og: tags and free APIs"
"$repo/importers/telegram.py" "$export_json" \
  | "$repo/importers/enrich-web.py" --failed-to "$unresolved" > "$web_jsonl"

print "\n3/5  merging"
if [[ -s $extra_jsonl ]]; then
  cat "$x_jsonl" "$web_jsonl" "$extra_jsonl" > "$all_jsonl"
  print "  including $(grep -c . "$extra_jsonl") hand-recovered from ${extra_jsonl:t}"
else
  cat "$x_jsonl" "$web_jsonl" > "$all_jsonl"
fi
print "  $(grep -c . "$all_jsonl") captures → ${all_jsonl:t}"

print "\n4/5  capture view"
"$repo/tools/captures-to-html.py" "$all_jsonl" -o "$captures_html"

print "\n5/5  message view"
"$repo/tools/telegram-messages-to-html.py" "$export_json" -c "$all_jsonl" -o "$messages_html"

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
