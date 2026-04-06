#!/bin/bash

path=/userdata/novabot_slam/run_camera
source /opt/ros/galactic/setup.bash
source /userdata/novabot_slam/install/setup.bash


case "$1" in
start)
  echo "starting camera.... "
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap
  #killall -q -9 ros2
  #killall -q -9 static_transform_publisher

  sleep 2s
  echo "starting iox camera.... " > $path/iox_all_camera.log 

  ros2 launch tof_camera tof_demo_test.launch.py  >> $path/iox_all_camera.log &

  #iox 模式运行前置和全景
  export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  export CYCLONEDDS_URI=file:///opt/ros/galactic/shm_config/shm_cyclonedds.xml
  # ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=true  >> $path/iox_all_camera.log &
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=true  >> $path/iox_all_camera.log &
  unset RMW_IMPLEMENTATION
  unset CYCLONEDDS_URI


  ;;
stop)
  echo "stopping iox camera.... "
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap
  #killall -q -9 ros2
  #killall -q -9 static_transform_publisher
  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac
