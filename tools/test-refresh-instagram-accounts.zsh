#!/bin/zsh
# DESC: Run refresh.zsh on made-up Instagram exports for two accounts and check what it reads, per account.
#
# Copies this repo's tools/ and importers/ into a temporary repo, with its own config.local.sh, so the
# real config (phone inbox, Telegram session) is never read and nothing leaves the machine. The fake
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
INSTAGRAM_EXPORT_DIR="$work/accounts/main"
EOF
"$fake/tools/refresh.zsh" --no-serve --no-open > /dev/null 2>&1
check "single-export setup still reads the self-thread" test "$(count '.url | test("AAA111")')" = 1
check "...and stamps no account" test "$(count '.account != null')" = 0
check "...but still names the thread" test "$(count '.thread != null')" = "$(count 'true')"

(( failed )) && { print "\nsome checks failed"; exit 1 }
print "all passed"
