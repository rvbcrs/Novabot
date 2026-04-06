#!/bin/bash
# deploy.sh — Deploy open_node to the mower via SCP
#
# Usage: bash deploy.sh [mower_ip]
# Default IP: MOWER_IP

set -e

MOWER_IP="${1:-MOWER_IP}"
MOWER_USER="root"
MOWER_PASS="novabot"
REMOTE_DIR="/userdata/open_node"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Deploying open_node to $MOWER_IP ==="

# Upload files
sshpass -p "$MOWER_PASS" ssh -o StrictHostKeyChecking=no "$MOWER_USER@$MOWER_IP" \
    "mkdir -p $REMOTE_DIR"

for f in mqtt_bridge.py start.sh; do
    echo "  Uploading $f..."
    sshpass -p "$MOWER_PASS" scp -o StrictHostKeyChecking=no \
        "$SCRIPT_DIR/$f" "$MOWER_USER@$MOWER_IP:$REMOTE_DIR/$f"
done

# Make start.sh executable
sshpass -p "$MOWER_PASS" ssh -o StrictHostKeyChecking=no "$MOWER_USER@$MOWER_IP" \
    "chmod +x $REMOTE_DIR/start.sh"

echo ""
echo "=== Deployed to $MOWER_IP:$REMOTE_DIR ==="
echo ""
echo "To start (replaces stock mqtt_node):"
echo "  sshpass -p 'novabot' ssh root@$MOWER_IP 'bash $REMOTE_DIR/start.sh'"
echo ""
echo "To rollback (restart stock mqtt_node):"
echo "  sshpass -p 'novabot' ssh root@$MOWER_IP 'kill \$(pgrep -f mqtt_bridge.py); systemctl restart novabot_launch'"
echo ""
