#!/bin/bash
source /opt/ros/galactic/setup.bash
source /userdata/camera_ws/install/setup.bash
for((i=1;i<=200;i++));
do
  echo "starting TEST.... "
  killall -q -9 bt_navigator
  killall -q -9 planner_server
  killall -q -9 controller_server
  killall -q -9 map_server
  killall -q -9 chassis_control_node
  killall -q -9 robot_combination_localization 
  killall -q -9 nav2_single_node_navigator
  kill -2 $(ps aux | grep send_goal | tr -s ' '| cut -d ' ' -f 2)

  echo  "\n************************************************************************************\n" >>  /userdata/all_navigation.log

  ros2 launch chassis_control novabot_chassis_start.launch.py enable_map_as_odom:=True&
  sleep 5s
  ros2 launch robot_combination_localization localization_only.launch.py  >>/userdata/all_localization.log&
  sleep 3s
  ros2 launch nav2_single_node_navigator nav2_perception_navigator.launch.py use_sim_time:=False >>/userdata/all_navigation.log &
  sleep 60s
  echo "stopping.... "
  killall -q -9 bt_navigator
  killall -q -9 planner_server
  killall -q -9 controller_server
  killall -q -9 map_server
  killall -q -9 chassis_control_node
  killall -q -9 robot_combination_localization 
  killall -q -9 nav2_single_node_navigator
  kill -2 $(ps aux | grep send_goal | tr -s ' '| cut -d ' ' -f 2)
  sleep 5s

done
