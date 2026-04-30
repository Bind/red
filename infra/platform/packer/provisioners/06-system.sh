#!/usr/bin/env bash
set -euo pipefail

echo "==> creating red directory layout"
mkdir -p /opt/red /opt/red-previews
chmod 755 /opt/red /opt/red-previews

echo "==> kernel tuning: fs.inotify.max_user_watches (bun --watch friendly)"
cat > /etc/sysctl.d/99-red.conf <<'SYSCTL'
fs.inotify.max_user_watches = 524288
vm.max_map_count = 262144
SYSCTL

echo "==> firewall: Hetzner cloud firewall handles ingress; ufw is a belt-and-suspenders default-deny"
if command -v ufw >/dev/null 2>&1; then
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 2222/tcp comment "admin ssh"
  ufw allow 80/tcp
  ufw allow 443/tcp
  yes | ufw enable || true
fi

echo "==> cleaning apt caches so the snapshot stays small"
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
