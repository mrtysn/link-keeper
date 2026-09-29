#!/bin/zsh
# DESC: Run a WebExtension script in a throwaway headless Firefox and print what it reports.
#
# The script runs as a background script with report() and check() in scope. With --extension it
# runs beside a copy of that extension's own background scripts — sharing their globals — so real
# tabs, bookmarks and storage exercise the real code. Firefox gets a fresh temporary profile via
# web-ext, never yours, and quits when the script finishes. Output comes back as a downloaded file.
#
# Usage:
#   run-in-headless-firefox.zsh probe.js                         # bare extension
#   run-in-headless-firefox.zsh --permissions bookmarks,tabs probe.js
#   run-in-headless-firefox.zsh --extension extension/ e2e.js    # beside the real extension
#   run-in-headless-firefox.zsh --timeout 180 ...                # seconds, default 120
#
# In the script: report(...parts) prints a line; await check(name, async () => {...}) prints
# "ok name" or "FAIL name: why". Exits 1 if any check failed or the script threw.

set -euo pipefail
setopt nullglob

if [[ ${1:-} == -h || ${1:-} == --help || $# -eq 0 ]]; then
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

ext="" perms="" timeout=120
while [[ $# -gt 1 ]]; do
  case $1 in
    --extension) ext=${2:A}; shift 2 ;;
    --permissions) perms=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    *) print -u2 "unknown argument: $1 (see --help)"; exit 2 ;;
  esac
done
script=${1:A}
[[ -f $script ]] || { print -u2 "no such script: $1"; exit 2 }

work=$(mktemp -d "${TMPDIR:-/tmp}/headless-firefox.XXXXXX")
src=$work/ext out=$work/out
mkdir -p "$out"
web_ext_pid=""
cleanup() {
  [[ -n $web_ext_pid ]] && kill -INT "$web_ext_pid" 2>/dev/null && sleep 2
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

if [[ -n $ext ]]; then
  rsync -a --exclude web-ext-artifacts "$ext/" "$src/"
else
  mkdir -p "$src"
  print '{"manifest_version":3,"name":"headless-probe","version":"1.0","background":{"scripts":[]},
    "browser_specific_settings":{"gecko":{"id":"headless-probe@example.org"}}}' > "$src/manifest.json"
fi

# The probe needs downloads to hand its report back; it goes last so the extension's own scripts
# have defined everything first.
/usr/bin/python3 - "$src/manifest.json" "$perms" <<'EOF'
import json, sys
path, perms = sys.argv[1], sys.argv[2]
m = json.load(open(path))
want = set(m.get("permissions", [])) | {"downloads"} | {p for p in perms.split(",") if p}
m["permissions"] = sorted(want)
m["background"]["scripts"] = m["background"].get("scripts", []) + ["__probe.js"]
json.dump(m, open(path, "w"), indent=2)
EOF

{
  cat <<'EOF'
const __lines = [];
let __failed = 0;
function report(...parts) { __lines.push(parts.join(" ")); }
async function check(name, fn) {
  try { await fn(); report("ok  ", name); }
  catch (e) { __failed++; report("FAIL", `${name}: ${e.message}`); }
}
// A fresh profile builds its bookmark tree after start-up; until then a folder can vanish mid-write.
async function __ready() {
  await new Promise(r => setTimeout(r, 6000));
}
async function __finish() {
  const body = __lines.join("\n") + `\n__DONE__ ${__failed}\n`;
  await browser.downloads.download({ url: URL.createObjectURL(new Blob([body])), filename: "report.txt" });
}
(async () => {
  await __ready();
EOF
  cat "$script"
  cat <<'EOF'

})().catch(e => { __failed++; report("ERROR", e.message, e.stack); }).finally(__finish);
EOF
} > "$src/__probe.js"

npx --yes web-ext run --source-dir "$src" --no-reload --no-input \
  --pref "browser.download.dir=$out" --pref browser.download.folderList=2 \
  --pref browser.download.useDownloadDir=true --arg=--headless > "$work/web-ext.log" 2>&1 &
web_ext_pid=$!

deadline=$(( SECONDS + timeout ))
until [[ -f $out/report.txt ]] && grep -q '^__DONE__' "$out/report.txt"; do
  if (( SECONDS > deadline )); then
    print -u2 "no report within ${timeout}s; web-ext said:"
    tail -20 "$work/web-ext.log" >&2
    exit 1
  fi
  if ! kill -0 "$web_ext_pid" 2>/dev/null; then
    print -u2 "web-ext exited early:"
    tail -20 "$work/web-ext.log" >&2
    exit 1
  fi
  sleep 1
done

grep -v '^__DONE__' "$out/report.txt"
failed=$(sed -n 's/^__DONE__ //p' "$out/report.txt")
(( failed == 0 ))
