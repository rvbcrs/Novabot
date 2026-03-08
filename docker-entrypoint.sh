#!/bin/sh
set -e

TARGET_IP="${TARGET_IP:?ERROR: Set TARGET_IP to your server's LAN IP address}"
PORT="${PORT:-80}"

echo "=== Novabot Docker Container ==="
echo "  Server: ${TARGET_IP}"
echo "  HTTP:   port ${PORT}"
echo "  HTTPS:  port 443 (TLS voor Novabot app)"
echo "  MQTT:   port 1883"

# ── TLS certificaat genereren (eenmalig, opgeslagen in /data/certs) ──────────
CERT_DIR=/data/certs
mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/server.crt" ] || [ ! -f "$CERT_DIR/server.key" ]; then
  echo "  TLS: Generating self-signed CA cert for *.lfibot.com..."
  # OpenSSL config met SubjectAltName (vereist voor moderne browsers/apps)
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
  echo "  TLS: Cert gegenereerd → ${CERT_DIR}/server.crt"
else
  echo "  TLS: Cert hergebruikt uit ${CERT_DIR}"
fi

# ── nginx voor HTTPS (port 443 → Node.js port $PORT) ─────────────────────────
cat > /etc/nginx/http.d/novabot.conf << NGINXEOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;

    ssl_certificate     ${CERT_DIR}/server.crt;
    ssl_certificate_key ${CERT_DIR}/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Proxy naar Node.js (HTTP)
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        # WebSocket (Socket.io)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
NGINXEOF

# Verwijder default nginx config
rm -f /etc/nginx/http.d/default.conf

nginx
echo "  TLS: nginx gestart (port 443)"

# ── DNS (dnsmasq) — optioneel ────────────────────────────────────────────────
if [ "${DISABLE_DNS}" = "true" ]; then
  echo "  DNS:    disabled (use your own DNS: AdGuard, Pi-hole, etc.)"
else
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

  echo "  DNS:    *.lfibot.com -> ${TARGET_IP}"
  if [ -n "$EXTRA_DOMAINS" ]; then
    IFS=','
    for domain in $EXTRA_DOMAINS; do
      domain=$(echo "$domain" | tr -d ' ')
      echo "  DNS:    *.${domain} -> ${TARGET_IP}"
    done
    unset IFS
  fi
  echo "  DNS:    upstream -> ${UPSTREAM_DNS}"

  dnsmasq --no-daemon &
  DNSMASQ_PID=$!
  trap "kill $DNSMASQ_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0" SIGTERM SIGINT
fi

echo "================================="

# ── Node.js server ────────────────────────────────────────────────────────────
cd /app/novabot-server
export DB_PATH=/data/novabot.db
export STORAGE_PATH=/data/storage
export FIRMWARE_PATH=/data/firmware
exec node dist/index.js
