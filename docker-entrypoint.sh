#!/bin/sh
set -e

PORT="${PORT:-80}"
TARGET_IP="${TARGET_IP:-0.0.0.0}"

echo "=== OpenNova Server ==="
echo "  HTTP:  port ${PORT}"
echo "  MQTT:  port 1883"

# ── TLS + nginx (optional — needed for Novabot iOS app which requires HTTPS) ──
if [ "${ENABLE_TLS}" = "true" ] && [ -n "$TARGET_IP" ] && [ "$TARGET_IP" != "0.0.0.0" ]; then
  CERT_DIR=/data/certs
  mkdir -p "$CERT_DIR"

  if [ ! -f "$CERT_DIR/server.crt" ] || [ ! -f "$CERT_DIR/server.key" ]; then
    echo "  TLS: Generating self-signed cert..."
    cat > /tmp/ssl.cnf << SSLEOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_ca

[dn]
CN = OpenNova Local CA
O = OpenNova

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign,digitalSignature
subjectAltName = DNS:*.lfibot.com,DNS:lfibot.com,IP:${TARGET_IP}
SSLEOF

    openssl req -x509 -newkey rsa:2048 \
      -keyout "$CERT_DIR/server.key" \
      -out "$CERT_DIR/server.crt" \
      -days 3650 -nodes \
      -config /tmp/ssl.cnf \
      -extensions v3_ca
  fi

  cat > /etc/nginx/http.d/novabot.conf << NGINXEOF
server {
    listen 443 ssl;
    ssl_certificate     ${CERT_DIR}/server.crt;
    ssl_certificate_key ${CERT_DIR}/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
NGINXEOF
  rm -f /etc/nginx/http.d/default.conf
  nginx
  echo "  TLS:   port 443 (nginx → ${PORT})"
fi

# ── DNS (optional — only needed if using the Novabot app without mobileconfig) ──
if [ "${ENABLE_DNS}" = "true" ] && [ -n "$TARGET_IP" ] && [ "$TARGET_IP" != "0.0.0.0" ]; then
  UPSTREAM_DNS="${UPSTREAM_DNS:-8.8.8.8}"
  cat > /etc/dnsmasq.conf <<EOF
no-resolv
server=${UPSTREAM_DNS}
address=/lfibot.com/${TARGET_IP}
listen-address=0.0.0.0
bind-interfaces
no-hosts
EOF
  dnsmasq --no-daemon &
  DNSMASQ_PID=$!
  trap "kill $DNSMASQ_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0" SIGTERM SIGINT
  echo "  DNS:   *.lfibot.com → ${TARGET_IP}"
fi

echo "================================="

# ── Node.js server ────────────────────────────────────────────────────────────
cd /app/novabot-server
export DB_PATH=/data/novabot.db
export STORAGE_PATH=/data/storage
export FIRMWARE_PATH=/data/firmware
exec node dist/index.js
