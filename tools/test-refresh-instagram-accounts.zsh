#!/bin/zsh
# DESC: Run refresh.zsh on made-up Instagram exports for two accounts, and a made-up X archive, and check what it reads.
#
# Copies this repo's tools/ and importers/ into a temporary repo, with its own config.local.sh, so the
# real config (phone inbox, Telegram session) is never read and nothing leaves the machine. Every config
# names an X archive folder of its own, so the default (~/Downloads) and a real archive there are never read. The fake
# exports hold no links to other sites, so no fetching happens.
#
#   tools/test-refresh-instagram-accounts.zsh

set -euo pipefail

here=${0:A:h}
repo=${here:h}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fake=$work/repo
mkdir -p "$fake" "$work/accounts/main" "$work/accounts/side" "$work/data"
cp -R "$repo/tools" "$repo/importers" "$fake/"
find "$fake" -name __pycache__ -prune -exec rm -rf {} +

"$repo/tools/test-instagram-export.py" --write-fixture "$work/accounts/main/instagram-main"
"$repo/tools/test-instagram-export.py" --write-fixture "$work/accounts/side/instagram-side"

cat > "$fake/config.local.sh" <<EOF
DATA_DIR="$work/data"
TELEGRAM_EXPORT_DIR="$work/no-telegram"
X_ARCHIVE_DIR="$work/no-x"
INSTAGRAM_ACCOUNTS_DIR="$work/accounts"
IG_ACCOUNTS[main]="alice_2 bob_3"
IG_ACCOUNTS[side]=""
EOF

out=$("$fake/tools/refresh.zsh" --no-serve --no-open 2>&1) || { print -r -- "$out"; print "FAIL refresh.zsh exited non-zero"; exit 1 }
all=$work/data/link-captures-all.jsonl

failed=0
check() {   # name, then a command that must succeed
  local name=$1; shift
  if "$@"; then print "ok   $name"; else print "FAIL $name"; failed=1; fi
}
count() { jq -s "[.[] | select($1)] | length" "$all"; }

check "both accounts were found" grep -q "account main" <<< "$out"
check "second account was found" grep -q "account side" <<< "$out"
check "main reads its named threads (bob post present)" test "$(count '.account == "main" and (.url | test("CCC333"))')" = 1
check "side reads no named threads (bob post absent)" test "$(count '.account == "side" and (.url | test("CCC333"))')" = 0
check "an unnamed thread is never read" test "$(count '.url | test("DDD444")')" = 0
check "a reel both accounts hold is one record" test "$(count '.url | test("AAA111")')" = 1
check "...naming both accounts" test "$(count '(.url | test("AAA111")) and .account == ["main","side"]')" = 1
check "...with the senders of both" test "$(count '(.url | test("BBB222")) and .senders == ["Me","Alice"]')" = 1
check "origin survives the merge (account and thread on every record)" test "$(count '.account != null and (.thread | length) > 0')" = "$(count 'true')"
check "origins files written per account" test -s "$work/data/link-dm-origins-main.jsonl" -a -s "$work/data/link-dm-origins-side.jsonl"

# An account in IG_ACCOUNTS with no export of its own is reported, not silently skipped.
mkdir "$work/accounts/ghost"
print 'IG_ACCOUNTS[ghost]=""' >> "$fake/config.local.sh"
out2=$("$fake/tools/refresh.zsh" --no-serve --no-open 2>&1) || true
check "an account with no export is named" grep -q "no instagram-\* export for account ghost" <<< "$out2"

# IG_ACCOUNTS without its folder is an error that says what to set.
print 'INSTAGRAM_ACCOUNTS_DIR=""' >> "$fake/config.local.sh"
out3=$("$fake/tools/refresh.zsh" --no-serve --no-open 2>&1) && rc=0 || rc=$?
check "IG_ACCOUNTS without INSTAGRAM_ACCOUNTS_DIR exits non-zero" test "$rc" != 0
check "...and says what to set" grep -q "INSTAGRAM_ACCOUNTS_DIR is not" <<< "$out3"

# No IG_ACCOUNTS at all: the old single-export setup reads the newest export, with no account.
cat > "$fake/config.local.sh" <<EOF
DATA_DIR="$work/data"
TELEGRAM_EXPORT_DIR="$work/no-telegram"
X_ARCHIVE_DIR="$work/no-x"
INSTAGRAM_EXPORT_DIR="$work/accounts/main"
EOF
"$fake/tools/refresh.zsh" --no-serve --no-open > /dev/null 2>&1
check "single-export setup still reads the self-thread" test "$(count '.url | test("AAA111")')" = 1
check "...and stamps no account" test "$(count '.account != null')" = 0
check "...but still names the thread" test "$(count '.thread != null')" = "$(count 'true')"

