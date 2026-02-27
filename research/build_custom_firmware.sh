#!/bin/bash
#
# build_custom_firmware.sh — Bouw aangepaste maaier firmware .deb
#
# Wijzigingen t.o.v. origineel:
#   1. SSH server (openssh-server) wordt geïnstalleerd bij OTA
#   2. HTTP upload URL wijst naar lokale server i.p.v. cloud
#   3. Root wachtwoord wordt ingesteld voor SSH login
#   4. ROS_LOCALHOST_ONLY optioneel uitschakelbaar
#
# Gebruik:
#   ./build_custom_firmware.sh                          # Standaard: novabot.local server
#   ./build_custom_firmware.sh --server 192.168.1.50    # Specifiek IP
#   ./build_custom_firmware.sh --server myserver.nl     # Eigen hostname
#   ./build_custom_firmware.sh --ssh-password geheim    # Eigen SSH wachtwoord
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORIGINAL_DEB="$SCRIPT_DIR/mower_firmware_v5.7.1.deb"
WORK_DIR="/tmp/mower_firmware_custom"
OUTPUT_DIR="$SCRIPT_DIR/firmware"

# === Configuratie (aanpasbaar via CLI args) ===
SERVER_HOST="novabot.local"
SERVER_HTTP_PORT="3000"
SSH_PASSWORD="novabot"
SSH_PORT="22"
ENABLE_REMOTE_ROS2="false"
VERSION_SUFFIX="custom-1"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --server)       SERVER_HOST="$2"; shift 2 ;;
        --http-port)    SERVER_HTTP_PORT="$2"; shift 2 ;;
        --ssh-password) SSH_PASSWORD="$2"; shift 2 ;;
        --ssh-port)     SSH_PORT="$2"; shift 2 ;;
        --remote-ros2)  ENABLE_REMOTE_ROS2="true"; shift ;;
        --version)      VERSION_SUFFIX="$2"; shift 2 ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --server HOST       Server hostname/IP (default: novabot.local)"
            echo "  --http-port PORT    HTTP port (default: 3000)"
            echo "  --ssh-password PWD  Root SSH password (default: novabot)"
            echo "  --ssh-port PORT     SSH port (default: 22)"
            echo "  --remote-ros2       Enable ROS 2 network access (default: off)"
            echo "  --version SUFFIX    Version suffix (default: custom-1)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

VERSION="v5.7.1-${VERSION_SUFFIX}"
HTTP_BASE="http://${SERVER_HOST}:${SERVER_HTTP_PORT}"

echo "============================================"
echo "  Novabot Custom Firmware Builder"
echo "============================================"
echo "  Server:       ${SERVER_HOST}:${SERVER_HTTP_PORT}"
echo "  SSH password:  ${SSH_PASSWORD}"
echo "  Version:       ${VERSION}"
echo "  Remote ROS 2:  ${ENABLE_REMOTE_ROS2}"
echo "============================================"
echo ""

# === Stap 1: Controleer bronbestand ===
if [ ! -f "$ORIGINAL_DEB" ]; then
    echo "ERROR: Originele firmware niet gevonden: $ORIGINAL_DEB"
    echo "Download eerst via: node research/download_firmware.js"
    exit 1
fi

# === Stap 2: Schoon werkdirectory ===
echo "[1/7] Werkdirectory voorbereiden..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# === Stap 3: Uitpakken ===
echo "[2/7] Firmware uitpakken..."

# De .deb bevat data.tar.xz met flat structuur (./scripts/, ./install/, etc.)
# OTA flow doet: dpkg -x package.deb /root/novabot.new/
# Wij pakken uit naar WORK_DIR/firmware_data/ voor aanpassing
FIRMWARE_DATA="$WORK_DIR/firmware_data"
mkdir -p "$FIRMWARE_DATA"

cd "$WORK_DIR"
ar x "$ORIGINAL_DEB"
echo "  .deb uitgepakt (ar)"

if [ -f data.tar.xz ]; then
    tar -xf data.tar.xz -C "$FIRMWARE_DATA"
    echo "  data.tar.xz uitgepakt"
elif [ -f data.tar.gz ]; then
    tar -xzf data.tar.gz -C "$FIRMWARE_DATA"
elif [ -f data.tar.zst ]; then
    zstd -d data.tar.zst -o data.tar && tar -xf data.tar -C "$FIRMWARE_DATA"
fi
cd "$SCRIPT_DIR"

# Firmware data root = waar scripts/, install/, etc. staan
NOVABOT_ROOT="$FIRMWARE_DATA"

