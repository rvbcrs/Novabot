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
TIMER_RECORD_LOG=/root/novabot/data/ros2_log/timer_record_$DATE.log 

camera_307_preposition_status=1
perception_node_status=1
aruco_localization_status=1
out_of_chunks_str="MEPOO__MEMPOOL_GETCHUNK_POOL_IS_RUNNING_OUT_OF_CHUNKS"
occurred_str="internal logic error"

upload_log_Time=`date -d "6 hours" +"%Y%m%d%H%M%S"`
synchronize_time=0
restart_count=0
timer_record_count=1
current_record_time=1
last_record_time=1


camera_monitor()
{

    # killall -q -9 camera_307_cap
    # killall -q -9 aruco_localization
    # killall -q -9 perception_node
    # killall -q -2 iox-roudi
    # ros2 topic hz /camera/preposition/image_shm_half

    camera_307_preposition_status=$(ps aux | grep -i "/root/novabot/install/camera_307_cap/lib/camera_307_cap/camera_307_cap --ros-args -r __node:=camera_307_preposition " | grep -v "grep" | wc -l)
    aruco_localization_status=$(ps aux | grep -i "/root/novabot/install/aruco_localization/lib/aruco_localization/aruco_localization" | grep -v "grep" | wc -l)
    perception_node_status=$(ps aux | grep -i "/root/novabot/install/perception_node/lib/perception_node/perception_node" | grep -v "grep" | wc -l)
    cur_date=`date +%Y%m%d_%H%M%S`
    novabot_shared_mem_pid=$(ps aux | grep -i "novabot_shared_mem.launch.py" | grep -v "grep" | awk -F' ' '{print $2}')

    
    if [ ${camera_307_preposition_status} -eq 1 ] && [ ${aruco_localization_status} -eq 1 ]  && 
                [ ${perception_node_status} -eq 1 ] && [ `grep -c "$out_of_chunks_str" $ROS_LOG_DIR/novabot_shared_mem.log` -eq '0' ] && [ `grep -c "$occurred_str" $ROS_LOG_DIR/novabot_shared_mem.log` -eq '0' ] &&
                [ `grep -c "ICEORYX error" $ROS_LOG_DIR/novabot_shared_mem.log` -eq '0' ]; then

        echo "$cur_date  camera_307_preposition_status  aruco_localization_status   perception_node_status is normal "
    else

        echo " " >> $MONITOR_LOG 
        echo "$cur_date camera_307_preposition_status: $camera_307_preposition_status    aruco_localization_status: $aruco_localization_status   perception_node_status: $perception_node_status "  >> $MONITOR_LOG
        
        restart_count=`expr $restart_count + 1`
        if [ $restart_count -gt 10 ]; then

            echo "restart_count: $restart_count > 10 , not restart iox-roudi , please check camera hardware"  >> $MONITOR_LOG 
            # kill -9 $novabot_shared_mem_pid
            # killall -w -2 iox-roudi
            return 0
        fi

        # export TERM=xterm

        # IOX_LOG=/root/novabot/data/iox-introspection-client_$cur_date.log
        # echo "*****************$cur_date**********************" >> $IOX_LOG
        # iox-introspection-client --mempool 2>&1 | tee $IOX_LOG &
        # echo "*****************$cur_date**********************" >> $IOX_LOG
        
        # unset TERM
       
       	# sleep 1s
        # killall -q -9  iox-introspection-client

        if  [ ! -f "$ROS_LOG_DIR/novabot_shared_mem.log"  ];then
            echo "$ROS_LOG_DIR/novabot_shared_mem.log not exits"  >> $MONITOR_LOG
            touch $ROS_LOG_DIR/novabot_shared_mem.log
            #echo "*****************$cur_date**********************" >> $MONITOR_LOG
            #top -b -n 1 | tee >>  $MONITOR_LOG
            #echo "*****************$cur_date**********************" >> $MONITOR_LOG
            #sleep 10s
            return 0
        fi


        
        echo "$cur_date maybe hava $out_of_chunks_str or $occurred_str" >> $MONITOR_LOG
        echo "Please check /root/novabot/data/ros2_log/novabot_shared_mem_xxxxx.log --->  already restart iox-roudi   restart_count: $restart_count"  >> $MONITOR_LOG
        ros2 topic pub --once /system/shared_memory_error  std_msgs/msg/Bool "{data : true}"

        
        killall -q -9 aruco_localization
        killall -q -9 perception_node
        killall -q -9 camera_307_cap
        kill -9 $novabot_shared_mem_pid
        sleep 2s
        killall -w -2 iox-roudi
        
        sleep 1s
 
        cp $ROS_LOG_DIR/novabot_shared_mem.log $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log
        sync
        sleep 3s

        ps -aux | grep aruco_localization  >> $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log
        ps -aux | grep perception_node  >> $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log
        ps -aux | grep camera_307_cap  >> $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log
        ps -aux | grep iox-roudi  >> $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log
        free -m >> $ROS_LOG_DIR/novabot_shared_mem_error_$cur_date.log

        touch $ROS_LOG_DIR/novabot_shared_mem.log
        echo "start novabot_shared_mem $cur_date" > $ROS_LOG_DIR/novabot_shared_mem.log 

        export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
        export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml

        iox-roudi -c /root/novabot/shm_config/shm_ioxroudi.toml --log-level verbose 2>&1 | tee $ROS_LOG_DIR/shm_ioxroudi_restart_$cur_date.log &
        # ps -aux | grep iox-roudi  >> $ROS_LOG_DIR/shm_ioxroudi_restart_$cur_date.log
        # free -m >> $ROS_LOG_DIR/shm_ioxroudi_restart_$cur_date.log


        sleep 2s

        ros2 launch  novabot_system_launch novabot_shared_mem.launch.py >> $ROS_LOG_DIR/novabot_shared_mem.log &

        
        unset RMW_IMPLEMENTATION
        unset CYCLONEDDS_URI


    fi

}


