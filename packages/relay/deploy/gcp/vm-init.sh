#!/usr/bin/env bash
# One-time setup for a GCP e2-micro VM running the VI relay.
# Tested on Debian 12 (bookworm) — the GCP default image.
#
# Usage:
#   sudo bash vm-init.sh <domain> <vi-token> <daemon-token> [disk-device]
#
#   vi-token    — dashboard auth token (VI_RELAY_VI_TOKEN in .env.local)
#   daemon-token — vi-agent daemon token (VI_RELAY_DAEMON_TOKEN in .env.local)
#
# Example:
#   sudo bash vm-init.sh relay.dynastylab.ai tok_abc123 daemon_xyz789 /dev/sdb
#
# After this script completes the relay is live at https://<domain>.
# To update after a code change: sudo bash deploy-update.sh

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <vi-token> <daemon-token> [disk-device]}"
VI_TOKEN="${2:?Missing vi-token (dashboard token)}"
DAEMON_TOKEN="${3:?Missing daemon-token}"
DATA_DISK="${4:-/dev/sdb}"
DATA_MOUNT="/data"
REPO_DIR="/opt/vi"

echo "[1/8] Mount persistent disk $DATA_DISK -> $DATA_MOUNT"
if ! blkid "$DATA_DISK" > /dev/null 2>&1; then
  mkfs.ext4 -F "$DATA_DISK"
fi
mkdir -p "$DATA_MOUNT"
mount "$DATA_DISK" "$DATA_MOUNT" 2>/dev/null || true
if ! grep -q "$DATA_DISK" /etc/fstab; then
  echo "$DATA_DISK $DATA_MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

echo "[2/8] Install Docker"
apt-get update -y -qq
apt-get install -y -qq ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io
systemctl enable docker

echo "[3/8] Install nginx + certbot"
apt-get install -y -qq nginx certbot python3-certbot-nginx

echo "[4/8] Clone repo and build relay image"
if [[ -d "$REPO_DIR" ]]; then
  git -C "$REPO_DIR" pull --ff-only
else
  git clone https://github.com/JozzyAI/Project_Interface.git "$REPO_DIR"
fi
docker build -t vi-relay "$REPO_DIR/packages/relay"

echo "[5/8] Write env file"
cat > /etc/vi-relay.env <<ENV
VI_RELAY_PORT=8787
VI_RELAY_HOST=0.0.0.0
VI_RELAY_DB_PATH=/data/vi-relay.db
VI_RELAY_TOKENS=${VI_TOKEN}:vi:dashboard,${DAEMON_TOKEN}:daemon:daemon
VI_RELAY_VI_TOKEN=${VI_TOKEN}
VI_RELAY_OWNER_TOKEN=${VI_TOKEN}
VI_RELAY_DAEMON_TOKEN=${DAEMON_TOKEN}
VI_RELAY_BASE_URL=https://${DOMAIN}
VI_RELAY_PUBLIC_WS_URL=wss://${DOMAIN}
ENV
chmod 600 /etc/vi-relay.env

echo "[6/8] Create systemd service"
cat > /etc/systemd/system/vi-relay.service <<UNIT
[Unit]
Description=VI Relay
After=docker.service network-online.target
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker stop vi-relay
ExecStartPre=-/usr/bin/docker rm vi-relay
ExecStart=/usr/bin/docker run --rm --name vi-relay \\
  --env-file /etc/vi-relay.env \\
  -v /data:/data \\
  -p 127.0.0.1:8787:8787 \\
  vi-relay
ExecStop=/usr/bin/docker stop vi-relay

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable vi-relay
systemctl start vi-relay

echo "[7/8] Configure nginx"
cp "$REPO_DIR/packages/relay/deploy/gcp/nginx.conf" /etc/nginx/sites-available/vi-relay
sed -i "s/YOUR_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/vi-relay
ln -sf /etc/nginx/sites-available/vi-relay /etc/nginx/sites-enabled/vi-relay
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "[8/8] Obtain SSL certificate (requires DNS already pointing to this VM)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}"

echo ""
echo "VI relay is live at https://$DOMAIN"
echo "Add to dashboard .env.local:"
echo "  VI_RELAY_BASE_URL=https://$DOMAIN"
echo "  VI_RELAY_PUBLIC_WS_URL=wss://$DOMAIN"
echo "  VI_RELAY_VI_TOKEN=<your vi-token>"
echo "  VI_RELAY_DAEMON_TOKEN=<your daemon-token>"
echo ""
echo "Add to vi-agent env:"
echo "  VI_SERVER=https://$DOMAIN"
echo "  VI_RELAY_TOKEN=<your daemon-token>"
echo ""
echo "When ready, shut down Fly.io:"
echo "  fly apps destroy vi-relay-jozzy"
