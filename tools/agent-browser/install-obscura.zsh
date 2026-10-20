#!/bin/zsh
# DESC: Install Obscura, the agent browser that reads public links without the owner's logins, pinned to one release and its checksum.
#
# Obscura (github.com/h4ckf0r0day/obscura, Apache-2.0) is a headless browser with its own engine. The
# helper (native/link-keeper-bridge.py, read-page) runs it to read a public link with the extension's own
# page readers (extension/extractors.js), so captures stop going through the owner's logged-in Firefox.
# Chosen on 2026-10-20 over headless Chromium by tools/browser-bench (both read 18 of 33 known failures).
#
# The release publishes no checksums, so the one below is what was downloaded and benchmarked; a
# download that differs is refused. The plain build: no --stealth, no tracker blocking.
#
# Usage: install-obscura.zsh          installs into tools/agent-browser/.deps/obscura (gitignored); idempotent

set -euo pipefail

here=${0:A:h}
version=v0.2.5
asset=obscura-aarch64-macos.tar.gz
sha256=fcca31eba4280cd67a2e226ef4b015e432d5c089f78cefd074ad12bbc8e23345
dest=$here/.deps/obscura

[[ ${1:-} == -h || ${1:-} == --help ]] && { sed -n '2,13p' "$0" | sed -E 's/^# ?//'; exit 0 }
[[ $(uname -m) == arm64 ]] || { print -u2 "only the Apple silicon build is pinned ($asset)"; exit 1 }

if [[ -x $dest/obscura && $("$dest/obscura" --version 2>/dev/null) == *${version#v}* ]]; then
  print "obscura $version already installed: $dest/obscura"
  exit 0
fi

mkdir -p "$dest"
tmp=$dest/$asset.part
curl -fsSL -o "$tmp" "https://github.com/h4ckf0r0day/obscura/releases/download/$version/$asset"
got=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
if [[ $got != $sha256 ]]; then
  rm -f "$tmp"
  print -u2 "refused: $asset has checksum $got, not the pinned $sha256"
  exit 1
fi
tar -xzf "$tmp" -C "$dest"
rm -f "$tmp"
print "obscura $version installed: $dest/obscura"
