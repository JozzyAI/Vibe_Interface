#!/usr/bin/env bash
# Re-deploy after a code change — pull latest, rebuild image, restart service.
# Run on the GCP VM: sudo bash /opt/vi/packages/relay/deploy/gcp/deploy-update.sh

set -euo pipefail

REPO_DIR="/opt/vi"

echo "[1/3] Pull latest code"
git -C "$REPO_DIR" pull --ff-only

echo "[2/3] Rebuild relay image"
docker build -t vi-relay "$REPO_DIR/packages/relay"

echo "[3/3] Restart service"
systemctl restart vi-relay
systemctl status vi-relay --no-pager

echo "Done."
