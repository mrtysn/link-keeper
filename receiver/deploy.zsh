#!/bin/zsh
# DESC: Deploy (or redeploy) the inbox receiver to an always-on box over ssh.
#
# Idempotent: copies the script, generates the token only if none exists, installs the systemd
# unit only if absent (an existing unit's bind address is left alone), restarts the service, and
# prints the health check. Root on the target is assumed (a Hetzner-style box).
#
# The token lives in /opt/link-keeper/.env (600) and the unit loads it with EnvironmentFile=.
# An Environment= line would put it in reach of any user on the box (`systemctl show`), so a
# unit from an older deploy that still carries one is migrated to the file.
#
# Usage:
#   ./deploy.zsh <ssh-host> <bind-ip>      # e.g. ./deploy.zsh node01 100.81.213.35
#
# The bind ip should be the target's Tailscale address, so the receiver never faces the
# open internet. Port is fixed at 8477 unless you edit the unit afterwards.

set -euo pipefail

here=${0:A:h}

if [[ $# -lt 2 || $1 == -h || $1 == --help ]]; then
  sed -n '2,13p' "$0" | sed 's/^# \?//'
  exit $(( $# < 2 ))
fi

host=$1
bind=$2

print "→ copying receiver to $host"
ssh -o BatchMode=yes "$host" 'mkdir -p /opt/link-keeper'
scp -q "$here/link-inbox-receiver.py" "$host:/opt/link-keeper/"

print "→ token (kept if already present)"
ssh -o BatchMode=yes "$host" 'set -e; env=/opt/link-keeper/.env
if ! grep -qs "^LINK_INBOX_TOKEN=." "$env"; then
  tok=$(cat /etc/link-inbox.token 2>/dev/null || openssl rand -hex 24)   # older deploys kept it there
  (umask 077; printf "LINK_INBOX_TOKEN=%s\n" "$tok" > "$env")
fi
chmod 600 "$env"'

print "→ systemd unit (written only if absent)"
if ! ssh -o BatchMode=yes "$host" 'test -f /etc/systemd/system/link-inbox.service'; then
  scp -q "$here/link-inbox.service.example" "$host:/etc/systemd/system/link-inbox.service"
  ssh -o BatchMode=yes "$host" "sed -i 's/100.x.y.z/$bind/' /etc/systemd/system/link-inbox.service"
fi
ssh -o BatchMode=yes "$host" 'sed -i "s|^Environment=LINK_INBOX_TOKEN=.*|EnvironmentFile=/opt/link-keeper/.env|" /etc/systemd/system/link-inbox.service'

print "→ restarting"
ssh -o BatchMode=yes "$host" 'systemctl daemon-reload && systemctl enable --now link-inbox >/dev/null 2>&1; systemctl restart link-inbox && sleep 1 && systemctl is-active link-inbox'

print "→ health"
ssh -o BatchMode=yes "$host" "curl -s --max-time 3 http://$bind:8477/"
print "\ndone — the phone app needs: endpoint http://$bind:8477 and the token from $host:/opt/link-keeper/.env"
