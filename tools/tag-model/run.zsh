#!/bin/zsh
# DESC: Train the tag heads on the owner's tags, then suggest tags for untagged links and send them to Link Keeper.
#
# Usage:
#   run.zsh --setup            create the Python environment (uv sync); needed once
#   run.zsh                    train.py, then suggest.py --write
#   run.zsh --no-write         the same, but only write <data dir>/tag-model/suggestions.json
#   run.zsh --system-one-only  skip training; the decision servers guess every tag
#   run.zsh --no-gutsy         skip the gutsy-inference pass
#
# Needs Firefox running with Link Keeper (suggest-set changes the add-on's data). system-one and
# gutsy-inference (GUTSY_DIR in config.local.sh) are started for the run only if they are not already
# running, and stopped after. A lock file in <data dir>/tag-model/ keeps two runs from overlapping.

set -euo pipefail

here=${0:A:h}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,14p' "$0" | sed -E 's/^# ?//'
  exit 0
fi

if [[ ${1:-} == --setup ]]; then
  uv sync --project "$here"
  exit 0
fi

if [[ ! -d $here/.venv ]]; then
  print -u2 "tag model: no environment yet. Run: $here/run.zsh --setup"
  exit 1
fi

write=(--write) train=1 gutsy=()
for a in "$@"; do
  case $a in
    --no-write) write=() ;;
    --system-one-only) train=0 ;;
    --no-gutsy) gutsy=(--no-gutsy) ;;
    *) print -u2 "unknown option: $a"; exit 2 ;;
  esac
done

cd "$here"
# The data folder is the one the refresh uses; tagdata.py resolves it from DATA_DIR / config.local.sh.
folder=$(uv run python -c 'import tagdata; print(tagdata.model_dir())')
lock=$folder/run.lock
if [[ -f $lock ]] && kill -0 "$(<"$lock")" 2>/dev/null; then
  print "tag model: another run is in progress (pid $(<"$lock")); skipping"
  exit 0
fi
print $$ > "$lock"
trap 'rm -f "$lock"' EXIT

if (( train )); then
  uv run python train.py
fi
args=($write $gutsy)
(( train )) || args+=(--system-one-only)
uv run python suggest.py $args