if [ ! -d "$NOVABOT_ROOT/scripts" ]; then
    echo "ERROR: Firmware structuur niet herkend (geen scripts/ map)"
    echo "  Inhoud: $(ls "$NOVABOT_ROOT")"
    exit 1
fi

echo "  Firmware root: $NOVABOT_ROOT"
echo "  Bestanden: $(find "$NOVABOT_ROOT" -type f | wc -l | tr -d ' ')"

# === Stap 4: SSH installatie toevoegen aan start_service.sh ===
echo "[3/7] SSH installatie toevoegen..."

START_SERVICE="$NOVABOT_ROOT/scripts/start_service.sh"

if [ ! -f "$START_SERVICE" ]; then
    echo "ERROR: start_service.sh niet gevonden op $START_SERVICE"
    exit 1
fi

# Genereer het SSH installatie blok als apart bestand
# Variabelen worden nu ingevuld door het build-script
SSH_BLOCK="/tmp/ssh_install_block.sh"
cat > "$SSH_BLOCK" << SSHEOF

# ============================================================
# CUSTOM: Install and configure SSH server
# ============================================================
echo "Installing openssh-server..." >> \$path/start_service.log
if ! dpkg -l openssh-server 2>/dev/null | grep -q '^ii'; then
    apt-get update -qq 2>/dev/null
    apt-get install -y -qq openssh-server 2>/dev/null
    if [ \$? -eq 0 ]; then
        echo "openssh-server installed successfully" >> \$path/start_service.log
    else
        echo "openssh-server install failed (no internet?)" >> \$path/start_service.log
    fi
fi

# Configureer SSH
if [ -f /etc/ssh/sshd_config ]; then
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
    sed -i 's/^#*Port .*/Port ${SSH_PORT}/' /etc/ssh/sshd_config
    systemctl enable ssh 2>/dev/null
    systemctl restart ssh 2>/dev/null
    echo "SSH configured on port ${SSH_PORT}" >> \$path/start_service.log
fi

# Stel root wachtwoord in
echo "root:${SSH_PASSWORD}" | chpasswd 2>/dev/null
echo "Root password configured for SSH" >> \$path/start_service.log
# ============================================================
SSHEOF

# Voeg het SSH blok toe na de dnsmasq install regel in start_service.sh
if grep -q "sudo apt install -y dnsmasq" "$START_SERVICE"; then
    sed -i '' '/sudo apt install -y dnsmasq/r /tmp/ssh_install_block.sh' "$START_SERVICE"
    echo "  SSH installatie toegevoegd na dnsmasq install"
else
    # Fallback: voeg toe voor de laatste echo
    sed -i '' '/^echo "start service finish"/r /tmp/ssh_install_block.sh' "$START_SERVICE"
    echo "  SSH installatie toegevoegd (fallback positie)"
fi

rm -f "$SSH_BLOCK"

# === Stap 5: HTTP server URL aanpassen ===
echo "[4/7] Server URLs aanpassen..."

# 5a. log_manager.yaml — upload URL
LOG_YAML="$NOVABOT_ROOT/install/log_manager/share/log_manager/config/log_manager.yaml"
if [ -f "$LOG_YAML" ]; then
    sed -i '' "s|url: \"http://app.lfibot.com/api/nova-file-server/log/uploadEquipmentLog\"|url: \"${HTTP_BASE}/api/nova-file-server/log/uploadEquipmentLog\"|" "$LOG_YAML"
    echo "  log_manager.yaml: URL → ${HTTP_BASE}"
fi

# 5b. Voeg script toe dat http_address.txt correct zet bij elke boot
# Dit overrulet de hardcoded app.lfibot.com fallback in mqtt_node
cat > "$NOVABOT_ROOT/scripts/set_server_urls.sh" << URLSCRIPT
#!/bin/bash
# CUSTOM: Stel lokale server URLs in
# Dit script wordt aangeroepen bij elke boot vanuit run_novabot.sh

HTTP_ADDRESS="${HTTP_BASE}"
HTTP_ADDR_FILE="/userdata/lfi/http_address.txt"

# Schrijf het lokale server adres
mkdir -p /userdata/lfi
echo "\${HTTP_ADDRESS}" > "\${HTTP_ADDR_FILE}"

echo "[\$(date)] Server URL set to \${HTTP_ADDRESS}" >> /userdata/ota/custom_firmware.log
URLSCRIPT
chmod +x "$NOVABOT_ROOT/scripts/set_server_urls.sh"
echo "  set_server_urls.sh aangemaakt"

# 5c. Voeg set_server_urls.sh toe aan run_novabot.sh (na de source lines, voor de case statement)
RUN_NOVABOT="$NOVABOT_ROOT/scripts/run_novabot.sh"
if [ -f "$RUN_NOVABOT" ]; then
    # Voeg toe vlak voor "case "$1" in"
    if ! grep -q "set_server_urls.sh" "$RUN_NOVABOT"; then
        sed -i '' '/^case "\$1" in/i\
# CUSTOM: Stel lokale server URLs in bij elke boot\
if [ -f "/root/novabot/scripts/set_server_urls.sh" ]; then\
    bash /root/novabot/scripts/set_server_urls.sh\
fi\
' "$RUN_NOVABOT"
        echo "  run_novabot.sh: set_server_urls.sh hook toegevoegd"
    fi
fi

# === Stap 6: Optioneel ROS 2 netwerk openzetten ===
if [ "$ENABLE_REMOTE_ROS2" = "true" ]; then
    echo "[5/7] ROS 2 netwerk openzetten..."
    # Vervang ROS_LOCALHOST_ONLY=1 → 0 in run_novabot.sh
    if [ -f "$RUN_NOVABOT" ]; then
        sed -i '' 's/export ROS_LOCALHOST_ONLY=1/export ROS_LOCALHOST_ONLY=0  # CUSTOM: remote ROS 2 enabled/' "$RUN_NOVABOT"
        echo "  ROS_LOCALHOST_ONLY=0 in run_novabot.sh"
    fi
    # En in run_ota.sh
    RUN_OTA="$NOVABOT_ROOT/scripts/run_ota.sh"
    if [ -f "$RUN_OTA" ]; then
        sed -i '' 's/export ROS_LOCALHOST_ONLY=1/export ROS_LOCALHOST_ONLY=0  # CUSTOM: remote ROS 2 enabled/' "$RUN_OTA"
        echo "  ROS_LOCALHOST_ONLY=0 in run_ota.sh"
    fi
else
    echo "[5/7] ROS 2 netwerk: localhost-only (standaard)"
fi

# === Stap 7: Versie-info bijwerken ===
echo "[6/7] Versie-info bijwerken..."

# Update Readme.txt
README="$NOVABOT_ROOT/Readme.txt"
if [ -f "$README" ]; then
    echo "" >> "$README"
    echo "# Custom firmware modifications ($(date +%Y-%m-%d)):" >> "$README"
    echo "# - SSH server (openssh-server) auto-install" >> "$README"
    echo "# - HTTP uploads → ${HTTP_BASE}" >> "$README"
    echo "# - Root password set for SSH access" >> "$README"
    [ "$ENABLE_REMOTE_ROS2" = "true" ] && echo "# - ROS 2 network access enabled" >> "$README"
    echo "# Version: ${VERSION}" >> "$README"
fi

# Update novabot_api.yaml version
API_YAML="$NOVABOT_ROOT/install/novabot_api/share/novabot_api/config/novabot_api.yaml"
if [ -f "$API_YAML" ]; then
    sed -i '' "s/novabot_version_code: v5.7.1/novabot_version_code: ${VERSION}/" "$API_YAML"
    echo "  Versie in novabot_api.yaml → ${VERSION}"
fi

# === Stap 8: Bouw .deb ===
echo "[7/7] .deb bouwen..."
mkdir -p "$OUTPUT_DIR"
OUTPUT_DEB="$OUTPUT_DIR/mower_firmware_${VERSION}.deb"

# De originele .deb bevat data.tar.xz met flat structuur:
#   ./Readme.txt, ./scripts/, ./install/, etc.
# De OTA flow doet: dpkg -x package.deb /root/novabot.new/
# dpkg -x extraheert de data payload naar het target directory
# Dus de flat structuur is correct.

echo "  Herbouwen data.tar.xz vanuit aangepaste firmware..."

# Maak nieuwe data.tar.xz vanuit de aangepaste firmware data
cd "$FIRMWARE_DATA"
tar -cJf "$WORK_DIR/data.tar.xz" .
echo "  data.tar.xz aangemaakt ($(ls -lh "$WORK_DIR/data.tar.xz" | awk '{print $5}'))"
cd "$SCRIPT_DIR"

# Maak DEBIAN/control
mkdir -p "$WORK_DIR/DEBIAN"
cat > "$WORK_DIR/DEBIAN/control" << CTRL
Package: mvp
Version: ${VERSION}
Architecture: arm64
Maintainer: Novabot Custom
Description: Novabot mower firmware ${VERSION}
 Custom build with SSH and local server URLs.
