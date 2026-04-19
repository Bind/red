#!/usr/bin/env bash
set -euo pipefail

echo "==> apt update + base tools"
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl \
  ca-certificates \
  gnupg \
  git \
  jq \
  rsync \
  unattended-upgrades \
  tzdata

echo "==> enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades
