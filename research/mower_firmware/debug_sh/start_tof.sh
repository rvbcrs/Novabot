#!/bin/bash
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log
ros2 launch tof_camera tof_camera.launch.py
