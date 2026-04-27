#!/usr/bin/env bash
# Capture the stock mqtt_node's behaviour for 10 minutes:
# - ros2 node info /mqtt_node
# - 10 minutes of MQTT decrypted traffic
# - HTTP /api/nova-network/network/connection POSTs
set -euo pipefail

MOWER_IP="${MOWER_IP:-192.168.0.100}"
OUT="${OUT:-/tmp/stock_baseline_$(date +%s)}"
mkdir -p "$OUT"

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

echo "Stock baseline at $OUT"
