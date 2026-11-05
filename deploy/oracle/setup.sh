#!/usr/bin/env bash
# One-time setup for an Ubuntu 22.04/24.04 VM (Oracle Cloud Always Free, Ampere/ARM or x86).
# Installs Docker, adds swap, and clones the private repo with a read-only deploy key.
#
#   scp deploy/oracle/setup.sh ubuntu@<VM_IP>:~   # from your Mac (the repo is private)
#   bash setup.sh                                 # on the VM
#
# Safe to re-run.
set -euo pipefail

REPO_SSH="git@github.com:Piyush-Sharma788/MauritX.git"
APP_DIR="$HOME/MauritX"
KEY="$HOME/.ssh/marutix_deploy"

echo "==> Installing Docker and git"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

echo "==> Adding 2 GB swap (Chromium builds and spikes)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> GitHub deploy key"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "marutix-oracle-worker" -f "$KEY" >/dev/null
fi
if ! grep -q "marutix_deploy" "$HOME/.ssh/config" 2>/dev/null; then
  cat >>"$HOME/.ssh/config" <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi
ssh-keyscan -t ed25519 github.com >>"$HOME/.ssh/known_hosts" 2>/dev/null

if [ ! -d "$APP_DIR/.git" ]; then
  if ! git clone "$REPO_SSH" "$APP_DIR" 2>/dev/null; then
    echo
    echo "Add this public key as a READ-ONLY deploy key, then run this script again:"
    echo "  GitHub → Piyush-Sharma788/MauritX → Settings → Deploy keys → Add deploy key"
    echo
    cat "$KEY.pub"
    exit 1
  fi
fi

echo
echo "Done. Next:"
echo "  1. Log out and back in (so 'docker' works without sudo)."
echo "  2. Create $APP_DIR/deploy/oracle/.env.production (see deploy/oracle/README.md)."
echo "  3. cd $APP_DIR/deploy/oracle && docker compose up -d --build"
