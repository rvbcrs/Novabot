#!/usr/bin/env bash
# Activate ours, capture 10 minutes, diff vs stock baseline.
# REQUIRES: a baseline captured by parity_capture.sh first.
set -euo pipefail

MOWER_IP="${MOWER_IP:-192.168.0.100}"
BASELINE_DIR="${BASELINE_DIR:?Set BASELINE_DIR to a directory from parity_capture.sh}"
OUT="${OUT:-/tmp/our_run_$(date +%s)}"
mkdir -p "$OUT"

echo "Activating open mqtt_node on $MOWER_IP"
sshpass -p novabot ssh -o StrictHostKeyChecking=no "root@$MOWER_IP" \
  'bash /userdata/open_mqtt_node/start.sh &'
sleep 10

sshpass -p novabot ssh -o StrictHostKeyChecking=no "root@$MOWER_IP" '
  . /opt/ros/galactic/setup.bash
  ros2 node info /mqtt_node 2>&1
  ros2 service list 2>&1
  ros2 action list 2>&1
  ros2 topic list 2>&1
' > "$OUT/graph_snapshot.txt"

python3 ../../../tools/mqtt_node_capture.py \
  --broker 127.0.0.1 --duration-sec 600 \
  --out "$OUT/mqtt_capture.jsonl"

echo "Rolling back to stock"
sshpass -p novabot ssh -o StrictHostKeyChecking=no "root@$MOWER_IP" \
  'bash /userdata/open_mqtt_node/rollback.sh'

echo "Baseline:  $BASELINE_DIR"
echo "Our run:   $OUT"
diff "$BASELINE_DIR/graph_snapshot.txt" "$OUT/graph_snapshot.txt" || true
echo "MQTT capture diff requires manual inspection — both files in their dirs."