# One account, threads named with IG_THREADS.
print 'IG_THREADS="bob_3"' >> "$fake/config.local.sh"
"$fake/tools/refresh.zsh" --no-serve --no-open > /dev/null 2>&1
check "IG_THREADS reads the named thread" test "$(count '(.url | test("CCC333")) and .thread == ["bob_3"]')" = 1
check "...still without an account" test "$(count '.account != null')" = 0
check "...and an unnamed thread stays out" test "$(count '.url | test("DDD444")')" = 0

# --offline: nothing reaches out, and the last run's lookups survive. Every tool that would reach out
# is replaced by one that only leaves a marker file; a control run without --offline shows the markers
# would have appeared, so an empty marker folder means something.
marks=$work/marks bin=$work/bin
mkdir -p "$marks" "$bin" "$work/xdg/link-keeper" "$fake/tools/tag-model/.venv"
: > "$work/xdg/link-keeper/telegram.session"
for f in importers/enrich-x.py importers/enrich-web.py importers/telegram-pull.py tools/watch-reel.zsh tools/tag-model/run.zsh; do
  print -r -- "#!/bin/zsh" > "$fake/$f"
  print -r -- "touch ${(q)marks}/${f:t}" >> "$fake/$f"
  chmod +x "$fake/$f"
done
print -r -- "#!/bin/zsh" > "$bin/ssh"
print -r -- "touch ${(q)marks}/ssh; exit 1" >> "$bin/ssh"
chmod +x "$bin/ssh"
cat > "$fake/config.local.sh" <<EOF
DATA_DIR="$work/data"
TELEGRAM_EXPORT_DIR="$work/no-telegram"
X_ARCHIVE_DIR="$work/no-x"
INSTAGRAM_EXPORT_DIR="$work/accounts/main"
IG_THREADS="bob_3"
X_THREADS="100-200"
X_ACCOUNT=main
LINK_INBOX_REMOTE=ghost:/nowhere
TELEGRAM_API_ID=1
SERVE_PORT=18791
EOF
mkdir -p "$work/x"
"$repo/tools/test-x-archive.py" --write-fixture "$work/x/twitter-2026-10-15-fake.zip"
print -r -- "X_ARCHIVE_DIR=${(q)work}/x" >> "$fake/config.local.sh"
print -r -- '{"kind":"tweet","url":"https://x.com/someone/status/1","text":"kept from the last run"}' > "$work/data/link-captures-x.jsonl"
print -r -- '{"kind":"page","url":"https://kept.example/","title":"kept from the last run"}' > "$work/data/link-captures-web.jsonl"

PATH=$bin:$PATH XDG_CONFIG_HOME=$work/xdg "$fake/tools/refresh.zsh" --offline --no-serve --no-open > "$work/offline.out" 2>&1 \
  || { cat "$work/offline.out"; print "FAIL refresh.zsh --offline exited non-zero"; exit 1 }
check "--offline reaches out to nothing (no marker files)" test -z "$(ls "$marks")"
check "--offline keeps the last run's x.com record" test "$(count '.url == "https://x.com/someone/status/1"')" = 1
check "--offline keeps the last run's web record" test "$(count '.url == "https://kept.example/"')" = 1
check "--offline still parses the Instagram dump" test "$(count '(.url | test("CCC333")) and .thread == ["bob_3"]')" = 1
check "--offline says it skipped the lookups" grep -q "skipped (--offline)" "$work/offline.out"
check "--offline brings in the X archive's DM links, the one with yourself and the named thread" \
  test "$(count '.via == "x-archive"')" = 3
check "...with where they came from" \
  test "$(count '.url == "https://x.com/other/status/22" and .account == "main" and .thread == ["yourself","@alice"]')" = 1
check "...and leaves an unnamed thread out" test "$(count '.url | test("spam.example")')" = 0

# The tag suggestions and the handover come after the serve step, so these runs offer the file on
# loopback and the test collects it, as the extension's list page would.
run_served() {   # flags for refresh.zsh; runs it, collects the handover, waits for it to finish
  PATH=$bin:$PATH XDG_CONFIG_HOME=$work/xdg "$fake/tools/refresh.zsh" --no-open "$@" > "$work/served.out" 2>&1 &
  local pid=$! i
  for i in {1..60}; do
    curl -fsS -o /dev/null "http://127.0.0.1:18791/link-handoff.json" 2>/dev/null && break
    sleep 0.5
  done
  wait $pid || true
  sleep 1   # the tag run is detached
}
run_served --offline
check "--offline hands the file over" grep -q "handover:" "$work/served.out"
check "--offline skips the tag suggestions, and says so" grep -q "tag suggestions: skipped (--offline)" "$work/served.out"
check "--offline still reaches out to nothing when it serves" test -z "$(ls "$marks")"

run_served
for m in ssh telegram-pull.py enrich-x.py enrich-web.py run.zsh; do
  check "control: without --offline, $m runs" test -e "$marks/$m"
done

(( failed )) && { print "\nsome checks failed"; exit 1 }
print "all passed"
