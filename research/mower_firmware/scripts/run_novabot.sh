#!/bin/bash

#所有启动脚本

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log
DATE=`date +%Y%m%d_%H%M`

#禁用多机通信
ip link set lo multicast on
export ROS_LOCALHOST_ONLY=1

DATE_DIR=`date +%Y%m%d%h%m%s`
LOGS_PATH=/root/novabot/novabot_log/$DATE_DIR
#如果文件夹不存在，创建文件夹
if [ ! -d "$LOGS_PATH" ]; then

    mkdir $LOGS_PATH
fi

# 指定要检查的文件夹路径，删除多余的bin（hybrid astar预计算）文件
target_dir="/userdata"

# 获取目标文件夹下非隐藏文件的数量（不包括子目录）
file_count=$(find "$target_dir" -maxdepth 1 -type f ! -name ".*bin" | wc -l)

# 判断文件数量是否大于2个
if [ "$file_count" -gt 2 ]; then
    echo "文件数量大于2个，开始删除 .bin 文件..."

    # 删除目标文件夹下所有 .bin 文件
    find "$target_dir" -maxdepth 1 -type f -name "*.bin" -delete

    echo "删除操作完成。"
else
    echo "文件数量未超过2个，无需删除 .bin 文件。"
fi


case "$1" in
start)

  echo "************* starting all node ***************** " >> /root/novabot/data/timedatectl.log
  timedatectl >> /root/novabot/data/timedatectl.log
  echo "performance" > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
  echo 1 > /sys/devices/system/cpu/cpufreq/boost

  touch $ROS_LOG_DIR/novabot_shared_mem.log
  touch $ROS_LOG_DIR/shm_ioxroudi_$DATE.log 

  export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
  iox-roudi -c /root/novabot/shm_config/shm_ioxroudi.toml --log-level verbose 2>&1 | tee $ROS_LOG_DIR/shm_ioxroudi_$DATE.log &
  
  echo "start novabot_shared_mem $DATE_DIR" >> $ROS_LOG_DIR/novabot_shared_mem.log 
  ros2 launch  novabot_system_launch novabot_shared_mem.launch.py >> $ROS_LOG_DIR/novabot_shared_mem.log &
  # ros2 launch  novabot_system_launch novabot_shared_mem_vio.launch.py  &
  unset RMW_IMPLEMENTATION
  unset CYCLONEDDS_URI

  ros2 launch novabot_system_launch novabot_system.launch.py &
  ros2 launch novabot_mapping novabot_mapping_launch.py >> $ROS_LOG_DIR/novabot_mappning_debug_$DATE.log  &
  #ros2 launch novabot_system_launch novabot_system.launch.py >> $ROS_LOG_DIR/novabot_system_$DATE.log &
  # ros2 launch novabot_system_launch novabot_system_vio.launch.py &
  echo "start tof_camera $DATE_DIR" > $ROS_LOG_DIR/tof_camera_$DATE.log 
  ros2 launch royale_platform_driver  tof_camera.launch.py >> $ROS_LOG_DIR/tof_camera_$DATE.log  &
  
  #工装工具启动脚本
  /root/novabot/test_scripts/factory_test/start_test.sh &

  STATUS=$(ps aux | grep -i "daemon_monitor.sh" | grep -v "grep" | wc -l)
  if [ ${STATUS} -ge 1 ]; then
      echo "/root/novabot/scripts/daemon_monitor.sh is running "
  else
      /root/novabot/scripts/daemon_monitor.sh  &
  fi




  timedatectl show-timesync >> /root/novabot/data/timedatectl.log
  timedatectl >> /root/novabot/data/timedatectl.log
  
  echo "************* ending all node ***************** " >> /root/novabot/data/timedatectl.log

  ;;
stop)
  echo "stopping all node .... "
  killall -q -9 ros2
  killall -q -2 iox-roudi

  killall -q -9 x3_running_check
  killall -q -9 tof_camera_node
  killall -q -9 pmd_royale_ros_main
  killall -q -9 camera_307_cap

  killall -q -9 chassis_control
  # killall -q -9 mqtt_node

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
  killall -q -9 robot_decision
  killall -q -9 daemon_monitor.sh
  killall -q -9 autosys_monitor
  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac



