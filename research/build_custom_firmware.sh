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
#   ./build_custom_firmware.sh                          # Standaard: detecteert nieuwste .deb
#   ./build_custom_firmware.sh --input firmware/mower_firmware_v6.0.2.deb
#   ./build_custom_firmware.sh --server 192.168.1.50    # Specifiek IP
#   ./build_custom_firmware.sh --server myserver.nl     # Eigen hostname
#   ./build_custom_firmware.sh --ssh-password geheim    # Eigen SSH wachtwoord
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_DEB=""
WORK_DIR="/tmp/mower_firmware_custom"
OUTPUT_DIR="$SCRIPT_DIR/firmware"

# === Configuratie (aanpasbaar via CLI args) ===
SERVER_HOST="novabot.local"
SERVER_HTTP_PORT=""  # Leeg = geen poort suffix (reverse proxy op poort 80)
MQTT_HOST=""  # Leeg = zelfde als SERVER_HOST
MQTT_PORT="1883"
SSH_PASSWORD="novabot"
SSH_PORT="22"
ENABLE_REMOTE_ROS2="false"
INCLUDE_SERVER="false"
BUNDLE_NODE="false"
BUNDLE_NODE_IP=""
SERVER_PORT="3000"
VERSION_SUFFIX="custom-1"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --input)        INPUT_DEB="$2"; shift 2 ;;
        --server)       SERVER_HOST="$2"; shift 2 ;;
        --http-port)    SERVER_HTTP_PORT="$2"; shift 2 ;;
        --mqtt-host)    MQTT_HOST="$2"; shift 2 ;;
        --mqtt-port)    MQTT_PORT="$2"; shift 2 ;;
        --ssh-password) SSH_PASSWORD="$2"; shift 2 ;;
        --ssh-port)     SSH_PORT="$2"; shift 2 ;;
        --remote-ros2)    ENABLE_REMOTE_ROS2="true"; shift ;;
        --include-server) INCLUDE_SERVER="true"; shift ;;
        --bundle-node)    BUNDLE_NODE="true"; shift ;;
        --bundle-node-ip) BUNDLE_NODE_IP="$2"; shift 2 ;;
        --server-port)    SERVER_PORT="$2"; shift 2 ;;
        --version)        VERSION_SUFFIX="$2"; shift 2 ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --input FILE        Source .deb firmware (auto-detects newest if omitted)"
            echo "  --server HOST       HTTP server hostname/IP (default: novabot.local)"
            echo "  --http-port PORT    HTTP port (default: none, reverse proxy on 80)"
            echo "  --mqtt-host HOST    MQTT broker hostname (default: same as --server)"
            echo "  --mqtt-port PORT    MQTT port (default: 1883)"
            echo "  --ssh-password PWD  Root SSH password (default: novabot)"
            echo "  --ssh-port PORT     SSH port (default: 22)"
            echo "  --remote-ros2       Enable ROS 2 network access (default: off)"
            echo "  --include-server    Bundle novabot-server + dashboard in firmware"
            echo "  --bundle-node       Also bundle Node.js + node_modules (fully offline install)"
            echo "  --bundle-node-ip IP Mower IP to copy node_modules from (required with --bundle-node)"
            echo "  --server-port PORT  Dashboard port (default: 3000)"
            echo "  --version SUFFIX    Version suffix (default: custom-1)"
            echo ""
            echo "Examples:"
            echo "  $0 --server app.lfibot.com --mqtt-host mqtt.lfibot.com"
            echo "  $0 --input firmware/mower_firmware_v6.0.2.deb --server 192.168.1.50"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# === Auto-detect input .deb if not specified ===
