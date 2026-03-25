#!/bin/bash
# ╔══════════════════════════════════════╗
# ║  OpenNova Raspberry Pi Installer     ║
# ╚══════════════════════════════════════╝
#
# Run on a fresh Raspberry Pi OS Lite (Bookworm, 64-bit):
#   curl -fsSL https://raw.githubusercontent.com/rvbcrs/Novabot/master/rpi-image/install.sh | bash
#
# Or clone the repo first:
#   git clone https://github.com/rvbcrs/Novabot.git
#   cd Novabot/rpi-image && bash install.sh
#
# What it does:
#   1. Installs Node.js 20, dnsmasq, hostapd, nginx, Bluetooth tools
#   2. Copies the server + wizard to /opt/opennovabot
#   3. Configures WiFi AP, DNS, HTTPS, systemd services
#   4. Reboots → OpenNova-Setup WiFi appears → user opens wizard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/opennovabot"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  OpenNova Raspberry Pi Installer     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# Must run as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root: sudo bash install.sh${NC}"
  exit 1
fi

# ── Step 1: System packages ───────────────────────────────────────────────────

echo -e "${GREEN}[1/7]${NC} Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git dnsmasq hostapd nginx openssl \
  bluetooth bluez libbluetooth-dev \
  build-essential python3 > /dev/null 2>&1

# ── Step 2: Node.js 20 ───────────────────────────────────────────────────────

if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* && "$(node -v)" != v22* ]]; then
  echo -e "${GREEN}[2/7]${NC} Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
else
  echo -e "${GREEN}[2/7]${NC} Node.js $(node -v) already installed"
fi

# ── Step 3: Copy files ────────────────────────────────────────────────────────

echo -e "${GREEN}[3/7]${NC} Installing OpenNova to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"/{data,certs,firmware}

# If running from repo, copy from there. Otherwise clone.
if [ -d "$REPO_DIR/novabot-server" ]; then
  echo "  Copying from local repo..."
  cp -r "$REPO_DIR/novabot-server" "$INSTALL_DIR/server"
  cp -r "$SCRIPT_DIR/wizard" "$INSTALL_DIR/wizard"
  # Copy factory device database
  [ -f "$REPO_DIR/research/cloud_devices_anonymous.json" ] && \
    cp "$REPO_DIR/research/cloud_devices_anonymous.json" "$INSTALL_DIR/server/"
  # Copy firmware if available
  [ -d "$REPO_DIR/novabot-server/firmware" ] && \
    cp "$REPO_DIR/novabot-server/firmware"/*.deb "$INSTALL_DIR/firmware/" 2>/dev/null || true
else
  echo "  Cloning from GitHub..."
  TMPDIR=$(mktemp -d)
  git clone --depth 1 https://github.com/rvbcrs/Novabot.git "$TMPDIR"
  cp -r "$TMPDIR/novabot-server" "$INSTALL_DIR/server"
  cp -r "$TMPDIR/rpi-image/wizard" "$INSTALL_DIR/wizard"
  [ -f "$TMPDIR/research/cloud_devices_anonymous.json" ] && \
    cp "$TMPDIR/research/cloud_devices_anonymous.json" "$INSTALL_DIR/server/"
  rm -rf "$TMPDIR"
fi

# Install npm dependencies
echo "  Installing npm dependencies..."
cd "$INSTALL_DIR/server" && npm ci --production --quiet 2>/dev/null
# TypeScript is run via tsx at runtime — no build step needed

# ── Step 4: Generate TLS certificate ─────────────────────────────────────────

echo -e "${GREEN}[4/7]${NC} Generating TLS certificate..."
if [ ! -f "$INSTALL_DIR/certs/server.key" ]; then
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$INSTALL_DIR/certs/server.key" \
    -out "$INSTALL_DIR/certs/server.crt" \
    -days 3650 -nodes \
    -subj "/CN=opennovabot.local" \
    -addext "subjectAltName=DNS:opennovabot.local,DNS:mqtt.lfibot.com,DNS:app.lfibot.com" \
    2>/dev/null
  echo "  Certificate generated"
else
  echo "  Certificate already exists"
fi

# ── Step 5: Configure networking ──────────────────────────────────────────────

echo -e "${GREEN}[5/7]${NC} Configuring WiFi AP + DNS..."

# Hostname
echo "opennovabot" > /etc/hostname
sed -i 's/raspberrypi/opennovabot/g' /etc/hosts 2>/dev/null || true

# hostapd — WiFi Access Point
cat > /etc/hostapd/hostapd.conf << 'EOF'
interface=wlan0
driver=nl80211
ssid=OpenNova-Setup
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
wpa=2
wpa_passphrase=12345678
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF
echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' > /etc/default/hostapd

# dnsmasq — DNS redirect + DHCP for AP
cat > /etc/dnsmasq.d/opennovabot.conf << 'EOF'
# WiFi AP DHCP range
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h

# DNS redirect — mower only accepts mqtt.lfibot.com
address=/mqtt.lfibot.com/192.168.4.1
address=/app.lfibot.com/192.168.4.1

# Upstream DNS for everything else
server=8.8.8.8
server=1.1.1.1
EOF

# Static IP for wlan0 in AP mode
cat >> /etc/dhcpcd.conf << 'EOF'

# OpenNova WiFi AP
interface wlan0
  static ip_address=192.168.4.1/24
  nohook wpa_supplicant
EOF

# ── Step 6: Configure nginx ──────────────────────────────────────────────────

echo -e "${GREEN}[6/7]${NC} Configuring nginx..."
cat > /etc/nginx/sites-available/opennovabot << 'NGINX'
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

# ── Step 7: Systemd services ─────────────────────────────────────────────────

echo -e "${GREEN}[7/7]${NC} Installing systemd services..."

cat > /etc/systemd/system/opennovabot.service << 'SERVICE'
[Unit]
Description=OpenNova Server
After=network.target dnsmasq.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/opennovabot/server
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/opt/opennovabot/data/novabot.db
Environment=STORAGE_PATH=/opt/opennovabot/data/storage
Environment=FIRMWARE_PATH=/opt/opennovabot/firmware
Environment=CERT_PATH=/opt/opennovabot/certs
Environment=SETUP_WIZARD_PATH=/opt/opennovabot/wizard
Environment=TARGET_IP=192.168.4.1
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

# Enable all services
systemctl daemon-reload
systemctl enable opennovabot.service
systemctl unmask hostapd 2>/dev/null || true
systemctl enable hostapd
systemctl enable dnsmasq
systemctl enable nginx

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Installation complete!              ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════╣${NC}"
echo -e "${CYAN}║  Reboot to start OpenNova:           ║${NC}"
echo -e "${CYAN}║    sudo reboot                       ║${NC}"
echo -e "${CYAN}║                                      ║${NC}"
echo -e "${CYAN}║  After reboot:                       ║${NC}"
echo -e "${CYAN}║  1. Connect to WiFi: OpenNova-Setup  ║${NC}"
echo -e "${CYAN}║     Password: 12345678               ║${NC}"
echo -e "${CYAN}║  2. Open: http://192.168.4.1         ║${NC}"
echo -e "${CYAN}║     or: http://opennovabot.local     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
