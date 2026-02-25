#!/bin/bash



path=/root/novabot
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

case "$1" in
start)
  echo "starting camera.... "
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap
  #killall -q -9 ros2
  #killall -q -9 static_transform_publisher

  sleep 2s
  echo "starting camera.... " > $path/all_camera.log 
  ros2 launch tof_camera tof_demo_test.launch.py  >> $path/all_camera.log &
  sleep 2s
  ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=false  >> $path/all_camera.log & 
  sleep 2s 
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=false  >> $path/all_camera.log &

  ;;
stop)
  echo "stopping.... "
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