if [ -z "$INPUT_DEB" ]; then
    # Look for mower firmware .deb files (exclude -custom builds)
    CANDIDATES=($(ls -t "$SCRIPT_DIR"/firmware/mower_firmware_v*.deb "$SCRIPT_DIR"/mower_firmware_v*.deb 2>/dev/null | grep -v "custom" || true))
    if [ ${#CANDIDATES[@]} -eq 0 ]; then
        echo "ERROR: Geen mower firmware .deb gevonden."
        echo "Download eerst via: node research/download_firmware.js"
        echo "Of geef een pad op via: $0 --input <pad-naar-.deb>"
        exit 1
    fi
    INPUT_DEB="${CANDIDATES[0]}"
    if [ ${#CANDIDATES[@]} -gt 1 ]; then
        echo "Meerdere firmware bestanden gevonden:"
        for f in "${CANDIDATES[@]}"; do
            echo "  $(basename "$f")"
        done
        echo "Gebruikt: $(basename "$INPUT_DEB") (nieuwste)"
        echo ""
    fi
fi

# Resolve relative paths (relative to current working directory, not SCRIPT_DIR)
if [[ "$INPUT_DEB" != /* ]]; then
    INPUT_DEB="$(pwd)/$INPUT_DEB"
fi

# HTTP_BASE: met poort als opgegeven, anders zonder (reverse proxy op 80)
if [ -n "$SERVER_HTTP_PORT" ]; then
    HTTP_BASE="http://${SERVER_HOST}:${SERVER_HTTP_PORT}"
else
    HTTP_BASE="http://${SERVER_HOST}"
fi

# MQTT host defaults naar SERVER_HOST als niet apart opgegeven
if [ -z "$MQTT_HOST" ]; then
    MQTT_HOST="$SERVER_HOST"
fi


# === Stap 1: Controleer bronbestand ===
if [ ! -f "$INPUT_DEB" ]; then
    echo "ERROR: Firmware niet gevonden: $INPUT_DEB"
    echo "Download eerst via: node research/download_firmware.js"
    exit 1
fi

# === Stap 2: Schoon werkdirectory ===
echo "[1/8] Werkdirectory voorbereiden..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# === Stap 3: Uitpakken ===
echo "[2/8] Firmware uitpakken..."
echo "  Bron: $(basename "$INPUT_DEB")"

# De .deb bevat data.tar.xz met flat structuur (./scripts/, ./install/, etc.)
# OTA flow doet: dpkg -x package.deb /root/novabot.new/
# Wij pakken uit naar WORK_DIR/firmware_data/ voor aanpassing
FIRMWARE_DATA="$WORK_DIR/firmware_data"
mkdir -p "$FIRMWARE_DATA"

cd "$WORK_DIR"
ar x "$INPUT_DEB"
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

# === Stap 4: Detecteer firmware versie ===
echo "[3/8] Firmware versie detecteren..."

API_YAML="$NOVABOT_ROOT/install/novabot_api/share/novabot_api/config/novabot_api.yaml"
if [ -f "$API_YAML" ]; then
    BASE_VERSION=$(grep 'novabot_version_code:' "$API_YAML" | sed 's/.*novabot_version_code: *//' | tr -d ' ')
else
    # Fallback: probeer versie uit bestandsnaam te halen
    BASE_VERSION=$(basename "$INPUT_DEB" | grep -oP 'v[\d.]+' | head -1)
fi

if [ -z "$BASE_VERSION" ]; then
    echo "  WAARSCHUWING: Kan firmware versie niet detecteren, gebruik v0.0.0"
    BASE_VERSION="v0.0.0"
fi

VERSION="${BASE_VERSION}-${VERSION_SUFFIX}$([ "$INCLUDE_SERVER" = "true" ] && echo "-server" || true)"

echo "  Basisversie:  $BASE_VERSION"
echo "  Buildversie:  $VERSION"

echo ""
echo "============================================"
echo "  Novabot Custom Firmware Builder"
echo "============================================"
echo "  Bron:          $(basename "$INPUT_DEB")"
echo "  Basisversie:   ${BASE_VERSION}"
echo "  HTTP server:   ${HTTP_BASE}"
echo "  MQTT broker:   ${MQTT_HOST}:${MQTT_PORT}"
echo "  SSH password:  ${SSH_PASSWORD}"
echo "  Versie:        ${VERSION}"
echo "  Remote ROS 2:  ${ENABLE_REMOTE_ROS2}"
echo "  Server bundel: ${INCLUDE_SERVER}$([ "$INCLUDE_SERVER" = "true" ] && [ "$BUNDLE_NODE" = "true" ] && echo " (offline: Node.js + node_modules gebundeld)" || true)"
echo "============================================"
echo ""

# === Stap 5: SSH installatie toevoegen aan start_service.sh ===
echo "[4/8] SSH installatie toevoegen..."

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
echo "Installing openssh-server + hostapd..." >> \$path/start_service.log
if ! dpkg -l openssh-server 2>/dev/null | grep -q '^ii' || ! dpkg -l hostapd 2>/dev/null | grep -q '^ii'; then
    apt-get update -qq 2>/dev/null
    apt-get install -y -qq openssh-server hostapd 2>/dev/null
    # Disable hostapd auto-start (we starten het zelf via wifi_ap_fallback.sh)
    systemctl disable hostapd 2>/dev/null
    systemctl stop hostapd 2>/dev/null
    if dpkg -l openssh-server 2>/dev/null | grep -q '^ii'; then
        echo "openssh-server installed successfully" >> \$path/start_service.log
    else
        echo "openssh-server install failed (no internet?)" >> \$path/start_service.log
    fi
    if dpkg -l hostapd 2>/dev/null | grep -q '^ii'; then
        echo "hostapd installed successfully" >> \$path/start_service.log
    else
        echo "hostapd install failed (no internet? fallback AP unavailable)" >> \$path/start_service.log
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

# Novabot-server installatie blok toevoegen aan start_service.sh (alleen als --include-server)
if [ "$INCLUDE_SERVER" = "true" ]; then
    SERVER_INSTALL_BLOCK="/tmp/novabot_server_install.sh"
    cat > "$SERVER_INSTALL_BLOCK" << SRVEOF

# ============================================================
# CUSTOM: Novabot-server installatie
# ============================================================
echo "Installing novabot-server..." >> \$path/start_service.log

SERVER_SRC="/root/novabot.new/opt/novabot-server"
DASH_SRC="/root/novabot.new/opt/novabot-dashboard"

# 1. Node.js 20 installeren
if [ -f "\$SERVER_SRC/node-v20-linux-arm64.tar.gz" ]; then
    echo "Extracting bundled Node.js 20..." >> \$path/start_service.log
    mkdir -p /opt/nodejs
    tar xzf "\$SERVER_SRC/node-v20-linux-arm64.tar.gz" -C /opt/nodejs --strip-components=1 2>/dev/null || true
fi

# Zet /usr/local/bin/node op het eerste werkende node binary
# (bundled → system → NodeSource download als fallback)
NODE_OK=0
if /opt/nodejs/bin/node --version >/dev/null 2>&1; then
    ln -sf /opt/nodejs/bin/node /usr/local/bin/node
    ln -sf /opt/nodejs/bin/npm /usr/local/bin/npm
    NODE_OK=1
    echo "Node.js \$(/opt/nodejs/bin/node --version) installed from bundle" >> \$path/start_service.log
fi
if [ \$NODE_OK -eq 0 ] && /usr/bin/node --version >/dev/null 2>&1; then
    ln -sf /usr/bin/node /usr/local/bin/node
    NODE_OK=1
    echo "Node.js \$(/usr/bin/node --version) from system /usr/bin/node" >> \$path/start_service.log
fi
if [ \$NODE_OK -eq 0 ]; then
    echo "Installing Node.js 20 via NodeSource..." >> \$path/start_service.log
    apt-get install -y curl 2>/dev/null
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
    apt-get install -y nodejs 2>/dev/null
    ln -sf /usr/bin/node /usr/local/bin/node 2>/dev/null || true
    echo "Node.js \$(node --version 2>/dev/null) installed via NodeSource" >> \$path/start_service.log
fi
echo "Using: \$(/usr/local/bin/node --version 2>/dev/null || echo 'ERROR: node not found')" >> \$path/start_service.log

# 2. Server bestanden kopiëren naar /root/novabot-server/
mkdir -p /root/novabot-server /root/novabot-dashboard/dist /root/firmware
cp -r "\$SERVER_SRC/dist" /root/novabot-server/
cp "\$SERVER_SRC/package.json" "\$SERVER_SRC/package-lock.json" /root/novabot-server/
cp "\$SERVER_SRC/libmadvise_fix.c" /root/
cp -r "\$DASH_SRC/dist/." /root/novabot-dashboard/dist/
echo "Server files copied to /root/novabot-server/" >> \$path/start_service.log

# 3. node_modules installeren
if [ -d "\$SERVER_SRC/node_modules" ]; then
    echo "Copying bundled node_modules..." >> \$path/start_service.log
    cp -r "\$SERVER_SRC/node_modules" /root/novabot-server/
    echo "node_modules copied from bundle" >> \$path/start_service.log
else
    echo "Installing production node_modules via npm..." >> \$path/start_service.log
    cd /root/novabot-server && NODE_OPTIONS=--jitless npm ci --production 2>&1 | tail -5 >> \$path/start_service.log
fi

# 4. libmadvise_fix.so compileren (ARM64-specifiek, van broncode)
echo "Compiling libmadvise_fix.so..." >> \$path/start_service.log
apt-get install -y gcc 2>/dev/null
if gcc -shared -fPIC -o /root/libmadvise_fix.so /root/libmadvise_fix.c -ldl 2>/dev/null; then
    echo "libmadvise_fix.so compiled OK" >> \$path/start_service.log
else
    echo "WARNING: libmadvise_fix.so compile failed" >> \$path/start_service.log
fi

# 5. .env aanmaken (genereer unieke JWT secret)
JWT=\$(openssl rand -hex 32 2>/dev/null || echo "changeme_\$(date +%s)")
cat > /root/novabot-server/.env << ENVEOF
PORT=${SERVER_PORT}
MQTT_PORT=1883
JWT_SECRET=\${JWT}
DB_PATH=./novabot.db
STORAGE_PATH=./storage
FIRMWARE_PATH=/root/firmware
PROXY_MODE=local
DISABLE_BLE=1
TARGET_IP=127.0.0.1
OTA_BASE_URL=http://127.0.0.1:${SERVER_PORT}
ENVEOF
echo ".env created with unique JWT secret" >> \$path/start_service.log

# 6. systemd service aanmaken
mkdir -p /root/novabot-server/logs
cat > /etc/systemd/system/novabot-server.service << SVCEOF
[Unit]
Description=Novabot Server (local cloud replacement)
After=network-online.target dnsmasq.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/novabot-server
Environment=NODE_OPTIONS=--jitless
Environment=LD_PRELOAD=/root/libmadvise_fix.so
EnvironmentFile=/root/novabot-server/.env
ExecStart=/usr/local/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:/root/novabot-server/logs/server.log
StandardError=append:/root/novabot-server/logs/server.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable novabot-server 2>/dev/null
echo "novabot-server.service enabled" >> \$path/start_service.log

# 7. NetworkManager: voorkom overschrijven resolv.conf
mkdir -p /etc/NetworkManager/conf.d
printf '[main]\ndns=none\n' > /etc/NetworkManager/conf.d/novabot-dns.conf
echo "nameserver 127.0.0.1" > /etc/resolv.conf
chattr +i /etc/resolv.conf 2>/dev/null || true
echo "resolv.conf → 127.0.0.1 (immutable)" >> \$path/start_service.log

# 8. Avahi mDNS — maaier beschikbaar als novabot.local
echo "Setting up avahi-daemon (novabot.local)..." >> \$path/start_service.log
apt-get install -y avahi-daemon libnss-mdns 2>/dev/null
# Stel hostname in zodat avahi adverteert als novabot.local
hostnamectl set-hostname novabot 2>/dev/null || hostname novabot
echo "novabot" > /etc/hostname 2>/dev/null || true
# Avahi configuratie
mkdir -p /etc/avahi
cat > /etc/avahi/avahi-daemon.conf << 'AVAHIEOF'
[server]
host-name=novabot
domain-name=local
use-ipv4=yes
use-ipv6=no
enable-dbus=yes

[publish]
publish-addresses=yes
publish-hinfo=yes
publish-workstation=yes
publish-domain=yes
AVAHIEOF
systemctl enable avahi-daemon 2>/dev/null
systemctl start avahi-daemon 2>/dev/null
echo "avahi-daemon started — maaier beschikbaar als novabot.local" >> \$path/start_service.log

echo "novabot-server installation complete" >> \$path/start_service.log
# ============================================================
SRVEOF

    # Injecteer na het SSH blok (na "Root password configured for SSH" regel)
    # Fallback op "start service finish" als SSH blok niet aanwezig is
    if grep -q "Root password configured for SSH" "$START_SERVICE"; then
        sed -i '' '/Root password configured for SSH/r /tmp/novabot_server_install.sh' "$START_SERVICE"
        echo "  Novabot-server installatie toegevoegd na SSH blok"
    elif grep -q "sudo apt install -y dnsmasq" "$START_SERVICE"; then
        sed -i '' '/sudo apt install -y dnsmasq/r /tmp/novabot_server_install.sh' "$START_SERVICE"
        echo "  Novabot-server installatie toegevoegd na dnsmasq install"
    else
        sed -i '' '/^echo "start service finish"/r /tmp/novabot_server_install.sh' "$START_SERVICE"
        echo "  Novabot-server installatie toegevoegd (fallback positie)"
    fi

    rm -f "$SERVER_INSTALL_BLOCK"
fi

# === Stap 5: HTTP server URL aanpassen ===
echo "[5/8] Server URLs aanpassen..."

# 5a. log_manager.yaml — upload URL
LOG_YAML="$NOVABOT_ROOT/install/log_manager/share/log_manager/config/log_manager.yaml"
if [ -f "$LOG_YAML" ]; then
    sed -i '' "s|url: \"http://app.lfibot.com/api/nova-file-server/log/uploadEquipmentLog\"|url: \"${HTTP_BASE}/api/nova-file-server/log/uploadEquipmentLog\"|" "$LOG_YAML"
    echo "  log_manager.yaml: URL → ${HTTP_BASE}"
fi

# 5b. Voeg script toe dat http_address.txt correct zet bij elke boot
# Dit overrulet de hardcoded app.lfibot.com fallback in mqtt_node
# NB: Firmware prepends "http://" zelf, dus ALLEEN host:port opslaan (geen http:// prefix!)
# NB: Gebruik printf i.p.v. echo om trailing newline te voorkomen (breekt URL in curl)
cat > "$NOVABOT_ROOT/scripts/set_server_urls.sh" << URLSCRIPT
#!/bin/bash
# CUSTOM: Stel lokale server URLs in bij elke boot
# Aangeroepen vanuit run_novabot.sh
#
# Stap 1: Ontdek server via mDNS (opennovabot.local)
# Stap 2: DNS resolve mqtt.lfibot.com (via systeem-DNS / AdGuard)
# Stap 3: Fallback naar last-known IP of hardcoded waarden
# Stap 4: Schrijf naar http_address.txt + json_config.json

FALLBACK_HOST="${SERVER_HOST}"
FALLBACK_HTTP_PORT="${SERVER_HTTP_PORT}"
MQTT_PORT_NUM=${MQTT_PORT}
LAST_KNOWN_FILE="/userdata/lfi/server_ip.txt"
HTTP_ADDR_FILE="/userdata/lfi/http_address.txt"
MQTT_CONFIG_FILE="/userdata/lfi/json_config.json"
LOG_FILE="/userdata/ota/custom_firmware.log"

mkdir -p /userdata/lfi /userdata/ota

log() {
    echo "[\$(date)] set_server_urls: \$1" >> "\$LOG_FILE"
}

# ── Wacht op WiFi (max 30s) ──────────────────────────────────
for i in \$(seq 1 30); do
    if ip addr show wlan0 2>/dev/null | grep -q 'inet '; then
        break
    fi
    sleep 1
done

# ── mDNS discovery (Python, geen externe dependencies) ────────
DISCOVERED_IP=\$(python3 << 'MDNS_EOF'
import socket, struct, time

def mdns_query(timeout=8):
    """Discover opennovabot.local via raw mDNS query."""
    qname = b'\x0eopennovabot\x05local\x00'
    query = struct.pack('!6H', 0, 0, 1, 0, 0, 0) + qname + struct.pack('!2H', 1, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except:
        pass
    sock.settimeout(2)
    sock.bind(('', 5353))
    mreq = struct.pack('4sL', socket.inet_aton('224.0.0.251'), socket.INADDR_ANY)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    end = time.time() + timeout
    while time.time() < end:
        sock.sendto(query, ('224.0.0.251', 5353))
        try:
            while True:
                data, (addr, _) = sock.recvfrom(1024)
                if len(data) < 12:
                    continue
                flags = struct.unpack('!H', data[2:4])[0]
                ancount = struct.unpack('!H', data[6:8])[0]
                if (flags & 0x8000) and ancount > 0 and b'opennovabot' in data:
                    sock.close()
                    print(addr)
                    return
        except socket.timeout:
            pass
    sock.close()

mdns_query()
MDNS_EOF
)

# ── DNS resolution (mqtt.lfibot.com → IP via systeem-DNS / AdGuard) ────
DNS_HOSTNAME="mqtt.lfibot.com"
DNS_IP=\$(python3 -c "
import socket
try:
    ip = socket.gethostbyname('\$DNS_HOSTNAME')
    # Filter localhost/loopback — dat is de maaier zelf
    if not ip.startswith('127.'):
        print(ip)
except:
    pass
" 2>/dev/null)

# ── Bepaal server IP (mDNS → DNS → last-known → hardcoded) ────
if [ -n "\$DISCOVERED_IP" ]; then
    log "Server ontdekt via mDNS: \$DISCOVERED_IP"
    echo "\$DISCOVERED_IP" > "\$LAST_KNOWN_FILE"
    SERVER_IP="\$DISCOVERED_IP"
elif [ -n "\$DNS_IP" ]; then
    log "Server ontdekt via DNS (\$DNS_HOSTNAME): \$DNS_IP"
    echo "\$DNS_IP" > "\$LAST_KNOWN_FILE"
    SERVER_IP="\$DNS_IP"
elif [ -f "\$LAST_KNOWN_FILE" ]; then
    SERVER_IP=\$(cat "\$LAST_KNOWN_FILE")
    log "mDNS+DNS mislukt — gebruik last-known IP: \$SERVER_IP"
elif [ -n "\$FALLBACK_HOST" ]; then
    SERVER_IP="\$FALLBACK_HOST"
    log "mDNS+DNS mislukt, geen last-known — gebruik fallback: \$SERVER_IP"
else
    SERVER_IP=""
    log "WARN: geen server gevonden — configuratie niet bijgewerkt"
fi

if [ -n "\$SERVER_IP" ]; then
    HTTP_ADDRESS="\${SERVER_IP}\$([ -n "\$FALLBACK_HTTP_PORT" ] && echo ":\$FALLBACK_HTTP_PORT")"
    MQTT_ADDRESS="\$SERVER_IP"
else
    HTTP_ADDRESS=""
    MQTT_ADDRESS=""
fi

# 1. HTTP server adres (firmware prepends "http://", dus ALLEEN host:port, GEEN prefix!)
if [ -n "\${HTTP_ADDRESS}" ]; then
    printf "%s" "\${HTTP_ADDRESS}" > "\${HTTP_ADDR_FILE}"
fi

# 2. Ethernet altijd beschikbaar voor noodherstel (RDK X3 default: 192.168.1.10)
ip addr add 192.168.1.10/24 dev eth0 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true

# 3. MQTT broker adres — update ALLEEN mqtt velden in json_config.json
# (behoud alle BLE-provisioned data: wifi, lora, sn, config/tz)
# SKIP als geen server gevonden (bewaar bestaande config)
if [ -z "\${MQTT_ADDRESS}" ]; then
    log "SKIP json_config.json update — geen server IP beschikbaar"
else
#
# VEILIGHEID (meerdere lagen):
#   - Factory backup (.factory) — eenmalig, wordt NOOIT overschreven
#   - Rolling backup (.bak) — bijgewerkt bij elke succesvolle wijziging
#   - Atomic write — schrijf naar .tmp, valideer, dan mv (nooit direct)
#   - Post-write validatie — als resultaat secties mist, ABORT en herstel
#   - Herstelvolgorde: .bak → .factory → niets wijzigen
python3 << PYEOF
import json, os, shutil, sys, tempfile

mqtt_addr = "\${MQTT_ADDRESS}"
mqtt_port = \${MQTT_PORT_NUM}
cfg_file = "\${MQTT_CONFIG_FILE}"
backup = cfg_file + ".bak"
factory = cfg_file + ".factory"
tmp_file = cfg_file + ".tmp"
log_file = "/userdata/ota/custom_firmware.log"

os.makedirs("/userdata/ota", exist_ok=True)

def log_msg(msg):
    import datetime
    with open(log_file, "a") as f:
        f.write(f"[{datetime.datetime.now()}] set_server_urls: {msg}\n")

def load_json(path):
    """Laad JSON, geeft (dict, True) of ({}, False)."""
    if not os.path.exists(path):
        return {}, False
    try:
        with open(path) as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data, True
    except Exception as e:
        log_msg(f"WARN: {path} onleesbaar ({e})")
    return {}, False

def count_critical(d):
    """Tel aanwezige kritieke secties (sn, wifi, lora)."""
    return sum(1 for k in ("sn", "wifi", "lora") if k in d)

# === Stap 1: Laad huidige config (met fallback cascade) ===
c, loaded = load_json(cfg_file)
source = "main"

if not loaded:
    c, loaded = load_json(backup)
    source = "backup"
if not loaded:
    c, loaded = load_json(factory)
    source = "factory"
if not loaded:
    log_msg("WARN: geen leesbare config gevonden — alleen mqtt wordt gezet")
    c = {}
    source = "empty"
else:
    log_msg(f"Config geladen uit {source} (secties: {list(c.keys())})")

# Bewaar snapshot van origineel VOOR wijziging (voor validatie achteraf)
original_keys = set(c.keys())
original_critical = count_critical(c)

# === Stap 2: Factory backup (eenmalig, NOOIT overschrijven) ===
if not os.path.exists(factory) and original_critical >= 2:
    try:
        shutil.copy2(cfg_file if os.path.exists(cfg_file) else backup, factory)
        log_msg(f"Factory backup aangemaakt ({original_critical} kritieke secties)")
    except Exception as e:
        log_msg(f"WARN: factory backup mislukt ({e})")

# === Stap 3: Rolling backup (alleen als main OK is) ===
if source == "main" and original_critical >= 2:
    try:
        shutil.copy2(cfg_file, backup)
    except:
        pass

# === Stap 4: Update ALLEEN mqtt + config/tz (nooit andere secties aanraken) ===
# BELANGRIJK: als json_config.json al een custom MQTT adres bevat (niet mqtt.lfibot.com
# of mqtt-dev.lfibot.com), dan is dat gezet via BLE/MQTT provisioning → NIET overschrijven.
# Dit maakt de firmware generiek bruikbaar: ESP32 OTA tool flasht, provisioneert MQTT adres
# via MQTT (stap 8), en set_server_urls.sh respecteert dat bij elke boot daarna.
if "mqtt" not in c:
    c["mqtt"] = {"set": 1, "value": {}}
elif not isinstance(c.get("mqtt", {}).get("value"), dict):
    c["mqtt"]["value"] = {}

existing_addr = c.get("mqtt", {}).get("value", {}).get("addr", "")
is_stock_addr = existing_addr in ("", "mqtt.lfibot.com", "mqtt-dev.lfibot.com", "app.lfibot.com")
if is_stock_addr:
    c["mqtt"]["value"]["addr"] = mqtt_addr
    c["mqtt"]["value"]["port"] = mqtt_port
    log_msg(f"MQTT addr updated: {existing_addr} -> {mqtt_addr}")
else:
    log_msg(f"MQTT addr KEPT (custom): {existing_addr} (niet overschreven door {mqtt_addr})")
    # Alleen port updaten als die verschilt
    if c["mqtt"]["value"].get("port") != mqtt_port:
        c["mqtt"]["value"]["port"] = mqtt_port

if "config" not in c:
    c["config"] = {"set": 1, "value": {"tz": "Europe/Amsterdam"}}
elif c.get("config", {}).get("value") is None:
    c["config"]["value"] = {"tz": "Europe/Amsterdam"}
elif isinstance(c["config"].get("value"), dict) and "tz" not in c["config"]["value"]:
    c["config"]["value"]["tz"] = "Europe/Amsterdam"

# === Stap 5: Herstel verdwenen kritieke secties uit backup/factory ===
for fallback_path in (backup, factory):
    fb, fb_ok = load_json(fallback_path)
    if not fb_ok:
        continue
    for key in ("sn", "wifi", "lora"):
        if key in fb and key not in c:
            c[key] = fb[key]
            log_msg(f"WARN: {key} hersteld uit {fallback_path}")

# === Stap 6: POST-WRITE VALIDATIE — als resultaat MINDER secties heeft, ABORT ===
new_critical = count_critical(c)
if original_critical > 0 and new_critical < original_critical:
    log_msg(f"ABORT: resultaat heeft minder secties ({new_critical}) dan origineel ({original_critical}) — NIET schrijven!")
    # Herstel origineel uit backup
    for fb_path in (backup, factory):
        if os.path.exists(fb_path):
            try:
                shutil.copy2(fb_path, cfg_file)
                log_msg(f"Origineel hersteld uit {fb_path}")
                break
            except:
                pass
    sys.exit(0)

# === Stap 7: ATOMIC WRITE — schrijf naar .tmp, valideer, dan rename ===
try:
    with open(tmp_file, "w") as fh:
        json.dump(c, fh)
    # Valideer wat we net geschreven hebben
    verify, verify_ok = load_json(tmp_file)
    if not verify_ok:
        log_msg("ABORT: .tmp verificatie mislukt — NIET overnemen!")
        os.remove(tmp_file)
        sys.exit(0)
    # Controleer dat alle originele secties bewaard zijn
    for key in original_keys:
        if key not in verify:
            log_msg(f"ABORT: sectie '{key}' verdwenen na schrijven — NIET overnemen!")
            os.remove(tmp_file)
            sys.exit(0)
    # Alles OK — atomic rename
    os.replace(tmp_file, cfg_file)
except Exception as e:
    log_msg(f"ERROR: schrijven mislukt ({e}) — origineel ongewijzigd")
    if os.path.exists(tmp_file):
        os.remove(tmp_file)
    sys.exit(0)

sections = list(c.keys())
has_sn = "sn" in c and isinstance(c.get("sn", {}).get("value", {}).get("code"), str)
has_wifi = "wifi" in c
log_msg(f"OK — secties: {sections}, SN: {has_sn}, WiFi: {has_wifi}")
PYEOF

fi  # end of: if [ -z "\${MQTT_ADDRESS}" ] ... else

echo "[\$(date)] HTTP → \${HTTP_ADDRESS}, MQTT → \${MQTT_ADDRESS}:\${MQTT_PORT_NUM}" >> /userdata/ota/custom_firmware.log
URLSCRIPT
chmod +x "$NOVABOT_ROOT/scripts/set_server_urls.sh"
echo "  set_server_urls.sh aangemaakt"

# Voeg dnsmasq config toe aan set_server_urls.sh (alleen als --include-server)
if [ "$INCLUDE_SERVER" = "true" ]; then
    cat >> "$NOVABOT_ROOT/scripts/set_server_urls.sh" << 'DNSSCRIPT'

# 3. dnsmasq DNS redirect bijwerken met actueel wlan0 IP
# (maaier hoeft zelf localhost te gebruiken, maar andere apparaten op het netwerk
#  vinden de maaier via DNS als app.lfibot.com / mqtt.lfibot.com)
MY_IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
if [ -z "$MY_IP" ]; then
    # Fallback: probeer eth0
    MY_IP=$(ip addr show eth0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
fi
if [ -n "$MY_IP" ]; then
    mkdir -p /etc/dnsmasq.d
    cat > /etc/dnsmasq.d/novabot.conf << DNSEOF
address=/app.lfibot.com/$MY_IP
address=/mqtt.lfibot.com/$MY_IP
address=/nova-dash.example.com/$MY_IP
address=/nova-mqtt.example.com/$MY_IP
address=/novabot.local/$MY_IP
server=8.8.8.8
server=192.168.0.1
interface=wlan0
interface=lo
listen-address=127.0.0.1
listen-address=$MY_IP
domain-needed
bogus-priv
DNSEOF
    systemctl restart dnsmasq 2>/dev/null || true
fi
DNSSCRIPT
    echo "  set_server_urls.sh: dnsmasq config sectie toegevoegd"
fi

# 5c. Voeg set_server_urls.sh + pre-boot validatie toe aan run_novabot.sh
RUN_NOVABOT="$NOVABOT_ROOT/scripts/run_novabot.sh"

# 5c-1. Maak pre-boot validatie script
cat > "$NOVABOT_ROOT/scripts/validate_config.sh" << 'VALSCRIPT'
#!/bin/bash
# CUSTOM: Pre-boot validatie van json_config.json
# Aangeroepen vanuit run_novabot.sh, VOOR mqtt_node start
# Als kritieke secties (sn, wifi) ontbreken → herstel uit backup/factory
# Voorkomt dat mqtt_node start zonder geldige config (→ geen WiFi, geen BLE)

CFG="/userdata/lfi/json_config.json"
BAK="${CFG}.bak"
FACTORY="${CFG}.factory"
LOG="/userdata/ota/custom_firmware.log"

log_msg() {
    echo "[$(date)] validate_config: $1" >> "$LOG"
}

# Controleer of json_config.json geldig JSON is met sn + wifi secties
validate() {
    local file="$1"
    [ -f "$file" ] || return 1
    python3 -c "
import json, sys
try:
    with open('$file') as f:
        c = json.load(f)
    # Minimale vereisten: moet een dict zijn met sn sectie
    if not isinstance(c, dict):
        sys.exit(1)
    if 'sn' not in c:
        sys.exit(2)
    # WiFi is wenselijk maar niet fataal (kan via BLE hersteld worden)
    sys.exit(0)
except:
    sys.exit(1)
" 2>/dev/null
    return $?
}

mkdir -p /userdata/ota

# Stap 1: Check huidige config
if validate "$CFG"; then
    log_msg "OK: json_config.json valide"
    exit 0
fi

log_msg "WARN: json_config.json ongeldig of mist sn sectie"

# Stap 2: Probeer .bak
if validate "$BAK"; then
    log_msg "HERSTEL: .bak is geldig — kopiëren naar json_config.json"
    cp "$BAK" "$CFG"
    exit 0
fi

# Stap 3: Probeer .factory
if validate "$FACTORY"; then
    log_msg "HERSTEL: .factory is geldig — kopiëren naar json_config.json"
    cp "$FACTORY" "$CFG"
    exit 0
fi

log_msg "ERROR: geen geldige config gevonden (.json, .bak, .factory) — mqtt_node start mogelijk zonder SN!"
exit 1
VALSCRIPT
chmod +x "$NOVABOT_ROOT/scripts/validate_config.sh"
echo "  validate_config.sh aangemaakt"

# 5c-2. Voeg beide hooks toe aan run_novabot.sh
if [ -f "$RUN_NOVABOT" ]; then
    if ! grep -q "set_server_urls.sh" "$RUN_NOVABOT"; then
        sed -i '' '/^case "\$1" in/i\
# CUSTOM: Valideer json_config.json VOOR mqtt_node start\
if [ -f "/root/novabot/scripts/validate_config.sh" ]; then\
    bash /root/novabot/scripts/validate_config.sh\
fi\
\
# CUSTOM: Stel lokale server URLs in bij elke boot\
if [ -f "/root/novabot/scripts/set_server_urls.sh" ]; then\
    bash /root/novabot/scripts/set_server_urls.sh\
fi\
' "$RUN_NOVABOT"
        echo "  run_novabot.sh: validate_config.sh + set_server_urls.sh hooks toegevoegd"
    fi
fi

# 5c-3. daemon_node toevoegen aan run_novabot.sh
# KRITIEK: In firmware v6.0.2 is novabot_api uitgecommentarieerd in novabot_system.launch.py.
# mqtt_node wordt normaal gestart door daemon_node (watchdog), maar die ontbreekt in
# run_novabot.sh (wel aanwezig in run_novabot_backup.sh lijn 100).
# Zonder deze fix start mqtt_node NIET → geen MQTT communicatie → maaier is dood.
if [ -f "$RUN_NOVABOT" ] && ! grep -q "daemon_process daemon_node" "$RUN_NOVABOT"; then
    # Start blok: injecteer na start_test.sh (zelfde anker als camera/LED)
    DAEMON_START_BLOCK="/tmp/daemon_node_start_block.sh"
    cat > "$DAEMON_START_BLOCK" << 'DNEOF'

  # CUSTOM: Start daemon_node (watchdog that spawns and monitors mqtt_node)
  # novabot_system.launch.py has novabot_api commented out in v6.0.2,
  # so daemon_node is required to start mqtt_node.
  ros2 run daemon_process daemon_node &
DNEOF
    sed -i '' '/start_test.sh/r /tmp/daemon_node_start_block.sh' "$RUN_NOVABOT"
    rm -f "$DAEMON_START_BLOCK"

    # Stop blok: voeg kills toe na daemon_monitor.sh kill
    DAEMON_STOP_BLOCK="/tmp/daemon_node_stop_block.sh"
    cat > "$DAEMON_STOP_BLOCK" << 'DNEOF'
  killall -q -9 daemon_node
  killall -q -9 mqtt_node
DNEOF
    sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/daemon_node_stop_block.sh' "$RUN_NOVABOT"
    rm -f "$DAEMON_STOP_BLOCK"

    echo "  run_novabot.sh: daemon_node start + stop toegevoegd (mqtt_node fix)"
else
    echo "  run_novabot.sh: daemon_node al aanwezig — overslaan"
fi

# === Stap 5d: Camera stream service toevoegen ===
echo "[5d/9] Camera stream service toevoegen..."

CAMERA_SRC="$SCRIPT_DIR/camera_stream.py"
if [ -f "$CAMERA_SRC" ]; then
    cp "$CAMERA_SRC" "$NOVABOT_ROOT/scripts/camera_stream.py"
    chmod +x "$NOVABOT_ROOT/scripts/camera_stream.py"
    echo "  camera_stream.py gekopieerd naar scripts/"

    # Voeg camera stream launch toe aan run_novabot.sh start) blok
    if [ -f "$RUN_NOVABOT" ] && ! grep -q "camera_stream.py" "$RUN_NOVABOT"; then
        # Schrijf injectie blok naar temp bestand (voorkomt sed escaping problemen)
        CAMERA_START_BLOCK="/tmp/camera_start_block.sh"
        cat > "$CAMERA_START_BLOCK" << 'CAMEOF'

  # CUSTOM: Camera MJPEG stream starten (wacht 15s op camera node)
  # Respawn wrapper: herstart automatisch bij crash (max 5s pauze)
  if [ -f "/root/novabot/scripts/camera_stream.py" ]; then
      (sleep 15 && while true; do
          echo "[$(date)] camera_stream.py starten..." >> $LOGS_PATH/camera_stream.log
          python3 /root/novabot/scripts/camera_stream.py >> $LOGS_PATH/camera_stream.log 2>&1
          echo "[$(date)] camera_stream.py gestopt (exit $?), herstart in 5s..." >> $LOGS_PATH/camera_stream.log
          sleep 5
      done) &
      echo "Camera stream scheduled (15s delay, auto-respawn)" >> $LOGS_PATH/camera_stream.log
  fi
CAMEOF
        # Injecteer na de factory_test/start_test.sh regel
        sed -i '' '/start_test.sh/r /tmp/camera_start_block.sh' "$RUN_NOVABOT"
        rm -f "$CAMERA_START_BLOCK"
        echo "  run_novabot.sh: camera stream launch toegevoegd aan start)"

        # Voeg camera stream kill toe aan stop) blok
        CAMERA_STOP_BLOCK="/tmp/camera_stop_block.sh"
        cat > "$CAMERA_STOP_BLOCK" << 'CAMEOF'
  killall -q -9 camera_stream.py
CAMEOF
        sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/camera_stop_block.sh' "$RUN_NOVABOT"
        rm -f "$CAMERA_STOP_BLOCK"
        echo "  run_novabot.sh: camera stream kill toegevoegd aan stop)"
    fi
else
    echo "  camera_stream.py niet gevonden — overslaan"
fi

# === Stap 5e: LED bridge service toevoegen ===
echo "[5e/9] LED bridge service toevoegen..."

LED_SRC="$SCRIPT_DIR/led_bridge.py"
if [ -f "$LED_SRC" ]; then
    cp "$LED_SRC" "$NOVABOT_ROOT/scripts/led_bridge.py"
    chmod +x "$NOVABOT_ROOT/scripts/led_bridge.py"
    echo "  led_bridge.py gekopieerd naar scripts/"

    # Voeg LED bridge launch toe aan run_novabot.sh start) blok
    if [ -f "$RUN_NOVABOT" ] && ! grep -q "led_bridge.py" "$RUN_NOVABOT"; then
        LED_START_BLOCK="/tmp/led_start_block.sh"
        cat > "$LED_START_BLOCK" << 'LEDEOF'

  # CUSTOM: LED bridge starten (MQTT → ROS /led_set, wacht 10s op ROS)
  if [ -f "/root/novabot/scripts/led_bridge.py" ]; then
      (sleep 10 && python3 /root/novabot/scripts/led_bridge.py >> $LOGS_PATH/led_bridge.log 2>&1) &
      echo "LED bridge scheduled (10s delay)" >> $LOGS_PATH/led_bridge.log
  fi
LEDEOF
        sed -i '' '/start_test.sh/r /tmp/led_start_block.sh' "$RUN_NOVABOT"
        rm -f "$LED_START_BLOCK"
        echo "  run_novabot.sh: LED bridge launch toegevoegd aan start)"

        # Voeg LED bridge kill toe aan stop) blok
        LED_STOP_BLOCK="/tmp/led_stop_block.sh"
        cat > "$LED_STOP_BLOCK" << 'LEDEOF'
  killall -q -9 led_bridge.py
LEDEOF
        sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/led_stop_block.sh' "$RUN_NOVABOT"
        rm -f "$LED_STOP_BLOCK"
        echo "  run_novabot.sh: LED bridge kill toegevoegd aan stop)"
    fi
else
    echo "  led_bridge.py niet gevonden — overslaan"
fi

# === Stap 5f: WiFi AP fallback script toevoegen ===
echo "[5f/9] WiFi AP fallback script toevoegen..."

# Dit script start een WiFi hotspot als de maaier na 90 seconden geen WiFi STA heeft.
# Hierdoor kun je altijd via WiFi bij de maaier komen, ook als json_config.json corrupt is.
cat > "$NOVABOT_ROOT/scripts/wifi_ap_fallback.sh" << 'APEOF'
#!/bin/bash
# WiFi AP fallback — start hotspot als STA niet verbindt
# SSID: OpenNova, Wachtwoord: novabot123, IP: 192.168.4.1

TIMEOUT=90
AP_SSID="OpenNova"
AP_PASS="novabot123"
LOG="/userdata/ota/wifi_ap_fallback.log"

echo "[$(date)] WiFi AP fallback monitor gestart (timeout: ${TIMEOUT}s)" >> "$LOG"

# Wacht in stappen van 10 seconden op STA verbinding
for i in $(seq 1 $((TIMEOUT / 10))); do
    sleep 10
    WLAN_IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$WLAN_IP" ]; then
        echo "[$(date)] WiFi STA verbonden: $WLAN_IP — geen AP nodig" >> "$LOG"
        exit 0
    fi
done

echo "[$(date)] Geen WiFi STA na ${TIMEOUT}s — AP starten: SSID=$AP_SSID" >> "$LOG"

# Stop eventuele WiFi STA pogingen
killall wpa_supplicant 2>/dev/null

# Configureer wlan0 als AP
ip link set wlan0 down 2>/dev/null
ip addr flush dev wlan0 2>/dev/null
ip addr add 192.168.4.1/24 dev wlan0
ip link set wlan0 up

# Start hostapd
cat > /tmp/hostapd_fallback.conf << HAPEOF
interface=wlan0
driver=nl80211
ssid=$AP_SSID
hw_mode=g
channel=7
wmm_enabled=0
wpa=2
wpa_passphrase=$AP_PASS
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
HAPEOF

if command -v hostapd &>/dev/null; then
    hostapd -B /tmp/hostapd_fallback.conf >> "$LOG" 2>&1
    echo "[$(date)] hostapd gestart" >> "$LOG"

    # DHCP op het AP netwerk (dnsmasq is al geïnstalleerd in --include-server builds)
    if command -v dnsmasq &>/dev/null; then
        dnsmasq --interface=wlan0 --bind-interfaces --except-interface=lo \
            --dhcp-range=192.168.4.10,192.168.4.50,255.255.255.0,12h \
            --no-hosts --log-facility="$LOG" &
        echo "[$(date)] DHCP actief op 192.168.4.x" >> "$LOG"
    fi

    echo "[$(date)] === AP ACTIEF: SSID=$AP_SSID PSK=$AP_PASS IP=192.168.4.1 ===" >> "$LOG"
else
    echo "[$(date)] FOUT: hostapd niet gevonden — installeer met: apt-get install hostapd" >> "$LOG"
fi
APEOF
chmod +x "$NOVABOT_ROOT/scripts/wifi_ap_fallback.sh"
echo "  wifi_ap_fallback.sh aangemaakt"

# WiFi watchdog — continu monitoring na de initiële AP fallback check
# Als WiFi wegvalt EN json_config.json corrupt is → herstel + herstart netwerk
cat > "$NOVABOT_ROOT/scripts/wifi_watchdog.sh" << 'WDEOF'
#!/bin/bash
# WiFi watchdog — continu monitoring van WiFi connectiviteit
# Als WiFi >2 minuten weg is:
#   1. Check of json_config.json wifi sectie heeft
#   2. Zo niet → herstel uit backup/factory
#   3. Herstart wpa_supplicant
#   4. Als WiFi na herstel nog steeds weg → start AP fallback
#
# Dit script draait permanent op de achtergrond.

LOG="/userdata/ota/wifi_watchdog.log"
CFG="/userdata/lfi/json_config.json"
BAK="${CFG}.bak"
FACTORY="${CFG}.factory"
CHECK_INTERVAL=30  # Controleer elke 30 seconden
FAIL_THRESHOLD=4   # 4 × 30s = 2 minuten

echo "[$(date)] WiFi watchdog gestart" >> "$LOG"

fail_count=0

while true; do
    sleep $CHECK_INTERVAL

    # Check WiFi STA connectiviteit
    WLAN_IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)

    if [ -n "$WLAN_IP" ]; then
        # WiFi OK
        if [ $fail_count -gt 0 ]; then
            echo "[$(date)] WiFi hersteld: $WLAN_IP (na ${fail_count} checks)" >> "$LOG"
        fi
        fail_count=0
        continue
    fi

    fail_count=$((fail_count + 1))

    if [ $fail_count -lt $FAIL_THRESHOLD ]; then
        continue
    fi

    # WiFi is >2 minuten weg
    if [ $fail_count -eq $FAIL_THRESHOLD ]; then
        echo "[$(date)] WiFi >2 min weg — config controleren" >> "$LOG"

        # Check of json_config.json een wifi sectie heeft
        HAS_WIFI=$(python3 -c "
import json
try:
    with open('$CFG') as f:
        c = json.load(f)
    print('yes' if 'wifi' in c else 'no')
except:
    print('error')
" 2>/dev/null)

        if [ "$HAS_WIFI" = "no" ] || [ "$HAS_WIFI" = "error" ]; then
            echo "[$(date)] json_config.json mist wifi sectie (status: $HAS_WIFI) — herstel starten" >> "$LOG"

            # Probeer backup/factory
            RESTORED=false
            for SRC in "$BAK" "$FACTORY"; do
                if [ -f "$SRC" ]; then
                    SRC_WIFI=$(python3 -c "
import json
try:
    with open('$SRC') as f:
        c = json.load(f)
    print('yes' if 'wifi' in c else 'no')
except:
    print('error')
" 2>/dev/null)
                    if [ "$SRC_WIFI" = "yes" ]; then
                        cp "$SRC" "$CFG"
                        echo "[$(date)] Config hersteld uit $SRC" >> "$LOG"
                        RESTORED=true
                        break
                    fi
                fi
            done

            if [ "$RESTORED" = "true" ]; then
                # Herstart netwerk (wpa_supplicant leest wifi config via mqtt_node)
                echo "[$(date)] Netwerk herstart geprobeerd" >> "$LOG"
                # mqtt_node herstarting is de beste manier — het leest json_config.json opnieuw
                killall mqtt_node 2>/dev/null
                # daemon_node zal mqtt_node automatisch herstarten
                sleep 30
                # Check of WiFi nu werkt
                WLAN_IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
                if [ -n "$WLAN_IP" ]; then
                    echo "[$(date)] WiFi hersteld na config restore: $WLAN_IP" >> "$LOG"
                    fail_count=0
                    continue
                fi
            fi

            echo "[$(date)] WiFi niet hersteld — AP fallback starten" >> "$LOG"
            if [ -f "/root/novabot/scripts/wifi_ap_fallback.sh" ] && ! pgrep -f hostapd >/dev/null; then
                bash /root/novabot/scripts/wifi_ap_fallback.sh &
            fi
        else
            echo "[$(date)] WiFi weg maar config heeft wifi sectie — netwerk probleem (niet config)" >> "$LOG"
            # Na 5 minuten zonder WiFi toch AP starten als vangnet
            if [ $fail_count -ge 10 ] && ! pgrep -f hostapd >/dev/null; then
                echo "[$(date)] WiFi >5 min weg — AP fallback als vangnet" >> "$LOG"
                if [ -f "/root/novabot/scripts/wifi_ap_fallback.sh" ]; then
                    bash /root/novabot/scripts/wifi_ap_fallback.sh &
                fi
            fi
        fi
    fi
done
WDEOF
chmod +x "$NOVABOT_ROOT/scripts/wifi_watchdog.sh"
echo "  wifi_watchdog.sh aangemaakt"

# Voeg WiFi AP fallback + watchdog toe aan run_novabot.sh start) blok
if [ -f "$RUN_NOVABOT" ] && ! grep -q "wifi_ap_fallback.sh" "$RUN_NOVABOT"; then
    AP_START_BLOCK="/tmp/ap_start_block.sh"
    cat > "$AP_START_BLOCK" << 'APSTARTEOF'

  # CUSTOM: WiFi AP fallback — start hotspot als STA niet verbindt na 90s
  if [ -f "/root/novabot/scripts/wifi_ap_fallback.sh" ]; then
      bash /root/novabot/scripts/wifi_ap_fallback.sh &
      echo "WiFi AP fallback monitor gestart" >> $LOGS_PATH/wifi_ap_fallback.log
  fi

  # CUSTOM: WiFi watchdog — continu monitoring, herstelt config bij problemen
  if [ -f "/root/novabot/scripts/wifi_watchdog.sh" ]; then
      bash /root/novabot/scripts/wifi_watchdog.sh &
      echo "WiFi watchdog gestart" >> $LOGS_PATH/wifi_watchdog.log
  fi
APSTARTEOF
    sed -i '' '/start_test.sh/r /tmp/ap_start_block.sh' "$RUN_NOVABOT"
    rm -f "$AP_START_BLOCK"
    echo "  run_novabot.sh: WiFi AP fallback + watchdog toegevoegd aan start)"

    # Kill AP fallback + watchdog bij stop
    AP_STOP_BLOCK="/tmp/ap_stop_block.sh"
    cat > "$AP_STOP_BLOCK" << 'APSTOPEOF'
  killall -q -9 wifi_ap_fallback.sh wifi_watchdog.sh hostapd
APSTOPEOF
    sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/ap_stop_block.sh' "$RUN_NOVABOT"
    rm -f "$AP_STOP_BLOCK"
    echo "  run_novabot.sh: WiFi AP fallback + watchdog kill toegevoegd aan stop)"
fi

# === Stap 5h: Extended commands service toevoegen ===
echo "[5h/9] Extended commands service toevoegen..."

EXT_SRC="$SCRIPT_DIR/extended_commands.py"
if [ -f "$EXT_SRC" ]; then
    cp "$EXT_SRC" "$NOVABOT_ROOT/scripts/extended_commands.py"
    chmod +x "$NOVABOT_ROOT/scripts/extended_commands.py"
    echo "  extended_commands.py gekopieerd naar scripts/"

    # pin_verify_ros2.py — ROS2 action client voor PIN verify (aangeroepen door extended_commands.py)
    PIN_VERIFY_SRC="$SCRIPT_DIR/pin_verify_ros2.py"
    if [ -f "$PIN_VERIFY_SRC" ]; then
        cp "$PIN_VERIFY_SRC" "$NOVABOT_ROOT/scripts/pin_verify_ros2.py"
        chmod +x "$NOVABOT_ROOT/scripts/pin_verify_ros2.py"
        echo "  pin_verify_ros2.py gekopieerd naar scripts/ (on-demand helper, geen daemon)"
    fi

    # Voeg extended commands launch toe aan run_novabot.sh start) blok
    if [ -f "$RUN_NOVABOT" ] && ! grep -q "extended_commands.py" "$RUN_NOVABOT"; then
        EXT_START_BLOCK="/tmp/ext_cmd_start_block.sh"
        cat > "$EXT_START_BLOCK" << 'EXTEOF'

  # CUSTOM: Extended commands starten (reboot, camera snapshot, system info)
  # Luistert op novabot/extended/<SN> — apart van mqtt_node (onversleuteld)
  if [ -f "/root/novabot/scripts/extended_commands.py" ]; then
      (sleep 12 && python3 /root/novabot/scripts/extended_commands.py >> $LOGS_PATH/extended_commands.log 2>&1) &
      echo "Extended commands scheduled (12s delay)" >> $LOGS_PATH/extended_commands.log
  fi
EXTEOF
        sed -i '' '/start_test.sh/r /tmp/ext_cmd_start_block.sh' "$RUN_NOVABOT"
        rm -f "$EXT_START_BLOCK"
        echo "  run_novabot.sh: extended commands launch toegevoegd aan start)"

        # Voeg extended commands kill toe aan stop) blok
        EXT_STOP_BLOCK="/tmp/ext_cmd_stop_block.sh"
        cat > "$EXT_STOP_BLOCK" << 'EXTEOF'
  killall -q -9 extended_commands.py
EXTEOF
        sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/ext_cmd_stop_block.sh' "$RUN_NOVABOT"
        rm -f "$EXT_STOP_BLOCK"
        echo "  run_novabot.sh: extended commands kill toegevoegd aan stop)"
    fi
else
    echo "  extended_commands.py niet gevonden — overslaan"
fi

# === Stap 5i: STM32 MCU firmware — KEEP STOCK v3.6.0 ===
# DISABLED: v3.6.7 pin_unlock causes motor lock issues (blade calibration broken).
# The stock v3.6.0 from the source .deb is kept as-is.
# PIN unlock can be done via extended_commands.py verify_pin command instead.
echo "[5i/9] STM32 MCU: keeping stock v3.6.0 (pin_unlock patch DISABLED)"

# === Stap 5j: Open robot_decision boot hook toevoegen ===
echo "[5j/9] Open robot_decision boot hook toevoegen..."

# Voeg de boot hook toe aan run_novabot.sh
# Dit blok vervangt de C++ robot_decision binary door onze Python implementatie.
# De bestanden moeten in /userdata/open_decision/ staan (deployed via deploy.sh).
# /userdata/ overleeft firmware updates, dus eenmaal deployed blijft het werken.
if [ -f "$RUN_NOVABOT" ] && ! grep -q "open_decision" "$RUN_NOVABOT"; then
    OPEN_DECISION_BLOCK="/tmp/open_decision_start_block.sh"
    cat > "$OPEN_DECISION_BLOCK" << 'ODEOF'

  # CUSTOM: Open robot_decision (vervangt closed-source C++ binary)
  # Bestanden in /userdata/open_decision/ overleven firmware updates.
  # Rollback: rm -rf /userdata/open_decision && reboot
  if [ -d "/userdata/open_decision" ] && [ -f "/userdata/open_decision/robot_decision.py" ]; then
      (sleep 20 && killall -q -9 robot_decision && sleep 2 && \
       source /opt/ros/galactic/setup.bash && \
       source /root/novabot/install/setup.bash && \
       export PYTHONPATH=$PYTHONPATH:/userdata/open_decision && \
       export ROS_LOG_DIR=/root/novabot/data/ros2_log && \
       export ROS_LOCALHOST_ONLY=1 && \
       python3 /userdata/open_decision/robot_decision.py \
       --ros-args --params-file /root/novabot/install/compound_decision/share/compound_decision/config/robot_decision.yaml \
       >> /userdata/open_decision/decision.log 2>&1) &
      echo "Open robot_decision scheduled (20s delay)" >> $LOGS_PATH/open_decision.log
  fi
ODEOF
    sed -i '' '/start_test.sh/r /tmp/open_decision_start_block.sh' "$RUN_NOVABOT"
    rm -f "$OPEN_DECISION_BLOCK"
    echo "  run_novabot.sh: open_decision boot hook toegevoegd aan start)"

    # Voeg Python process kill toe aan stop) blok
    OPEN_DECISION_STOP="/tmp/open_decision_stop_block.sh"
    cat > "$OPEN_DECISION_STOP" << 'ODEOF'
  pkill -9 -f "python3.*robot_decision" 2>/dev/null
ODEOF
    sed -i '' '/killall -q -9 robot_decision/r /tmp/open_decision_stop_block.sh' "$RUN_NOVABOT"
    rm -f "$OPEN_DECISION_STOP"
    echo "  run_novabot.sh: Python robot_decision kill toegevoegd aan stop)"
else
    echo "  run_novabot.sh: open_decision hook al aanwezig — overslaan"
fi

# === Stap 5k: Open mqtt_node (mqtt_bridge.py) bundelen ===
echo "[5k/9] Open mqtt_node bundelen..."

MQTT_BRIDGE_SRC="$SCRIPT_DIR/../open_node/mqtt_bridge.py"
if [ -f "$MQTT_BRIDGE_SRC" ]; then
    mkdir -p "$NOVABOT_ROOT/scripts"
    cp "$MQTT_BRIDGE_SRC" "$NOVABOT_ROOT/scripts/mqtt_bridge.py"
    chmod +x "$NOVABOT_ROOT/scripts/mqtt_bridge.py"
    echo "  mqtt_bridge.py gekopieerd naar scripts/"

    # Vervang daemon_node (stock mqtt_node watchdog) door onze mqtt_bridge.py
    # daemon_node start de stock mqtt_node — wij willen die NIET
    if [ -f "$RUN_NOVABOT" ] && ! grep -q "mqtt_bridge.py" "$RUN_NOVABOT"; then
        # Verwijder daemon_node start als die al toegevoegd was door stap 5c-3
        # (sed verwijdert de hele daemon_node + mqtt_node blokken)
        if grep -q "daemon_process daemon_node" "$RUN_NOVABOT"; then
            sed -i '' '/daemon_process daemon_node/d' "$RUN_NOVABOT"
            echo "  daemon_node start verwijderd uit run_novabot.sh"
        fi

        MQTT_BRIDGE_START="/tmp/mqtt_bridge_start_block.sh"
        cat > "$MQTT_BRIDGE_START" << 'MBEOF'

  # CUSTOM: Open mqtt_node (vervangt stock mqtt_node binary via daemon_node)
  # mqtt_bridge.py = open source MQTT<->ROS2 bridge — geen domain whitelist!
  # Bestanden in /userdata/open_node/ overleven firmware updates (als apart gedeployed).
  # Fallback: als /userdata/open_node/mqtt_bridge.py bestaat, gebruik die (override).
  MQTT_BRIDGE="/root/novabot/scripts/mqtt_bridge.py"
  [ -f "/userdata/open_node/mqtt_bridge.py" ] && MQTT_BRIDGE="/userdata/open_node/mqtt_bridge.py"
  if [ -f "$MQTT_BRIDGE" ]; then
      (sleep 8 && \
       source /opt/ros/galactic/setup.bash && \
       source /root/novabot/install/setup.bash && \
       export ROS_LOCALHOST_ONLY=1 && \
       python3 "$MQTT_BRIDGE" >> $LOGS_PATH/mqtt_bridge.log 2>&1) &
      echo "mqtt_bridge.py scheduled (8s delay)" >> $LOGS_PATH/mqtt_bridge.log
  else
      # Fallback: start stock daemon_node als mqtt_bridge.py niet beschikbaar is
      ros2 run daemon_process daemon_node &
      echo "WARN: mqtt_bridge.py niet gevonden, stock daemon_node gestart" >> $LOGS_PATH/mqtt_bridge.log
  fi
MBEOF
        sed -i '' '/start_test.sh/r /tmp/mqtt_bridge_start_block.sh' "$RUN_NOVABOT"
        rm -f "$MQTT_BRIDGE_START"
        echo "  run_novabot.sh: mqtt_bridge.py boot hook toegevoegd aan start)"

        # Stop blok: kill mqtt_bridge.py + stock mqtt_node als fallback
        MQTT_BRIDGE_STOP="/tmp/mqtt_bridge_stop_block.sh"
        cat > "$MQTT_BRIDGE_STOP" << 'MBEOF'
  pkill -9 -f "python3.*mqtt_bridge" 2>/dev/null
  killall -q -9 mqtt_node 2>/dev/null
MBEOF
        sed -i '' '/killall -q -9 daemon_monitor.sh/r /tmp/mqtt_bridge_stop_block.sh' "$RUN_NOVABOT"
        rm -f "$MQTT_BRIDGE_STOP"
        echo "  run_novabot.sh: mqtt_bridge kill toegevoegd aan stop)"
    fi
else
    echo "  mqtt_bridge.py niet gevonden in open_node/ — stock mqtt_node wordt gebruikt"
fi

# === Stap 5g: Novabot-server bundelen ===
echo "[5g/9] Novabot-server bundelen..."

if [ "$INCLUDE_SERVER" = "true" ]; then
    SERVER_SRC_DIR="$SCRIPT_DIR/../novabot-server"
    DASH_SRC_DIR="$SCRIPT_DIR/../novabot-dashboard"

    # Compileer server TypeScript (als dist/ ontbreekt of verouderd is)
    if [ ! -d "$SERVER_SRC_DIR/dist" ] || [ "$SERVER_SRC_DIR/src" -nt "$SERVER_SRC_DIR/dist" ]; then
        echo "  Server TypeScript compileren..."
        (cd "$SERVER_SRC_DIR" && npm run build 2>&1 | tail -3)
    else
        echo "  dist/ is up-to-date — overslaan"
    fi

    # Bouw dashboard (als dist/ ontbreekt of verouderd is)
    if [ ! -d "$DASH_SRC_DIR/dist" ] || [ "$DASH_SRC_DIR/src" -nt "$DASH_SRC_DIR/dist" ]; then
        echo "  Dashboard bouwen..."
        (cd "$DASH_SRC_DIR" && npm run build 2>&1 | tail -3)
    else
        echo "  Dashboard dist/ is up-to-date — overslaan"
    fi

    # Kopieer naar firmware bundle
    SERVER_DEST="$NOVABOT_ROOT/opt/novabot-server"
    DASH_DEST="$NOVABOT_ROOT/opt/novabot-dashboard"
    mkdir -p "$SERVER_DEST" "$DASH_DEST/dist"

    cp -r "$SERVER_SRC_DIR/dist" "$SERVER_DEST/"
    cp "$SERVER_SRC_DIR/package.json" "$SERVER_DEST/"
    cp "$SERVER_SRC_DIR/package-lock.json" "$SERVER_DEST/"
    cp "$SCRIPT_DIR/libmadvise_fix.c" "$SERVER_DEST/"
    cp -r "$DASH_SRC_DIR/dist/." "$DASH_DEST/dist/"

    echo "  Server dist/ + dashboard dist/ gekopieerd naar firmware bundle"

    # --bundle-node: ook Node.js binary + pre-compiled node_modules bundelen
    if [ "$BUNDLE_NODE" = "true" ]; then
        # Gebruik een vaste, bekende LTS versie (grep -oP werkt niet op macOS BSD grep)
        NODE_VERSION="v20.19.0"
        NODE_TARBALL="node-${NODE_VERSION}-linux-arm64.tar.gz"
        NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"

        echo "  Node.js binary downloaden: ${NODE_VERSION} (ARM64)..."
        # Verwijder gecachte tarball als die < 1MB is (kapot door vorige mislukte download)
        if [ -f "/tmp/${NODE_TARBALL}" ] && [ "$(stat -f%z "/tmp/${NODE_TARBALL}" 2>/dev/null || stat -c%s "/tmp/${NODE_TARBALL}" 2>/dev/null || echo 0)" -lt 1048576 ]; then
            echo "  Gecachte tarball is te klein — opnieuw downloaden..."
            rm -f "/tmp/${NODE_TARBALL}"
        fi
        if [ ! -f "/tmp/${NODE_TARBALL}" ]; then
            curl -L --progress-bar "$NODE_URL" -o "/tmp/${NODE_TARBALL}"
            # Controleer of download succesvol was (> 10MB verwacht)
            TARBALL_SIZE=$(stat -f%z "/tmp/${NODE_TARBALL}" 2>/dev/null || stat -c%s "/tmp/${NODE_TARBALL}" 2>/dev/null || echo 0)
            if [ "$TARBALL_SIZE" -lt 10485760 ]; then
                echo "  WAARSCHUWING: Node.js tarball te klein (${TARBALL_SIZE} bytes) — download mislukt?"
                echo "  Maaier zal system node (/usr/bin/node) gebruiken als fallback"
                rm -f "/tmp/${NODE_TARBALL}"
            else
                echo "  Node.js tarball gedownload ($(du -sh "/tmp/${NODE_TARBALL}" | cut -f1))"
            fi
        else
            echo "  (al gecached in /tmp/)"
        fi
        if [ -f "/tmp/${NODE_TARBALL}" ]; then
            cp "/tmp/${NODE_TARBALL}" "$SERVER_DEST/node-v20-linux-arm64.tar.gz"
            echo "  Node.js tarball gebundeld ($(du -sh "$SERVER_DEST/node-v20-linux-arm64.tar.gz" | cut -f1))"
        fi

        # Kopieer pre-compiled node_modules van maaier via scp
        MOWER_IP="$BUNDLE_NODE_IP"
        if [ -z "$MOWER_IP" ]; then
            # Probeer auto-detectie via nmap of arp
            MOWER_IP=$(arp -n 2>/dev/null | grep -i "50:41:1c" | awk '{print $1}' | head -1 || true)
        fi
        # Eerst lokale cache proberen, dan pas SSH naar maaier
        NM_CACHE="/tmp/node_modules_mower_cache.tar.gz"
        if [ -f "$NM_CACHE" ]; then
            echo "  node_modules uit lokale cache ($NM_CACHE)..."
            # || true: macOS tar geeft fout op Linux resource fork bestanden (._*), maar extractie lukt
            tar xzf "$NM_CACHE" -C "$SERVER_DEST" 2>/dev/null || true
            echo "  node_modules gebundeld ($(du -sh "$SERVER_DEST/node_modules" | cut -f1))"
        elif [ -n "$MOWER_IP" ]; then
            echo "  node_modules kopiëren van maaier ($MOWER_IP)..."
            # Comprimeer op maaier, download als één bestand (betrouwbaarder dan scp -r)
            sshpass -p 'novabot' ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=10 \
                "root@${MOWER_IP}" \
                "cd /root/novabot-server && tar czf /tmp/node_modules.tar.gz node_modules"
            sshpass -p 'novabot' scp -o StrictHostKeyChecking=no -o ServerAliveInterval=10 \
                "root@${MOWER_IP}:/tmp/node_modules.tar.gz" "$NM_CACHE"
            tar xzf "$NM_CACHE" -C "$SERVER_DEST"
            echo "  node_modules gebundeld ($(du -sh "$SERVER_DEST/node_modules" | cut -f1))"
        else
            echo "  WAARSCHUWING: Geen maaier IP gevonden voor --bundle-node"
            echo "  Gebruik --bundle-node-ip <ip> om dit op te geven"
            echo "  node_modules worden bij installatie gedownload (internet vereist)"
        fi
    fi

    echo "  Server bundel klaar"
else
    echo "  --include-server niet opgegeven — overslaan"
fi

# === Stap 6: Optioneel ROS 2 netwerk openzetten ===
if [ "$ENABLE_REMOTE_ROS2" = "true" ]; then
    echo "[6/8] ROS 2 netwerk openzetten..."
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
    echo "[6/8] ROS 2 netwerk: localhost-only (standaard)"
fi

# === Stap 7: Versie-info bijwerken ===
echo "[7/8] Versie-info bijwerken..."

# Update Readme.txt
README="$NOVABOT_ROOT/Readme.txt"
if [ -f "$README" ]; then
    echo "" >> "$README"
    echo "# Custom firmware modifications ($(date +%Y-%m-%d)):" >> "$README"
    echo "# - SSH server (openssh-server) auto-install" >> "$README"
    echo "# - HTTP uploads → ${HTTP_BASE}" >> "$README"
    echo "# - Root password set for SSH access" >> "$README"
    [ "$ENABLE_REMOTE_ROS2" = "true" ] && echo "# - ROS 2 network access enabled" >> "$README"
    [ "$INCLUDE_SERVER" = "true" ] && echo "# - Novabot-server (local cloud) gebundeld" >> "$README"
    [ "$INCLUDE_SERVER" = "true" ] && [ "$BUNDLE_NODE" = "true" ] && echo "# - Node.js + node_modules offline gebundeld" >> "$README"
    echo "# Version: ${VERSION}" >> "$README"
fi

# Update novabot_api.yaml version
if [ -f "$API_YAML" ]; then
    sed -i '' "s/novabot_version_code: ${BASE_VERSION}/novabot_version_code: ${VERSION}/" "$API_YAML"
    echo "  Versie in novabot_api.yaml → ${VERSION}"
fi

# === Stap 8: package_verify.json bijwerken ===
echo "[8/9] package_verify.json bijwerken..."

VERIFY_JSON="$NOVABOT_ROOT/package_verify.json"
if [ -f "$VERIFY_JSON" ]; then
    # Update bestandsgroottes en MD5 hashes voor alle gewijzigde bestanden
    export VERIFY_JSON NOVABOT_ROOT
    python3 << 'PYEOF'
import json, hashlib, os, sys

verify_path = os.environ.get('VERIFY_JSON', '')
root_dir = os.environ.get('NOVABOT_ROOT', '')

if not verify_path or not root_dir:
    print("  ERROR: VERIFY_JSON of NOVABOT_ROOT niet gezet")
    sys.exit(1)

with open(verify_path, 'r') as f:
    data = json.load(f)

updated = 0
removed = 0
new_entries = []

for entry in data['fileVerification']:
    rel_path = entry['path']
    full_path = os.path.join(root_dir, rel_path.lstrip('/'))

    if not os.path.exists(full_path):
        # Bestand verwijderd of hernoemd — zoek vervanging in dezelfde directory
        parent = os.path.dirname(full_path)
        if os.path.isdir(parent):
            # Zoek bestanden in dezelfde map die niet in de verify-lijst staan
            existing_paths = set(
                e['path'] for e in data['fileVerification']
            )
            found_replacement = False
            for sibling in os.listdir(parent):
                sib_full = os.path.join(parent, sibling)
                sib_rel = '/' + os.path.relpath(sib_full, root_dir)
                if os.path.isfile(sib_full) and sib_rel not in existing_paths:
                    # Voeg vervanging toe met correct formaat
                    sib_size = os.path.getsize(sib_full)
                    new_entry = {
                        "type": "file",
                        "path": sib_rel,
                        "checkWay": {"0": {"way": "Size-B", "value": sib_size}},
                        "ignoreCheck": False
                    }
                    new_entries.append(new_entry)
                    existing_paths.add(sib_rel)
                    print(f"  Replaced: {rel_path} → {sib_rel} ({sib_size}B)")
                    found_replacement = True
            if not found_replacement:
                print(f"  Removed: {rel_path} (bestand niet meer aanwezig)")
        else:
            print(f"  Removed: {rel_path} (directory niet meer aanwezig)")
        removed += 1
        entry['_remove'] = True
        continue

    actual_size = os.path.getsize(full_path)

    for key, check in entry['checkWay'].items():
        if check['way'] == 'Size-B':
            if check['value'] != actual_size:
                print(f"  Size update: {rel_path} ({check['value']}B → {actual_size}B)")
                check['value'] = actual_size
                updated += 1
        elif check['way'] == 'MD5-B':
            with open(full_path, 'rb') as fh:
                actual_md5 = hashlib.md5(fh.read()).hexdigest()
            if check['value'] != actual_md5:
                print(f"  MD5 update:  {rel_path}")
                check['value'] = actual_md5
                updated += 1

# Verwijder ontbrekende entries en voeg nieuwe toe
data['fileVerification'] = [
    e for e in data['fileVerification'] if not e.get('_remove')
] + new_entries

with open(verify_path, 'w') as f:
    json.dump(data, f, separators=(',', ':'))

print(f"  {updated} verificatiewaarden bijgewerkt, {removed} verwijderd/vervangen")
PYEOF
else
    echo "  Geen package_verify.json gevonden — overslaan"
fi

# === Stap 9: Bouw .deb ===
echo "[9/9] .deb bouwen..."
mkdir -p "$OUTPUT_DIR"
OUTPUT_DEB="$OUTPUT_DIR/mower_firmware_${VERSION}.deb"

# De originele .deb bevat data.tar.xz met flat structuur:
#   ./Readme.txt, ./scripts/, ./install/, etc.
# De OTA flow doet: dpkg -x package.deb /root/novabot.new/
# dpkg -x extraheert de data payload naar het target directory
# Dus de flat structuur is correct.

echo "  Herbouwen data.tar.xz vanuit aangepaste firmware..."

# Maak nieuwe data.tar.xz vanuit de aangepaste firmware data
# COPYFILE_DISABLE=1 voorkomt macOS ._* bestanden in de tar (veroorzaakt "unknown extended header" op ARM)
cd "$FIRMWARE_DATA"
COPYFILE_DISABLE=1 tar -cJf "$WORK_DIR/data.tar.xz" .
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
COPYFILE_DISABLE=1 tar -cJf "$WORK_DIR/control.tar.xz" .
cd "$WORK_DIR"

# Bouw .deb ar-archief (volgorde is belangrijk: debian-binary eerst)
# macOS /usr/bin/ar is BROKEN (produces 96-byte files) — use bundled GNU ar
GNU_AR="$SCRIPT_DIR/../tools/bin/gnu-ar"
if [ ! -f "$GNU_AR" ]; then
    # Fallback: find Homebrew ar
    GNU_AR=$(find /usr/local/Cellar/binutils /opt/homebrew/Cellar/binutils -name "ar" -type f 2>/dev/null | head -1)
fi
if [ -z "$GNU_AR" ] || [ ! -f "$GNU_AR" ]; then
    echo "ERROR: GNU ar niet gevonden. Verwacht: tools/bin/gnu-ar of brew install binutils"
    exit 1
fi
echo "  Gebruik ar: $GNU_AR"
"$GNU_AR" cr "$OUTPUT_DEB" debian-binary control.tar.xz data.tar.xz
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

# Schrijf metadata JSON naast de .deb
DEB_BASENAME="$(basename "$OUTPUT_DEB")"
JSON_META="${OUTPUT_DEB%.deb}.json"
cat > "$JSON_META" << METAEOF
{
  "version": "${VERSION}",
  "device_type": "mower",
  "filename": "${DEB_BASENAME}",
  "md5": "${MD5}",
  "description": "OpenNova mower firmware (custom build)"
}
METAEOF
echo "  Metadata: $(basename "$JSON_META")"

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
echo "    ✓ MQTT broker → ${MQTT_HOST}:${MQTT_PORT}"
echo "    ✓ http_address.txt + json_config.json worden bij elke boot gezet"
[ -f "$NOVABOT_ROOT/scripts/camera_stream.py" ] && echo "    ✓ Camera MJPEG stream op poort 8000 (auto-start na 15s)"
[ -f "$NOVABOT_ROOT/scripts/led_bridge.py" ] && echo "    ✓ LED bridge: MQTT → ROS /led_set (headlight controle)"
[ -f "$NOVABOT_ROOT/scripts/extended_commands.py" ] && echo "    ✓ Extended commands: reboot, camera snapshot, system info (auto-start na 12s)"
echo "    ✓ STM32 MCU: stock v3.6.0 (pin_unlock patch disabled)"
grep -q "open_decision" "$RUN_NOVABOT" 2>/dev/null && echo "    ✓ Open robot_decision boot hook (Python vervangt C++ na 20s)"
[ -f "$NOVABOT_ROOT/scripts/mqtt_bridge.py" ] && echo "    ✓ Open mqtt_node (mqtt_bridge.py vervangt stock mqtt_node — geen domain whitelist)"
[ "$ENABLE_REMOTE_ROS2" = "true" ] && echo "    ✓ ROS 2 netwerk open (ROS_LOCALHOST_ONLY=0)"
if [ "$INCLUDE_SERVER" = "true" ]; then
    echo "    ✓ Novabot-server gebundeld (dashboard op poort ${SERVER_PORT})"
    echo "    ✓ novabot-server.service geactiveerd (auto-start bij boot)"
    echo "    ✓ DNS redirect: app.lfibot.com + mqtt.lfibot.com → maaier IP"
    echo "    ✓ mDNS: maaier beschikbaar als novabot.local (avahi-daemon)"
    echo "    ✓ WiFi AP fallback: SSID=OpenNova PSK=novabot123 (na 90s zonder STA)"
    echo "    ✓ WiFi watchdog: continu monitoring, auto-herstel config + AP bij problemen"
    echo "    ✓ Ethernet recovery: 192.168.1.10/24 (altijd actief)"
    echo "    ✓ json_config.json: atomic writes + factory backup + pre-boot validatie"
    if [ "$BUNDLE_NODE" = "true" ]; then
        echo "    ✓ Node.js 20 ARM64 + node_modules offline gebundeld"
    else
        echo "    ℹ Node.js 20 + npm packages worden gedownload bij installatie (internet vereist)"
    fi
    echo ""
    echo "  Na OTA flash:"
    echo "    - Open http://<maaier-ip>:${SERVER_PORT} in browser"
    echo "    - Maak een account aan via de setup wizard"
    echo "    - Router DNS: app.lfibot.com → <maaier-ip> voor app-verbinding"
fi
echo ""
echo "============================================"
echo "  OTA FLASH INSTRUCTIES"
echo "============================================"
echo ""
echo "  1. Kopieer firmware naar server firmware directory:"
echo "     cp $OUTPUT_DEB <novabot-server>/firmware/"
echo ""
echo "  2. Stuur het OTA commando via MQTT:"
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
             "downloadUrl": "${HTTP_BASE}/firmware/$(basename $OUTPUT_DEB)",
             "md5": "${MD5}"
           }
         }
       }
     }
OTAJSON
echo ""
echo "  3. Of gebruik het dashboard commando endpoint:"
echo "     curl -X POST ${HTTP_BASE}/api/dashboard/command/LFIN2230700238 \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"command\": \"ota_upgrade_cmd\", \"params\": {\"type\": \"full\", \"content\": {\"upgradeApp\": {\"version\": \"${VERSION}\", \"downloadUrl\": \"${HTTP_BASE}/firmware/$(basename $OUTPUT_DEB)\", \"md5\": \"${MD5}\"}}}}'"
echo ""
echo "  BELANGRIJK:"
echo "    - Maaier moet OPLADEN voordat download start"
echo "    - Download duurt 20-30 minuten (35MB via WiFi)"
echo "    - Na reboot: ssh root@<maaier-ip> (wachtwoord: ${SSH_PASSWORD})"
echo "    - Bij problemen: maaier rollback naar vorige versie automatisch"
echo ""

# Schrijf OTA JSON naar bestand voor gemakkelijk gebruik
cat > "$OUTPUT_DIR/ota_flash_command.json" << OTAFILE
{
  "ota_upgrade_cmd": {
    "type": "full",
    "content": {
      "upgradeApp": {
        "version": "${VERSION}",
        "downloadUrl": "${HTTP_BASE}/firmware/$(basename $OUTPUT_DEB)",
        "md5": "${MD5}"
      }
    }
  }
}
OTAFILE

echo "  OTA commando opgeslagen: $OUTPUT_DIR/ota_flash_command.json"
echo ""
