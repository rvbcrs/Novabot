#!/bin/bash
# Start lawn_edge_relay.py met ROS-env (NOOIT kaal python3 — RtkRelay-les).
# Kill-switch: pkill -f lawn_edge_relay.py
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=1

# Respawn-lus: dekt boot-races (rclpy/DDS nog niet klaar) én crashes — zelfde
# gedachte als camera_stream's respawn in de custom build. 15s backoff.
while true; do
  nice -n 10 python3 /root/novabot/scripts/lawn_edge_relay.py
  echo "lawn_edge_relay exited ($?), respawn over 15s" >&2
  sleep 15
done
