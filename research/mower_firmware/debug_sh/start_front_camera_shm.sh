#!/bin/bash
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log/
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
ros2 launch camera_307_cap camera_307_preposition_node.launch.py  use_shm:=true 
unset RMW_IMPLEMENTATION
unset CYCLONEDDS_URI
