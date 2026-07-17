#!/bin/bash
# Start terrain_scan.py met ROS-env (NOOIT kaal python3 — RtkRelay-les).
# Kill-switch: pkill -f terrain_scan.py
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=1
exec nice -n 10 python3 /root/novabot/scripts/terrain_scan.py