timer_upload_log()
{

    #检查是否进行了网络时间同步
    if [ `timedatectl | grep -c "System clock synchronized: yes"` -eq '1' ] && [ `timedatectl | grep -c "NTP service: active"` -eq '1' ]; then
        upload_log_Time=`date -d "6 hours" +"%Y%m%d%H%M%S"`
        #upload_log_Time=`date -d "1 minutes" +"%Y%m%d%H%M%S"`
        timedatectl set-ntp false

        synch_cur_time=`date +%Y%m%d%H%M%S`
        echo "next upload_log_Time:$upload_log_Time       synch_cur_time:$synch_cur_time"   >> $MONITOR_LOG
    fi


    #检查磁盘容量小于1000 清除相关的日志
    available_emmc_min_size=1000    # 单位 M
    available_emmc_size=$(df -m | grep "/dev/root" | awk -F' ' '{print $4}')
    if [ $available_emmc_size -lt  $available_emmc_min_size ]; then

        echo "available_emmc_size: $available_emmc_size   available_emmc_min_size: $available_emmc_min_size Insufficient storage space"   >> $MONITOR_LOG

        rm /root/novabot/*.zip
        rm /root/novabot.bak/*.zip

        echo "rm /root/novabot/*.zip"  >> $MONITOR_LOG
        echo "rm /root/novabot.bak/*.zip"  >> $MONITOR_LOG


        if [ -d "/root/novabot/data" ]; then
            rm  -rf /root/novabot/data/*  
            echo "rm  -rf /root/novabot/data/* "  >> $MONITOR_LOG
        fi

        if [ -d "/root/novabot.bak/data" ]; then
            rm  -rf /root/novabot.bak/data/*  
            echo "rm  -rf /root/novabot.bak/data/* "  >> $MONITOR_LOG
        fi

        if [ -d "/media/image" ]; then
            rm  -rf /media/image/*  
            echo "rm  -rf /media/image/* "  >> $MONITOR_LOG
        fi

        if [ -d "/var/log/" ]; then
            rm  -rf /var/log/*   
            echo "rm  -rf /var/log/*  " >> $MONITOR_LOG
        fi

        df -h  >> $MONITOR_LOG

    fi


    if [ -d "/media/image" ]; then
        MEDIA_MAXSIZE=$((100*1024))
        media_size=$(du /media/image/ -s | awk '{ print $1}')
        if [ $media_size -gt $MEDIA_MAXSIZE ]; then                   #/meida/image 超过100M 清空         
            echo "/media/image/ bigger to $MEDIA_MAXSIZE" >> $MONITOR_LOG
            rm  -rf /media/image/*  
            echo "rm  -rf /media/image/* "  >> $MONITOR_LOG
        fi
    fi


    if [ -d "$ROS_LOG_DIR" ]; then
        ROS_LOG_DIR_MAXSIZE=$((500*1024))
        ros2_log_size=$(du $ROS_LOG_DIR -s | awk '{ print $1}')
        if [ $ros2_log_size -gt $ROS_LOG_DIR_MAXSIZE ]; then                   #/root/novabot/data/ros2_log 超过500M         
            echo "$ros2_log_size bigger to $ROS_LOG_DIR_MAXSIZE" >> $MONITOR_LOG
            find  /root/novabot/data/ros2_log  -mtime +3 -print | xargs rm -rf  # 删除 /root/novabot/data  下三天前的文件夹和文件

        fi
    fi

  


    #定时上传日志
    current_time=`date +%Y%m%d%H%M%S`
    # echo "current_time:$current_time        upload_log_Time:$upload_log_Time "  >> $MONITOR_LOG
    if [ $current_time -ge $upload_log_Time ]; then
        echo "current_time:$current_time   upload_log_Time:$upload_log_Time  upload /x3/log/upload "  >> $MONITOR_LOG
        ros2 topic pub --once  /x3/log/upload std_msgs/msg/UInt8 "{data : 1}"
        upload_log_Time=`date -d "6 hours" +"%Y%m%d%H%M%S"`
        # upload_log_Time=`date -d "1 minutes" +"%Y%m%d%H%M%S"`

       # timedatectl set-ntp true

    fi




}


timer_record_log_fun()
{
    sleep 1s

    timer_record_count=`expr $timer_record_count + 1`
    current_record_time=`date "+%Y-%m-%d %H:%M:%S"`
    #time_diff=`expr $current_record_time - $last_record_time`
    duration=`echo $(($(date +%s -d "${current_record_time}") - $(date +%s -d "${last_record_time}"))) | awk '{t=split("60 s 60 m 24 h 999 d",a);for(n=1;n<t;n+=2){if($1==0)break;s=$1%a[n]a[n+1]s;$1=int($1/a[n])}print s}'`

    if [ $duration != "1s" ] && [ $duration != "2s" ] ; then
        echo "The time jump abnormal $duration"   >>  $TIMER_RECORD_LOG
        systemctl status systemd-timesyncd >>  $TIMER_RECORD_LOG
         
    fi
    echo "$current_record_time    duration: $duration "  >>  $TIMER_RECORD_LOG
    last_record_time=$current_record_time
    
}








echo "***************************************************"  >> $MONITOR_LOG
echo "$DATE start daemon_monitor"  >> $MONITOR_LOG
touch $TIMER_RECORD_LOG


while true
do
    timer_record_log_fun

    if [ $timer_record_count -gt 10 ]; then
        
        camera_monitor   #相机监控

        timer_upload_log

        timer_record_count=1
    fi

done

