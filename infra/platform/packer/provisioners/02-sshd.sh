#!/usr/bin/env bash
set -euo pipefail

# NOTE: we do NOT restart ssh here. That would cut the provisioner session.
# Packer's post-processor will reboot the box before the snapshot is taken,
# which picks up the new port. SST's existing firewall rule opens 2222.

echo "==> setting sshd to listen on port 2222"
sed -i 's/^#\?Port .*/Port 2222/' /etc/ssh/sshd_config
