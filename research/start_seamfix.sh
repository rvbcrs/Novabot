#!/bin/bash
# ROS-env is nodig: de daemon roept reload_nav_map.py aan zodra map.pgm wijzigt,
# en dat is een rclpy-proces. Zonder RMW_IMPLEMENTATION praat het tegen een
# andere DDS dan de firmware en komt de service-call nooit aan.
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=1
cd /root
exec python3 -u /root/novabot/scripts/seam_fix_daemon.py
