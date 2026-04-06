#!/bin/bash
export ROS_DOMAIN_ID=21
echo "ROS_DOMAIN_ID is: "$ROS_DOMAIN_ID

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export perLogPath=/userdata/lfi/
DATE=`date +%Y%m%d_%H%M`

source /root/novabot/install/setup.sh
perLogPath=/userdata/lfi/  

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml

ros2 launch perception_node perception_node_shm.launch.py pub_debug_image:=True  >>$perLogPath/perception_node_shm_$DATE.log &

unset RMW_IMPLEMENTATION
unset CYCLONEDDS_URI

