#!/bin/bash
# Build OpenNova Raspberry Pi image
#
# This script takes a Raspberry Pi OS Lite base image and customizes it
# with the OpenNova server, BLE provisioning, and auto-setup.
#
# Usage: ./build-image.sh [base-image.img]
#
# Requirements:
#   - Docker (for cross-compilation on non-ARM hosts)
#   - Raspberry Pi OS Lite image (auto-downloaded if not provided)
#   - ~4GB free disk space

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_IMAGE="$SCRIPT_DIR/opennovabot.img"
MOUNT_DIR="/tmp/opennovabot-mount"

echo "╔══════════════════════════════════════╗"
echo "║  OpenNova RPi Image Builder          ║"
echo "╚══════════════════════════════════════╝"

# ── Step 1: Get base image ────────────────────────────────────────────────────

BASE_IMAGE="${1:-}"
if [ -z "$BASE_IMAGE" ]; then
    BASE_IMAGE="$SCRIPT_DIR/raspios-lite.img"
    if [ ! -f "$BASE_IMAGE" ]; then
        echo "[1/6] Downloading Raspberry Pi OS Lite..."
        curl -L -o "$BASE_IMAGE.xz" \
            "https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2024-11-19/2024-11-19-raspios-bookworm-arm64-lite.img.xz"
        xz -d "$BASE_IMAGE.xz"
    fi
fi

echo "[1/6] Base image: $BASE_IMAGE"

# ── Step 2: Copy and resize image ─────────────────────────────────────────────

echo "[2/6] Preparing image..."
cp "$BASE_IMAGE" "$OUTPUT_IMAGE"
# Extend by 2GB for our software
truncate -s +2G "$OUTPUT_IMAGE"
# Resize the root partition
LOOP=$(sudo losetup -fP --show "$OUTPUT_IMAGE")
sudo parted "${LOOP}" resizepart 2 100%
sudo e2fsck -f "${LOOP}p2" || true
sudo resize2fs "${LOOP}p2"

# ── Step 3: Mount and customize ───────────────────────────────────────────────

echo "[3/6] Mounting image..."
sudo mkdir -p "$MOUNT_DIR"
sudo mount "${LOOP}p2" "$MOUNT_DIR"
sudo mount "${LOOP}p1" "$MOUNT_DIR/boot/firmware" 2>/dev/null || \
    sudo mount "${LOOP}p1" "$MOUNT_DIR/boot"

# ── Step 4: Install OpenNova ──────────────────────────────────────────────────

echo "[4/6] Installing OpenNova..."

# Copy server code
sudo mkdir -p "$MOUNT_DIR/opt/opennovabot"
sudo cp -r "$PROJECT_DIR/novabot-server" "$MOUNT_DIR/opt/opennovabot/server"
sudo cp -r "$PROJECT_DIR/setup-wizard" "$MOUNT_DIR/opt/opennovabot/setup-wizard"
sudo cp -r "$PROJECT_DIR/research/cloud_devices_anonymous.json" "$MOUNT_DIR/opt/opennovabot/cloud_devices_anonymous.json"

# Copy firmware for OTA
sudo mkdir -p "$MOUNT_DIR/opt/opennovabot/firmware"
if [ -f "$PROJECT_DIR/novabot-server/firmware/mower_firmware_v6.0.2-custom-17.deb" ]; then
    sudo cp "$PROJECT_DIR/novabot-server/firmware/mower_firmware_v6.0.2-custom-17.deb" \
        "$MOUNT_DIR/opt/opennovabot/firmware/"
fi

# Copy setup script
sudo cp "$SCRIPT_DIR/setup-firstboot.sh" "$MOUNT_DIR/opt/opennovabot/setup-firstboot.sh"
sudo chmod +x "$MOUNT_DIR/opt/opennovabot/setup-firstboot.sh"

# Copy systemd services
sudo cp "$SCRIPT_DIR/opennovabot.service" "$MOUNT_DIR/etc/systemd/system/"
sudo cp "$SCRIPT_DIR/opennovabot-setup.service" "$MOUNT_DIR/etc/systemd/system/"

# Enable services
sudo chroot "$MOUNT_DIR" systemctl enable opennovabot.service
sudo chroot "$MOUNT_DIR" systemctl enable opennovabot-setup.service

# ── Step 5: Configure networking ──────────────────────────────────────────────

echo "[5/6] Configuring network..."

# Enable SSH
sudo touch "$MOUNT_DIR/boot/firmware/ssh" 2>/dev/null || sudo touch "$MOUNT_DIR/boot/ssh"

# Set hostname
echo "opennovabot" | sudo tee "$MOUNT_DIR/etc/hostname" > /dev/null
sudo sed -i 's/raspberrypi/opennovabot/g' "$MOUNT_DIR/etc/hosts"

# Configure WiFi AP mode for first boot (hostapd)
cat << 'HOSTAPD' | sudo tee "$MOUNT_DIR/etc/hostapd/hostapd.conf" > /dev/null
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
wpa_pairwise=TKIP
rsn_pairwise=CCMP
HOSTAPD

# dnsmasq config for AP mode + DNS redirect
cat << 'DNSMASQ' | sudo tee "$MOUNT_DIR/etc/dnsmasq.d/opennovabot.conf" > /dev/null
# WiFi AP DHCP
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h

# DNS redirect for Novabot
address=/mqtt.lfibot.com/192.168.4.1
address=/app.lfibot.com/192.168.4.1

# Upstream DNS
server=8.8.8.8
server=1.1.1.1
DNSMASQ

# ── Step 6: Unmount and compress ──────────────────────────────────────────────

echo "[6/6] Finalizing image..."
sudo umount -R "$MOUNT_DIR"
sudo losetup -d "$LOOP"

# Compress
echo "Compressing image..."
gzip -k "$OUTPUT_IMAGE"
SIZE=$(du -h "$OUTPUT_IMAGE.gz" | cut -f1)
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Image built successfully!           ║"
echo "╠══════════════════════════════════════╣"
echo "║  $OUTPUT_IMAGE.gz ($SIZE)"
echo "║  Flash with: Raspberry Pi Imager     ║"
echo "╚══════════════════════════════════════╝"
