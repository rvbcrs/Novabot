#!/bin/bash
# start.sh — Start the open MQTT<->ROS2 bridge (replaces stock mqtt_node)
#
# Usage: bash /userdata/open_node/start.sh
# Requires: ROS 2 Galactic environment, pycryptodome

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ROS 2 environment
export ROS_LOCALHOST_ONLY=1
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

# Stop stock mqtt_node (if running)
if pgrep -f "bin/mqtt_node" > /dev/null 2>&1; then
    echo "[open_node] Stopping stock mqtt_node..."
    kill $(pgrep -f "bin/mqtt_node") 2>/dev/null || true
    sleep 2
fi

echo "[open_node] Starting mqtt_bridge.py..."
exec python3 "$SCRIPT_DIR/mqtt_bridge.py"
