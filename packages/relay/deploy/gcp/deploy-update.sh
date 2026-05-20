#!/usr/bin/env bash
# Re-deploy after a code change — pull latest, rebuild image, restart service.
# Run on the GCP VM: sudo bash /opt/pi/packages/relay/deploy/gcp/deploy-update.sh

set -euo pipefail

REPO_DIR="/opt/pi"

echo "[1/3] Pull latest code"
git -C "$REPO_DIR" pull --ff-only

echo "[2/3] Rebuild relay image"
docker build -t pi-relay "$REPO_DIR/packages/relay"

echo "[3/3] Restart service"
systemctl restart pi-relay
systemctl status pi-relay --no-pager

echo "Done."
