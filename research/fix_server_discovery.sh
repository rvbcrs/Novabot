#!/bin/bash
# Fix server discovery op de maaier — voegt DNS resolution toe aan set_server_urls.sh
# Gebruik: sshpass -p 'novabot' ssh root@192.168.0.244 'bash -s' < fix_server_discovery.sh
#
# Dit script:
# 1. Patcht set_server_urls.sh met DNS resolution stap (mqtt.lfibot.com)
# 2. Herstart ALLEEN mqtt_node (niet het hele systeem)
# 3. Na patch: maaier vindt server via DNS bij elke service herstart

SCRIPT="/root/novabot/scripts/set_server_urls.sh"
LOG="/userdata/ota/custom_firmware.log"

echo "[$(date)] fix_server_discovery: start" >> "$LOG"

if [ ! -f "$SCRIPT" ]; then
    echo "ERROR: $SCRIPT niet gevonden!"
    exit 1
fi

# Backup
cp "$SCRIPT" "${SCRIPT}.bak.$(date +%Y%m%d%H%M%S)"

# Check of DNS stap al bestaat
if grep -q "DNS_HOSTNAME" "$SCRIPT"; then
    echo "DNS stap bestaat al in set_server_urls.sh — skip patch"
else
    # Voeg DNS resolution toe VOOR de "Bepaal server IP" sectie
    sed -i '/# ── Bepaal server IP/i\
# ── DNS resolution (mqtt.lfibot.com → IP via systeem-DNS / AdGuard) ────\
DNS_HOSTNAME="mqtt.lfibot.com"\
DNS_IP=$(python3 -c "\
import socket\
try:\
    ip = socket.gethostbyname('"'"'mqtt.lfibot.com'"'"')\
    if not ip.startswith('"'"'127.'"'"'):\
        print(ip)\
except:\
    pass\
" 2>/dev/null)\
' "$SCRIPT"

    # Update de cascade: voeg DNS_IP check toe na DISCOVERED_IP
    sed -i '/log "Server ontdekt via mDNS/,/SERVER_IP="\$DISCOVERED_IP"/{
        /SERVER_IP="\$DISCOVERED_IP"/a\
elif [ -n "$DNS_IP" ]; then\
    log "Server ontdekt via DNS ($DNS_HOSTNAME): $DNS_IP"\
    echo "$DNS_IP" > "$LAST_KNOWN_FILE"\
    SERVER_IP="$DNS_IP"
    }' "$SCRIPT"

    echo "DNS resolution stap toegevoegd aan set_server_urls.sh"
    echo "[$(date)] fix_server_discovery: DNS stap gepatcht" >> "$LOG"
fi

# Nu: voer het script direct uit om de config te updaten
echo "set_server_urls.sh uitvoeren..."
bash "$SCRIPT"

# Lees het resultaat
echo ""
echo "=== Huidige config ==="
echo "server_ip.txt: $(cat /userdata/lfi/server_ip.txt 2>/dev/null || echo 'NIET GEVONDEN')"
echo "http_address.txt: $(cat /userdata/lfi/http_address.txt 2>/dev/null || echo 'NIET GEVONDEN')"
echo "json_config.json mqtt.addr: $(python3 -c "import json; print(json.load(open('/userdata/lfi/json_config.json'))['mqtt']['value']['addr'])" 2>/dev/null || echo 'NIET GEVONDEN')"
echo ""

# Herstart ALLEEN mqtt_node (veilig, geen volledige system restart)
echo "mqtt_node herstarten..."
# mqtt_node draait als onderdeel van de ROS2 launch — we moeten het juiste proces vinden
MQTT_PID=$(pgrep -f "mqtt_node" | head -1)
if [ -n "$MQTT_PID" ]; then
    echo "mqtt_node PID: $MQTT_PID — stoppen..."
    kill "$MQTT_PID"
    sleep 2
    # ROS2 launch zou mqtt_node automatisch moeten herstarten (respawn)
    # Check of het terugkomt
    sleep 5
    NEW_PID=$(pgrep -f "mqtt_node" | head -1)
    if [ -n "$NEW_PID" ]; then
        echo "mqtt_node herstart OK (nieuw PID: $NEW_PID)"
    else
        echo "WAARSCHUWING: mqtt_node niet automatisch herstart!"
        echo "Probeer: systemctl restart novabot"
    fi
else
    echo "mqtt_node niet gevonden — probeer volledige service restart"
    systemctl restart novabot
fi

echo ""
echo "=== DNS test ==="
python3 -c "
import socket
try:
    ip = socket.gethostbyname('mqtt.lfibot.com')
    print(f'mqtt.lfibot.com → {ip}')
except Exception as e:
    print(f'DNS resolution mislukt: {e}')
"

echo ""
echo "[$(date)] fix_server_discovery: klaar" >> "$LOG"
echo "Klaar! Check server logs of de maaier verbindt."
