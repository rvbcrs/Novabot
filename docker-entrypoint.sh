#!/bin/sh
set -e

# ── DNS (dnsmasq) ────────────────────────────────────────────────────────────
# TARGET_IP is required — this is the LAN IP that *.lfibot.com resolves to
TARGET_IP="${TARGET_IP:?ERROR: Set TARGET_IP to your server's LAN IP address}"
UPSTREAM_DNS="${UPSTREAM_DNS:-8.8.8.8}"

cat > /etc/dnsmasq.conf <<EOF
# Novabot DNS — redirect *.lfibot.com to local server
no-resolv
server=${UPSTREAM_DNS}
address=/lfibot.com/${TARGET_IP}
listen-address=0.0.0.0
bind-interfaces
no-hosts
log-queries
log-facility=-
EOF

# Extra domains (comma-separated, e.g. "ramonvanbruggen.nl,example.com")
if [ -n "$EXTRA_DOMAINS" ]; then
  IFS=','
  for domain in $EXTRA_DOMAINS; do
    domain=$(echo "$domain" | tr -d ' ')
    echo "address=/${domain}/${TARGET_IP}" >> /etc/dnsmasq.conf
  done
  unset IFS
fi

echo "=== Novabot Docker Container ==="
echo "  DNS:  *.lfibot.com -> ${TARGET_IP}"
if [ -n "$EXTRA_DOMAINS" ]; then
  IFS=','
  for domain in $EXTRA_DOMAINS; do
    domain=$(echo "$domain" | tr -d ' ')
    echo "  DNS:  *.${domain} -> ${TARGET_IP}"
  done
  unset IFS
fi
echo "  DNS:  upstream     -> ${UPSTREAM_DNS}"
echo "  HTTP: port ${PORT:-3000} + 80"
echo "  MQTT: port 1883"
echo "================================="

# Start dnsmasq in background
dnsmasq --no-daemon &
DNSMASQ_PID=$!

# Graceful shutdown: stop dnsmasq when Node.js exits
trap "kill $DNSMASQ_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# ── Node.js server ────────────────────────────────────────────────────────────
cd /app/novabot-server

exec node dist/index.js
