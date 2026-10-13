#!/bin/zsh
# DESC: Write the Link Refresh app's launcher script to mac/.build/launcher/refresh
#
# The launcher is the bundle's executable. It runs tools/refresh.zsh with the PATH an app launched
# from Spotlight lacks (asdf's shims and Homebrew) and reports the result as a notification. The
# checkout's path is derived from this script's location and written into the launcher, so nothing
# machine-specific is committed. `project-lifecycle -C mac install` runs this, wraps the result in
# the bundle, signs it and installs it as ~/Applications/Link Refresh.app.

set -euo pipefail

repo=${0:A:h:h}
out="${0:A:h}/.build/launcher/refresh"

mkdir -p "${out:h}"

cat > "$out" <<RUNNER
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

chmod +x "$out"
