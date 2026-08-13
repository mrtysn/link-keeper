#!/bin/zsh
# DESC: Re-run the whole pipeline against a fresh Telegram export and rebuild every derived file.
#
# Everything downstream is idempotent — the enrichers refetch, the extension import dedupes on a
# normalised URL, and the message view is keyed by message id — so this is safe to run as often as
# you add links. Roughly four minutes for a few hundred links, nearly all of it waiting on fetches.
#
# Usage:
#   ./tools/refresh.zsh ~/Downloads/Telegram\ Desktop/ChatExport_2026-08-20/result.json [outdir]
#
# outdir defaults to the current directory. The saved-messages page is written to a fixed filename
# on purpose: its per-message marks live in browser storage keyed to that file, so a new name each
# time would strand the record of what you have already deleted.
#
# link-captures-extra.jsonl, if it exists in outdir, is merged in and never overwritten. That is where
# records recovered by hand belong — anything a bot check defeated and a crawler or a real browser had
# to fetch instead. Without it a rerun silently drops them.

set -euo pipefail

if [[ $# -lt 1 || $1 == -h || $1 == --help ]]; then
  sed -n '2,17p' "$0" | sed 's/^# \?//'
  exit 0
fi

export_json=${1:A}
outdir=${2:-$PWD}
here=${0:A:h}

[[ -f $export_json ]] || { print -u2 "no such export: $export_json"; exit 1 }
[[ -d $outdir ]] || { print -u2 "no such directory: $outdir"; exit 1 }

x_jsonl=$outdir/link-captures-x.jsonl
web_jsonl=$outdir/link-captures-web.jsonl
all_jsonl=$outdir/link-captures-all.jsonl
unresolved=$outdir/link-unresolved.tsv
captures_html=$outdir/$(date +%Y-%m-%d)-all-captures.html
messages_html=$outdir/saved-messages.html

print "export : $export_json"
print "output : $outdir\n"

print "1/5  x.com links via FxTwitter"
"$here/../importers/telegram.py" "$export_json" | "$here/../importers/enrich-x.py" > "$x_jsonl"

print "\n2/5  everything else via og: tags and free APIs"
"$here/../importers/telegram.py" "$export_json" \
  | "$here/../importers/enrich-web.py" --failed-to "$unresolved" > "$web_jsonl"

print "\n3/5  merging"
extra=$outdir/link-captures-extra.jsonl
if [[ -s $extra ]]; then
  cat "$x_jsonl" "$web_jsonl" "$extra" > "$all_jsonl"
  print "  including $(grep -c . "$extra") hand-recovered from ${extra:t}"
else
  cat "$x_jsonl" "$web_jsonl" > "$all_jsonl"
fi
print "  $(grep -c . "$all_jsonl") captures → ${all_jsonl:t}"

print "\n4/5  capture view"
"$here/captures-to-html.py" "$all_jsonl" -o "$captures_html"

print "\n5/5  message view (marks preserved — same filename)"
"$here/telegram-messages-to-html.py" "$export_json" -c "$all_jsonl" -o "$messages_html"

print "\nnext, by hand:"
print "  · new links onto the worklist:  ./importers/telegram.py '$export_json' --urls | pbcopy"
print "    then the popup → Add links → paste → Add"
print "  · captures into the extension:  list page → Import… → ${all_jsonl:t}"
if [[ -s $unresolved ]]; then
  print "  · $(grep -c . "$unresolved") links resolved to nothing — see ${unresolved:t}"
fi
