#!/usr/bin/env bash
# Deploy open_mqtt_node from this dev host to the mower at MOWER_IP.
# Stock binary stays in place. Activation is a separate step (start.sh).
set -euo pipefail

MOWER_IP="${MOWER_IP:-192.168.0.100}"
SCP_OPTS="-o StrictHostKeyChecking=no"
SSH_OPTS="-o StrictHostKeyChecking=no"

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="/userdata/open_mqtt_node"

sshpass -p novabot ssh $SSH_OPTS "root@$MOWER_IP" "mkdir -p $REMOTE_DIR"
sshpass -p novabot scp $SCP_OPTS -r \
  "$LOCAL_DIR"/*.py "$LOCAL_DIR"/requirements.txt \
  "$LOCAL_DIR"/start.sh "$LOCAL_DIR"/rollback.sh \
  "root@$MOWER_IP:$REMOTE_DIR/"

echo "Deployed to $MOWER_IP:$REMOTE_DIR"
echo "To activate: ssh root@$MOWER_IP 'bash $REMOTE_DIR/start.sh'"
echo "To roll back: ssh root@$MOWER_IP 'bash $REMOTE_DIR/rollback.sh'"
