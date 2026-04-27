#!/usr/bin/env bash
# Roll back to stock mqtt_node. Kills our process and re-launches the
# stock binary via the existing launch file.
set -euo pipefail

pkill -f '/userdata/open_mqtt_node/main.py' || true
sleep 2

. /opt/ros/galactic/setup.bash
ros2 launch novabot_api novabot_api_node.py &
echo "Stock mqtt_node respawning via novabot_api_launch.py"
