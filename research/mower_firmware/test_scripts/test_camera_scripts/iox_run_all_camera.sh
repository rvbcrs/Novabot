#!/bin/bash

path=/root/novabot
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash


case "$1" in
start)
  echo "starting camera.... "
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap
  killall -q -2 iox-roudi 

  sleep 2s
  echo "starting iox camera.... " > $path/iox_all_camera.log 

  ros2 launch tof_camera tof_demo_test.launch.py  >> $path/iox_all_camera.log &
  sleep 2s
  ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=False  >> $path/iox_all_camera.log &

  sleep 2s

  #iox 模式运行前置
  export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml

  iox-roudi -c /root/novabot/shm_config/shm_ioxroudi.toml --log-level verbose >> $path/iox_all_camera.log &
  sleep 2s
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=true  >> $path/iox_all_camera.log &

  unset RMW_IMPLEMENTATION
  unset CYCLONEDDS_URI


  ;;
stop)
  echo "stopping iox camera.... "
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap
  killall -q -2 iox-roudi 

  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac
