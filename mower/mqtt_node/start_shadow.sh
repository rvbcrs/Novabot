#!/usr/bin/env bash
# Run open_mqtt_node SIDE-BY-SIDE with the stock /mqtt_node binary.
#
# Differences from start.sh:
# - Does NOT kill stock mqtt_node — both run concurrently
# - Different ROS node name (open_mqtt_node_shadow) → no DDS clash
# - Outbound MQTT goes to Dart/Receive_mqtt_shadow/<SN> → app keeps
#   receiving stock responses
# - Service/action calls are logged only — handlers see "service
#   unavailable" and produce shadow-only error responds
#
# Use this for parity observation. Stock binary keeps the app alive;
# we observe what we WOULD do via the shadow topic.
# Note: cannot use `set -u` — galactic setup.bash references unset
# AMENT_TRACE_SETUP_FILES.
set -eo pipefail

cd /userdata/open_mqtt_node

# Make sure deps are present
if ! python3 -c 'import paho.mqtt.client' 2>/dev/null; then
  pip3 install -r requirements.txt
fi

export PYTHONPATH="/userdata/open_mqtt_node:${PYTHONPATH:-}"
export ROS_LOCALHOST_ONLY=1
export OPEN_MQTT_NODE_SHADOW=1
. /opt/ros/galactic/setup.bash
. /root/novabot/install/setup.bash

echo "Starting open_mqtt_node in SHADOW MODE alongside stock /mqtt_node"
echo "Stop with Ctrl-C or: pkill -f /userdata/open_mqtt_node/main.py"
exec python3 main.py
