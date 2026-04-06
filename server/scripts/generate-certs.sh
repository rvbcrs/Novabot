#!/usr/bin/env bash
#
# Generates a local CA + server certificate for app.lfibot.com
#
# Usage:  bash scripts/generate-certs.sh
#
# Output files (all in certs/):
#   ca.key          — CA private key        (keep secret, never share)
#   ca.crt          — CA certificate        (→ installeren op Android)
#   server.key      — Server private key    (→ uploaden in NPM: "Private Key")
#   server.crt      — Server certificate    (signed by the CA)
#   fullchain.pem   — server.crt + ca.crt   (→ uploaden in NPM: "Certificate")

set -euo pipefail

CERTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

echo ""
echo "=== Generating local CA ==="
openssl genrsa -out ca.key 4096

openssl req -new -x509 \
  -days 3650 \
  -key ca.key \
  -out ca.crt \
  -subj "/C=NL/O=Novabot Local/CN=Novabot Local CA"

echo ""
echo "=== Generating server key and CSR ==="
openssl genrsa -out server.key 2048

openssl req -new \
  -key server.key \
  -out server.csr \
  -subj "/C=NL/O=Novabot Local/CN=app.lfibot.com"

echo ""
echo "=== Signing server certificate with local CA ==="
cat > server-ext.cnf << 'EOF'
authorityKeyIdentifier = keyid,issuer
basicConstraints       = CA:FALSE
keyUsage               = digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectAltName         = @alt_names

[alt_names]
DNS.1 = app.lfibot.com
DNS.2 = *.lfibot.com
EOF

openssl x509 -req \
  -in server.csr \
  -CA ca.crt \
  -CAkey ca.key \
  -CAcreateserial \
  -out server.crt \
  -days 3650 \
  -sha256 \
  -extfile server-ext.cnf

# fullchain.pem = server cert + CA cert (wat nginx proxy manager verwacht)
cat server.crt ca.crt > fullchain.pem

# Clean up temp files
rm -f server.csr server-ext.cnf ca.srl

echo ""
echo "✓ Done! Files written to: $CERTS_DIR"
echo ""
echo "  Nginx Proxy Manager — Custom Certificate:"
echo "    Certificate (PEM):  fullchain.pem"
echo "    Private Key (PEM):  server.key"
echo ""
echo "  Android — CA installeren:"
echo "    ca.crt  →  kopieer naar telefoon en installeer als vertrouwde CA"
echo ""
echo "=== Verify de Subject Alternative Names ==="
openssl x509 -in server.crt -noout -text | grep -A4 "Subject Alternative Name"