CTRL

# Bouw .deb (ar archief: debian-binary + control.tar.xz + data.tar.xz)
echo "2.0" > "$WORK_DIR/debian-binary"
cd "$WORK_DIR/DEBIAN"
tar -cJf "$WORK_DIR/control.tar.xz" .
cd "$WORK_DIR"

# ar rcs bouwt het .deb archief (volgorde is belangrijk!)
ar rcs "$OUTPUT_DEB" debian-binary control.tar.xz data.tar.xz
BUILD_METHOD="ar"
cd "$SCRIPT_DIR"

if [ ! -f "$OUTPUT_DEB" ]; then
    echo "ERROR: .deb bouwen mislukt"
    exit 1
fi

# === Bereken MD5 ===
if command -v md5sum &>/dev/null; then
    MD5=$(md5sum "$OUTPUT_DEB" | cut -d' ' -f1)
else
    MD5=$(md5 -q "$OUTPUT_DEB")
fi
SIZE=$(ls -lh "$OUTPUT_DEB" | awk '{print $5}')

echo ""
echo "============================================"
echo "  BUILD SUCCESVOL"
echo "============================================"
echo "  Bestand:  $OUTPUT_DEB"
echo "  Grootte:  $SIZE"
echo "  MD5:      $MD5"
echo "  Methode:  $BUILD_METHOD"
echo "  Versie:   $VERSION"
echo "============================================"
echo ""
echo "  Wijzigingen:"
echo "    ✓ SSH server wordt geïnstalleerd bij boot"
echo "    ✓ Root wachtwoord: ${SSH_PASSWORD}"
echo "    ✓ SSH poort: ${SSH_PORT}"
echo "    ✓ HTTP uploads → ${HTTP_BASE}"
echo "    ✓ http_address.txt wordt bij elke boot gezet"
[ "$ENABLE_REMOTE_ROS2" = "true" ] && echo "    ✓ ROS 2 netwerk open (ROS_LOCALHOST_ONLY=0)"
echo ""
echo "============================================"
echo "  OTA FLASH INSTRUCTIES"
echo "============================================"
echo ""
echo "  1. Host het .deb bestand op je server:"
echo "     cp $OUTPUT_DEB /pad/naar/webserver/"
echo ""
echo "  2. Of start een simpele HTTP server:"
echo "     cd $OUTPUT_DIR && python3 -m http.server 8080"
echo ""
echo "  3. Stuur het OTA commando via MQTT:"
echo ""
echo "     Topic: Dart/Send_mqtt/LFIN2230700238"
echo "     Payload:"
cat << OTAJSON
     {
       "ota_upgrade_cmd": {
         "type": "full",
         "content": {
           "upgradeApp": {
             "version": "${VERSION}",
             "downloadUrl": "http://${SERVER_HOST}:8080/$(basename $OUTPUT_DEB)",
             "md5": "${MD5}"
           }
         }
       }
     }
OTAJSON
echo ""
echo "  4. Of gebruik het dashboard commando endpoint:"
echo "     curl -X POST http://localhost:3000/api/dashboard/command/LFIN2230700238 \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"command\": \"ota_upgrade_cmd\", \"params\": {\"type\": \"full\", \"content\": {\"upgradeApp\": {\"version\": \"${VERSION}\", \"downloadUrl\": \"http://${SERVER_HOST}:8080/$(basename $OUTPUT_DEB)\", \"md5\": \"${MD5}\"}}}}'"
echo ""
echo "  BELANGRIJK:"
echo "    - Maaier moet OPLADEN voordat download start"
echo "    - Download duurt 20-30 minuten (35MB via WiFi)"
echo "    - Na reboot: ssh root@<maaier-ip> (wachtwoord: ${SSH_PASSWORD})"
echo "    - Bij problemen: maaier rollback naar v5.7.1 automatisch"
echo ""

# Schrijf OTA JSON naar bestand voor gemakkelijk gebruik
cat > "$OUTPUT_DIR/ota_flash_command.json" << OTAFILE
{
  "ota_upgrade_cmd": {
    "type": "full",
    "content": {
      "upgradeApp": {
        "version": "${VERSION}",
        "downloadUrl": "http://${SERVER_HOST}:8080/$(basename $OUTPUT_DEB)",
        "md5": "${MD5}"
      }
    }
  }
}
OTAFILE

echo "  OTA commando opgeslagen: $OUTPUT_DIR/ota_flash_command.json"
echo ""
