#!/usr/bin/env bash
# Activate open_mqtt_node on this mower. Kills the stock mqtt_node
# (systemd will not respawn it while OURS holds the same node name in
# the ROS graph) and execs main.py.
#
# Note: cannot use `set -u` — galactic setup.bash references unset
# AMENT_TRACE_SETUP_FILES.
set -eo pipefail

cd /userdata/open_mqtt_node

# Make sure deps are present
if ! python3 -c 'import paho.mqtt.client' 2>/dev/null; then
  pip3 install -r requirements.txt
fi

# Kill stock mqtt_node ONLY (do NOT touch other ROS nodes)
pkill -f '/install/.*/mqtt_node' || true
sleep 2

export PYTHONPATH="/userdata/open_mqtt_node:${PYTHONPATH:-}"
export ROS_LOCALHOST_ONLY=1
. /opt/ros/galactic/setup.bash
. /root/novabot/install/setup.bash

exec python3 main.py
