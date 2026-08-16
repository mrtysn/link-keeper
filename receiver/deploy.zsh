#!/bin/zsh
# DESC: Deploy (or redeploy) the inbox receiver to an always-on box over ssh.
#
# Idempotent: copies the script, generates the token only if none exists, installs the systemd
# unit only if absent (an existing unit's token and bind address are left alone), restarts the
# service, and prints the health check. Root on the target is assumed (a Hetzner-style box).
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
ssh -o BatchMode=yes "$host" 'test -s /etc/link-inbox.token || openssl rand -hex 24 > /etc/link-inbox.token; chmod 600 /etc/link-inbox.token'

print "→ systemd unit (written only if absent)"
if ! ssh -o BatchMode=yes "$host" 'test -f /etc/systemd/system/link-inbox.service'; then
  scp -q "$here/link-inbox.service.example" "$host:/etc/systemd/system/link-inbox.service"
  ssh -o BatchMode=yes "$host" "TOKEN=\$(cat /etc/link-inbox.token)
sed -i \"s/CHANGE-ME/\$TOKEN/; s/100.x.y.z/$bind/\" /etc/systemd/system/link-inbox.service
chmod 600 /etc/systemd/system/link-inbox.service"
fi

print "→ restarting"
ssh -o BatchMode=yes "$host" 'systemctl daemon-reload && systemctl enable --now link-inbox >/dev/null 2>&1; systemctl restart link-inbox && sleep 1 && systemctl is-active link-inbox'

print "→ health"
ssh -o BatchMode=yes "$host" "curl -s --max-time 3 http://$bind:8477/"
print "\ndone — the phone app needs: endpoint http://$bind:8477 and the token from $host:/etc/link-inbox.token"
