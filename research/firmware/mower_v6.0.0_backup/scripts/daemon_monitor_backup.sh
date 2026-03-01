#!/bin/bash

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log
ip link set lo multicast on
export ROS_LOCALHOST_ONLY=1

DATE=`date +%Y%m%d_%H%M%S`
MONITOR_LOG=/root/novabot/data/camera_daemon_monitor.log 

camera_307_preposition_status=1
perception_node_status=1
aruco_localization_status=1




camera_monitor()
{

    # killall -q -9 camera_307_cap
    # killall -q -9 aruco_localization
    # killall -q -9 perception_node
    # killall -q -2 iox-roudi

    camera_307_preposition_status=$(ps aux | grep -i "/root/novabot/install/camera_307_cap/lib/camera_307_cap/camera_307_cap --ros-args -r __node:=camera_307_preposition " | grep -v "grep" | wc -l)
    aruco_localization_status=$(ps aux | grep -i "/root/novabot/install/aruco_localization/lib/aruco_localization/aruco_localization" | grep -v "grep" | wc -l)
    perception_node_status=$(ps aux | grep -i "/root/novabot/install/perception_node/lib/perception_node/perception_node" | grep -v "grep" | wc -l)

    cur_date=`date +%Y%m%d_%H%M%S`
    
    if [ ${camera_307_preposition_status} -eq 1 ] && [ ${aruco_localization_status} -eq 1 ]  && [ ${perception_node_status} -eq 1 ]; then
        echo "$cur_date  camera_307_preposition_status  aruco_localization_status   perception_node_status is normal "
    else

        export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
        export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml

        echo "************************************************************* " >> $MONITOR_LOG  
        cur_date=`date +%Y%m%d_%H%M%S`

        if [ ${camera_307_preposition_status} -lt 1 ]; then
            echo "$cur_date  camera_307_preposition is not running, restart camera_307_preposition_node" >> $MONITOR_LOG
            ros2 launch camera_307_cap camera_307_preposition_node.launch.py use_shm:=True  >> $ROS_LOG_DIR/camera_307_preposition_shm_restart_$cur_date.log &  #共享内存方式运行前置
            
        fi


        if [ ${aruco_localization_status} -lt 1 ]; then
            echo "$cur_date  aruco_localization is not running, restart aruco_localization " >> $MONITOR_LOG
            ros2 launch aruco_localization aruco_localization.launch.py  >> $ROS_LOG_DIR/aruco_localization_shm_restart_$cur_date.log &
            
        fi

        if [ ${perception_node_status} -lt 1 ]; then
            echo "$cur_date  perception_node is not running, restart perception_node_shm" >> $MONITOR_LOG
            ros2 launch perception_node perception_node_shm.launch.py pub_debug_image:=False use_mult_thread:=True >> $ROS_LOG_DIR/perception_node_shm_restart_$cur_date.log &
            
        fi

        echo "************************************************************* " >> $MONITOR_LOG  

        unset RMW_IMPLEMENTATION
        unset CYCLONEDDS_URI
    fi

}


timer_upload_log()
{
    current_time=`date +%H%M%S`
    if [ $current_time -ge 180000 -a $current_time -le 180030 ]; then
        echo "$DATE upload /x3/log/upload "  >> $MONITOR_LOG
        ros2 topic pub --once  /x3/log/upload std_msgs/msg/UInt8 "{data : 1}"

    fi

}






echo "***************************************************"  >> $MONITOR_LOG
echo "$DATE start daemon_monitor"  >> $MONITOR_LOG


while true
do
    sleep 30s
    
    camera_monitor   #相机监控

    timer_upload_log

done

