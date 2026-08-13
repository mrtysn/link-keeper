#!/bin/zsh
# DESC: Build a Spotlight-launchable macOS app that runs the refresh with one keystroke.
#
# A .app is just a directory with a plist and an executable, so this writes one rather than dragging
# Automator into it. Installed under ~/Applications, which Spotlight indexes, so the whole routine
# becomes: ⌘-space, "link refresh", return.
#
# Usage:
#   ./tools/make-app.zsh              # → ~/Applications/Link Refresh.app
#   ./tools/make-app.zsh /some/dir    # → /some/dir/Link Refresh.app
#
# Re-run it after changing anything: the bundle only wraps the script, so a rebuild is cheap and the
# app itself never needs editing.

set -euo pipefail

here=${0:A:h}
repo=${here:h}
dest=${1:-$HOME/Applications}
app="$dest/Link Refresh.app"

[[ -d $dest ]] || mkdir -p "$dest"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>refresh</string>
    <key>CFBundleIdentifier</key>
    <string>local.link-refresh</string>
    <key>CFBundleName</key>
    <string>Link Refresh</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$app/Contents/MacOS/refresh" <<RUNNER
#!/bin/zsh
# Launched from Spotlight, so the environment is bare: asdf's shims and Homebrew have to be put back
# or python3 and terminal-notifier are simply absent.
export PATH="\$HOME/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REFRESH="$repo/tools/refresh.zsh"
LOG_FILE="\$HOME/Library/Logs/link-refresh.log"

log() { print -r -- "[\$(date '+%Y-%m-%d %H:%M:%S')] \$1" >> "\$LOG_FILE" }

notify() {
    log "NOTIFY: \$1"
    [[ -n "\${LINK_REFRESH_QUIET:-}" ]] && return
    if command -v terminal-notifier >/dev/null 2>&1; then
        terminal-notifier -title "Link Refresh" -message "\$1" >/dev/null 2>&1 &
    else
        osascript -e "display notification \\"\$1\\" with title \\"Link Refresh\\"" >/dev/null 2>&1 &
    fi
}

log "--- triggered ---"

if [[ ! -x \$REFRESH ]]; then
    notify "refresh.zsh is missing at \$REFRESH"
    exit 1
fi

notify "Rebuilding from the newest Telegram export…"

out=\$("\$REFRESH" 2>&1) || {
    print -r -- "\$out" >> "\$LOG_FILE"
    # Last line is usually the real reason; the rest is in the log.
    notify "Failed: \${\$(print -r -- "\$out" | tail -1)[1,90]}"
    exit 1
}
print -r -- "\$out" >> "\$LOG_FILE"

captures=\$(print -r -- "\$out" | grep -oE '[0-9]+ captures →' | head -1 | grep -oE '^[0-9]+')
queued=\$(print -r -- "\$out" | grep -oE '[0-9]+ for the browser' | head -1 | grep -oE '^[0-9]+')
served=\$(print -r -- "\$out" | grep -c 'served ')

if (( served )); then
    notify "Done — \${captures:-?} captures in, \${queued:-0} still need a browser"
else
    notify "Built \${captures:-?} captures, but the browser never collected them. Open the list page."
fi
log "--- finished ---"
RUNNER

chmod +x "$app/Contents/MacOS/refresh"
touch "$app"                       # nudge Spotlight into reindexing

print "built: ${app/#$HOME/~}"
print "Spotlight: ⌘-space → \"link refresh\""
print "log:       ~/Library/Logs/link-refresh.log"
