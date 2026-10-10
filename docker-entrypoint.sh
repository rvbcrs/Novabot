#!/bin/sh
set -e

PORT="${PORT:-80}"
TARGET_IP="${TARGET_IP:-0.0.0.0}"

# ── mDNS sidecar ─────────────────────────────────────────────────────────────
# Same image, host network, advertises opennova.local and nothing else. See
# server/src/mdnsOnly.ts for why a bridged container cannot do this itself.
if [ "${MDNS_ONLY}" = "true" ]; then
  echo "=== OpenNova mDNS sidecar ==="
  cd /app/server
  if [ ! -f dist/mdnsOnly.js ]; then
    # A newer compose with an older image. Say so and stop cleanly; with
    # restart: on-failure a clean exit stays stopped instead of looping.
    echo "  this image predates the sidecar; pull rvbcrs/opennova:latest and run 'docker compose up -d' again"
    exit 0
  fi
  exec node dist/mdnsOnly.js
fi

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

  # Debian nginx includes /etc/nginx/conf.d/*.conf INSIDE the http{} block
  # (Alpine gebruikte http.d — image is sinds de node:20-slim switch Debian,
  # nodig omdat onnxruntime/glibc niet op musl draait).
  mkdir -p /etc/nginx/conf.d
  cat > /etc/nginx/conf.d/novabot.conf << NGINXEOF
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
  rm -f /etc/nginx/conf.d/default.conf /etc/nginx/sites-enabled/default
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

  # ── dnsmasq watchdog ──
  # dnsmasq can hang without exiting: a field report had it alive with 203 KB
  # stuck in the UDP 53 receive queue, and the mower fell back to the real LFI
  # cloud. So a background loop owns dnsmasq: it starts it, and every
  # DNS_WATCHDOG_INTERVAL seconds checks that a live dnsmasq exists AND answers
  # a lfibot.com query on 127.0.0.1. That name comes from our own address=
  # line, so the upstream DNS does not matter. Gone, or two failed probes in a
  # row: kill and start again. The loop (a subshell) is dnsmasq's parent, so a
  # killed dnsmasq gets reaped instead of lingering as a zombie under node.
  #
  # The admin panel's DNS Stop button creates DNS_STOPPED_FLAG; while it exists
  # the watchdog leaves dnsmasq alone. Keep the path in sync with
  # server/src/routes/adminStatus.ts. pgrep/pkill are not in the image (no
  # procps), so processes are found through /proc.
  DNS_WATCHDOG_INTERVAL=30
  DNS_STOPPED_FLAG=/tmp/opennova-dnsmasq.stopped
  rm -f "$DNS_STOPPED_FLAG"

  dnsmasq_pids() {
    for d in /proc/[0-9]*; do
      read -r comm 2>/dev/null < "$d/comm" || continue
      [ "$comm" = dnsmasq ] && echo "${d#/proc/}"
    done
  }

  dnsmasq_alive() {
    for pid in $(dnsmasq_pids); do
      while read -r key state _; do
        if [ "$key" = "State:" ]; then
          [ "$state" != Z ] && return 0
          break
        fi
      done 2>/dev/null < "/proc/$pid/status"
    done
    return 1
  }

  dns_probe() {
    timeout 5 node -e '
      const r = new (require("dns").promises.Resolver)({ timeout: 2000, tries: 1 });
      r.setServers(["127.0.0.1"]);
      r.resolve4("mqtt.lfibot.com").then(() => process.exit(0), () => process.exit(1));
    ' >/dev/null 2>&1
  }

  dnsmasq_stop() {
    pids=$(dnsmasq_pids)
    [ -n "$pids" ] || return 0
    kill $pids 2>/dev/null || true
    sleep 1
    if dnsmasq_alive; then kill -9 $(dnsmasq_pids) 2>/dev/null || true; fi
    sleep 1
  }

  dns_watchdog() {
    set +e
    dnsmasq --no-daemon &
    misses=0
    delay=$DNS_WATCHDOG_INTERVAL
    while :; do
      sleep "$delay"
      if [ -e "$DNS_STOPPED_FLAG" ]; then
        misses=0; delay=$DNS_WATCHDOG_INTERVAL
        continue
      fi
      if ! dnsmasq_alive; then
        why="is not running"
      elif dns_probe; then
        misses=0; delay=$DNS_WATCHDOG_INTERVAL
        continue
      else
        misses=$((misses + 1))
        [ "$misses" -lt 2 ] && continue
        why="does not answer on 127.0.0.1:53"
      fi
      echo "[DNS watchdog] dnsmasq $why, restarting it"
      dnsmasq_stop
      dnsmasq --no-daemon &
      misses=0
      # One that keeps failing (port 53 taken on the host, say) is retried
      # less and less often, up to every 10 minutes, instead of every interval.
      delay=$((delay * 2))
      [ "$delay" -gt 600 ] && delay=600
    done
  }

  dns_watchdog &
  DNS_WATCHDOG_PID=$!
  trap 'kill "$DNS_WATCHDOG_PID" 2>/dev/null; dnsmasq_stop; nginx -s quit 2>/dev/null; exit 0' TERM INT
  echo "  DNS:   *.lfibot.com → ${TARGET_IP} (watchdog every ${DNS_WATCHDOG_INTERVAL}s)"
fi

echo "================================="

# ── Node.js server ────────────────────────────────────────────────────────────
cd /app/server
export DB_PATH=/data/novabot.db
export STORAGE_PATH=/data/storage
export FIRMWARE_PATH=/data/firmware
exec node dist/index.js
