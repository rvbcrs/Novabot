#!/bin/bash
# OpenNova first-boot setup script
# Runs once on first boot to install Node.js and dependencies.

set -euo pipefail

MARKER="/opt/opennovabot/.setup-done"
LOG="/var/log/opennovabot-setup.log"

if [ -f "$MARKER" ]; then
    echo "Setup already completed, skipping."
    exit 0
fi

exec > >(tee -a "$LOG") 2>&1
echo "╔══════════════════════════════════════╗"
echo "║  OpenNova First Boot Setup           ║"
echo "╚══════════════════════════════════════╝"
echo "$(date): Starting first-boot setup..."

# ── Install Node.js 20 LTS ───────────────────────────────────────────────────

echo "[1/5] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── Install system dependencies ───────────────────────────────────────────────

echo "[2/5] Installing system packages..."
apt-get install -y \
    dnsmasq \
    hostapd \
    nginx \
    openssl \
    bluetooth \
    bluez \
    libbluetooth-dev

# ── Install npm dependencies ─────────────────────────────────────────────────

echo "[3/5] Installing server dependencies..."
cd /opt/opennovabot/server
npm ci --production

# ── Generate TLS certificate ─────────────────────────────────────────────────

echo "[4/5] Generating TLS certificate..."
CERT_DIR="/opt/opennovabot/certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.key" ]; then
    openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/server.key" \
        -out "$CERT_DIR/server.crt" -days 3650 -nodes \
        -subj "/CN=opennovabot.local" \
        -addext "subjectAltName=DNS:opennovabot.local,DNS:mqtt.lfibot.com,DNS:app.lfibot.com"
fi

# ── Configure nginx ──────────────────────────────────────────────────────────

echo "[5/5] Configuring nginx..."
cat << 'NGINX' > /etc/nginx/sites-available/opennovabot
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate /opt/opennovabot/certs/server.crt;
    ssl_certificate_key /opt/opennovabot/certs/server.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/opennovabot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx

# ── Enable AP mode ────────────────────────────────────────────────────────────

# AP mode is only active during setup (before WiFi is configured)
systemctl unmask hostapd
systemctl enable hostapd

# ── Mark setup as done ────────────────────────────────────────────────────────

touch "$MARKER"
echo "$(date): First-boot setup complete!"
echo "Rebooting in 5 seconds..."
sleep 5
reboot
