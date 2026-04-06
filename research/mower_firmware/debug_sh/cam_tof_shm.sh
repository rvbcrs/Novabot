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

  ros2 launch tof_camera tof_camera.launch.py  >> $perLogPath/all_camera_$DATE.log  &
  sleep 2s

  export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
  iox-roudi -c /root/novabot/shm_config/shm_ioxroudi_debug.toml --log-level verbose &

  sleep 2s
  #ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=True  >> $ROS_LOG_DIR/all_camera_$DATE.log &   #共享内存方式运行全景
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=True  >> $perLogPath/all_camera_$DATE.log &  #共享内存方式运行前置 

  unset RMW_IMPLEMENTATION
  unset CYCLONEDDS_URI

