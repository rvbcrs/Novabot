#!/bin/sh
set -e

TARGET_IP="${TARGET_IP:?ERROR: set TARGET_IP to your novabot-server IP address}"
UPSTREAM_DNS="${UPSTREAM_DNS:-8.8.8.8}"

cat > /etc/dnsmasq.conf <<EOF
# Novabot DNS rewrite — redirect *.lfibot.com to local server
no-resolv
server=${UPSTREAM_DNS}

# Rewrite lfibot.com domains to the novabot-server
address=/lfibot.com/${TARGET_IP}

# Listen on all interfaces
listen-address=0.0.0.0
bind-interfaces

# Don't read /etc/hosts
no-hosts

# Log queries (optional, handy for debugging)
log-queries
log-facility=-
EOF

echo "=== Novabot DNS ==="
echo "  *.lfibot.com -> ${TARGET_IP}"
echo "  Upstream DNS -> ${UPSTREAM_DNS}"
echo "==================="

exec dnsmasq --no-daemon
