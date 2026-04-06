#!/bin/bash

#所有启动脚本

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log
DATE=`date +%Y%m%d_%H%M`

#禁用多机通信
ip link set lo multicast on
export ROS_LOCALHOST_ONLY=1
#export ROS_DOMAIN_ID=111

DATE_DIR=`date +%Y%m%d%h%m%s`
LOGS_PATH=/root/novabot/novabot_log/$DATE_DIR
#如果文件夹不存在，创建文件夹
if [ ! -d "$LOGS_PATH" ]; then

    mkdir $LOGS_PATH
fi



case "$1" in
start)
  echo "************* starting all node ***************** " >> /root/novabot/data/timedatectl.log
  timedatectl >> /root/novabot/data/timedatectl.log

  # echo "starting x3Check.... "
  # /root/novabot/install/x3_boot_check/x3_boot_check &
  # ros2 launch x3_running_check x3_running_check.launch.py &


#  ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=False  >> $ROS_LOG_DIR/all_camera_$DATE.log &  #非共享内存方式运行全景

  echo "************* $DATE start tof ********************" > $ROS_LOG_DIR/all_camera_$DATE.log
  ros2 launch tof_camera tof_camera.launch.py  >> $ROS_LOG_DIR/all_camera_$DATE.log  &
  sleep 2s

  export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
  iox-roudi -c /root/novabot/shm_config/shm_ioxroudi.toml --log-level verbose >> $ROS_LOG_DIR/shm_ioxroudi_$DATE.log &

  sleep 3s
  #ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=True  >> $ROS_LOG_DIR/all_camera_$DATE.log &   #共享内存方式运行全景
  ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=True  >> $ROS_LOG_DIR/all_camera_$DATE.log &  #共享内存方式运行前置

  sleep 3s 

  ros2 launch perception_node perception_node_shm.launch.py pub_debug_image:=False use_mult_thread:=True >> $ROS_LOG_DIR/perception_node_shm_$DATE.log &
  
  sleep 3s
  ros2 launch aruco_localization aruco_localization.launch.py &

  gdc_flag=$(grep "flag=" /root/novabot/test_scripts/factory_test/start_test.sh | awk -F= '{print $2}')
  if [ "$gdc_flag" == "true" ]; then

    ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=False  >> $ROS_LOG_DIR/all_camera_$DATE.log &  #非共享内存方式运行全景

    echo "start frocktool_server" > $ROS_LOG_DIR/frocktool_server.log
    ros2 launch frocktool_server frocktool_server.launch.py >> $ROS_LOG_DIR/frocktool_server.log &

  fi

  unset RMW_IMPLEMENTATION
  unset CYCLONEDDS_URI



  echo "starting navigation.... "
  
  ros2 launch nav2_single_node_navigator nav2_perception_navigator.launch.py use_sim_time:=False &
  sleep 2s
  ros2 launch coverage_planner coverage_planner_server.launch.py &
  sleep 2s
  ros2 launch novabot_mapping novabot_mapping_launch.py &
  #ros2 launch novabot_mapping novabot_mapping_launch.py >> $LOGS_PATH/mapping.log&

  #sleep 2s
  #ros2 launch navigation_to_localization_init navigation_to_localization_init.launch.py use_sim_time:=False &
  sleep 2s
  ros2 launch automatic_recharge automatic_recharge_launch.py  use_sim_time:=False &
  sleep 2s
  ros2 launch robot_combination_localization localization_only.launch.py &
  sleep 2s

  ros2 launch chassis_control novabot_chassis_start.launch.py &

  sleep 2s
  ros2 launch novabot_api novabot_api_node.py & 
  sleep 2s
  #ros2 launch compound_decision compound_decision_node.py >>$LOGS_PATH/decision.log&
  ros2 launch compound_decision compound_decision_node.py &
  
  sleep 1s
  ros2 run daemon_process daemon_node &
  sleep 1s
  #ros2 run autosys_monitor autosys_monitor &
  sleep 2s
  ros2 launch log_manager log_manager.launch.py >> $ROS_LOG_DIR/log_manager_$DATE.log &
  sleep 2s
  ros2 run autosys_monitor autosys_monitor &

  #工装工具启动脚本
  /root/novabot/test_scripts/factory_test/start_test.sh &

  STATUS=$(ps aux | grep -i "daemon_monitor.sh" | grep -v "grep" | wc -l)
  if [ ${STATUS} -ge 1 ]; then
      echo "/root/novabot/scripts/daemon_monitor.sh is running " >> $ROS_LOG_DIR/log_manager_$DATE.log 
  else
      /root/novabot/scripts/daemon_monitor.sh  &
  fi

  timedatectl show-timesync >> /root/novabot/data/timedatectl.log
  timedatectl >> /root/novabot/data/timedatectl.log
  echo "************* end all node ***************** " >> /root/novabot/data/timedatectl.log



  
  ;;
stop)
  echo "stopping all node .... "

  killall -q -9 daemon_node
  
  killall -q -2 iox-roudi
  
  killall -q -9 x3_running_check
  killall -q -9 tof_camera_node
  killall -q -9 camera_307_cap

  killall -q -9 chassis_control
  killall -q -9 mqtt_node

  killall -q -15 perception_node
  killall -q -9 perception_node

  killall -q -15 robot_combination_localization
  killall -q -9 robot_combination_localization
  killall -q -15 aruco_localization
  killall -q -9 aruco_localization


  killall -q -9 pid_controller
  killall -q -9 novabot_navigation
  killall -q -9 lifecycle_manager
  killall -q -9 map_server
  killall -q -9 novabot_mapping
  killall -q -9 coverage_planner_server
  killall -q -9 robot_state_publisher
  killall -q -9 navigation_to_localization_init_node
  killall -q -9 path_record_server
  killall -q -9 compound_decision_node
  killall -q -9 automatic_recharge
  killall -q -9 bt_navigator
  killall -q -9 waypoint_follower
  killall -q -9 recoveries_server
  killall -q -9 nav2_single_node_navigator
  killall -q -9 auto_recharge_server
  killall -q -9 LogNode

  killall -q -9 daemon_monitor.sh
  killall -q -9 autosys_monitor
  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac



