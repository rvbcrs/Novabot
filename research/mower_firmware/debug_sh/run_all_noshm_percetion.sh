#!/bin/bash

# Desc:  auto start navigation algo process in /oem/catkin_ws/install_isolated/
# Version: 0.1.1
# Time: 2022.02.08

##set -u

#export RUN_PATH="/oem/catkin_ws"
#export MONITOR_PATH="/oem"
#export INSTALL_PATH="$RUN_PATH/install_isolated"
#
## config env
#export ROS_HOME=/userdata/.ros
#source /opt/ros/kinetic/setup.sh
#export LD_LIBRARY_PATH=/opt/ros/kinetic/lib:/usr/share/lib:/oem/catkin_ws/install_isolated/lib
#export PKG_CONFIG_PATH=$PKG_CONFIG_PATH:/oem/catkin_ws/install_isolated/lib/pkgconfig
#export PATH=$PATH:/oem/catkin_ws/install_isolated/bin
#export PYTHONPATH=$PYTHONPATH:/oem/catkin_ws/install_isolated/lib/python2.7/site-packages
#export CMAKE_PREFIX_PATH=$CMAKE_PREFIX_PATH:/oem/catkin_ws/install_isolated
#export ROS_PACKAGE_PATH=/opt/ros/kinetic/share:/oem/catkin_ws/install_isolated/share

## for debug
#export DEBUG=ON
#export NETWORK_INTERFACE=wlan0
#export IPAddress=localhost
#if [ 0"$DEBUG" = "0" ]; then
#  echo "Not run with debug mode, listen localhost"
#else
#  export IPAddress=$(ifconfig $NETWORK_INTERFACE | grep -o 'inet [^ ]*' | cut -d ":" -f2)
#  if [ 0"$IPAddress" = "0" ]; then
#    export IPAddress=localhost
#  fi
#fi

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/novabot_log/


case "$1" in
start)
  echo "starting all navigation apps.... "
  echo "start chassis_control, robot_combination_localization, novabot_bringup pid_controller tof_camera. nodes"
  #killall -q -15 python
  #killall -q -15 ros2
  killall -q -9 robot_combination_localization
  killall -q -9 pid_controller
  killall -q -9 chassis_control
  killall -q -9 novabot_navigation
  killall -q -9 lifecycle_manager
  killall -q -9 map_server
  killall -q -9 tof_camera_node
  killall -q -9 novabot_mapping
  killall -q -9 coverage_planner_server
  killall -q -9 robot_state_publisher
  killall -q -9 navigation_to_localization_init_node
  killall -q -9 path_record_server
  killall -q -9 coverage_planner_server
  killall -q -9 robot_state_publisher
  killall -q -9 compound_decision_node
  killall -q -9 mqtt_node
  killall -q -9 auto_recharge_server
  killall -q -9 automatic_recharge
  killall -q -9 bt_navigator
  killall -q -9 camera_307_preposition
  killall -q -9 waypoint_follower
  killall -q -9 recoveries_server
  killall -q -9 camera_307_panoramic
  killall -q -9 camera_307_cap
  killall -q -9 nav2_single_node_navigator
  killall -q -9 perception_node
  killall -q -9 aruco_localization
  sleep 1s
  #export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  #export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py  use_shm:=false &
  #unset RMW_IMPLEMENTATION
  #unset CYCLONEDDS_URI
  #sleep 1s
  ros2 launch aruco_localization aruco_localization.launch.py  &
  ros2 launch perception_node perception_node.launch.py pub_debug_image:=False &
  ros2 launch chassis_control novabot_chassis_start.launch.py   use_sim_time:=False&
  ros2 launch robot_combination_localization localization_only.launch.py use_sim_time:=False &
  ros2 launch nav2_single_node_navigator nav2_perception_navigator.launch.py use_sim_time:=False &
  ros2 launch tof_camera tof_camera.launch.py &
  ros2 launch novabot_mapping novabot_mapping_launch.py &
  ros2 launch coverage_planner coverage_planner_server.launch.py &
  ros2 launch navigation_to_localization_init navigation_to_localization_init.launch.py use_sim_time:=False &
  ros2 launch path_record path_record.launch.py record_with_start:=True   use_sim_time:=False &
  ros2 launch automatic_recharge automatic_recharge_launch.py  use_sim_time:=False &
  ros2 launch novabot_api novabot_api_node.py &
  ros2 run compound_decision compound_decision_node &
  

  



  ;;

stop)
  echo "stopping.... "
  killall -q -9 robot_combination_localization
  killall -q -9 pid_controller
  killall -q -9 chassis_control
  killall -q -9 novabot_navigation
  killall -q -9 lifecycle_manager
  killall -q -9 map_server
  killall -q -9 tof_camera_node
  killall -q -9 novabot_mapping
  killall -q -9 coverage_planner_server
  killall -q -9 robot_state_publisher
  killall -q -9 navigation_to_localization_init_node
  killall -q -9 path_record_server
  killall -q -9 coverage_planner_server
  killall -q -9 robot_state_publisher
  killall -q -9 compound_decision_node
  killall -q -9 mqtt_node
  killall -q -9 aruco_localization
  killall -q -9 auto_recharge_server
  killall -q -9 bt_navigator
  killall -q -9 camera_307_preposition
  killall -q -9 waypoint_follower
  killall -q -9 recoveries_server
  killall -q -9 camera_307_panoramic
  killall -q -9 camera_307_cap
  killall -q -9 nav2_single_node_navigator
  killall -q -9 perception_node
  killall -q -9 aruco_localization
  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac

exit 0
