#!/bin/bash

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH
export ROS_LOG_DIR=/root/novabot/data/ros2_log
OTA_DIR=/userdata/ota
ip link set lo multicast on
export ROS_LOCALHOST_ONLY=1

#export ROS_DOMAIN_ID=111

log_manager()
{
    #更新novabot 时区
    if [ -f "/userdata/ota/novabot_timezone.txt" ]; then
        novabot_timezone=`cat /userdata/ota/novabot_timezone.txt`
        echo "set-timezone $novabot_timezone "
        sed -ie 's/#NTP=/NTP=ntp.ubuntu.com ntp1.aliyun.com/g'   /etc/systemd/timesyncd.conf
        #systemctl status systemd-timesyncd
        timedatectl set-timezone "$novabot_timezone"
    fi
    
    timedatectl set-ntp true

    if [ ! -d "/userdata/lfi/charging_station_file" ]; then
      
      mkdir -p /userdata/lfi/charging_station_file
    fi
 
    if [ -f "/userdata/lfi/charging_station_file/charging_station.yaml" ]; then
	    echo "charging_station.yaml exists" >> $OTA_DIR/ota_client.log
    else	    
	    cp /root/novabot/install/novabot_mapping/share/novabot_mapping/charging_station_file/charging_station.yaml   /userdata/lfi/charging_station_file
    fi
    
    mkdir -p /root/novabot/data/log
    mkdir -p /root/novabot/data/ros2_log
    

    MAXSIZE=$((10*1024*1024))

    if [ -d "$ROS_LOG_DIR" ]; then
        find  /root/novabot/data/ros2_log  -mtime +3 -print | xargs rm -rf  # 删除 /root/novabot/data  下三天前的文件夹和文件
    else
        echo "There is no file ${ROS_LOG_DIR} directory"
    fi

    journalctl --vacuum-size=10M                          #清除 /var/log/journal 下大于10M的log


    filesize=$(ls -l /var/log/syslog | awk '{ print $5}') #获取文件本身大小
    echo $filesize
    echo $MAXSIZE
    if [[ $filesize -gt $MAXSIZE ]];then                  #判断文件是否大于某个内存大小，
        echo "/var/log/syslog bigger to $MAXSIZE"         #syslog日志超过10M 清空
        cat /dev/null > /var/log/syslog
    
    fi

    #cp /var/log/kern.log  /root/novabot/data/              #保存内核日志到 /root/novabot/data/ 目录
    filesize=$(ls -l /var/log/kern.log | awk '{ print $5}')   
    if [ $filesize -gt $MAXSIZE ]; then                   #kern.log日志超过10M 清空         
        echo "/var/log/kern.log bigger to $MAXSIZE" 
        cat /dev/null > /var/log/kern.log 
    fi

    rm $ROS_LOG_DIR/python3_*.log   # 删除/root/novabot/data/ros2_log/python3_* 的空日志

}



upgrade(){
    ota_path="/root/novabot" ##current app path
    ota_bak_path="/root/novabot.new" ## deb package extract to this path 
    config_file="/userdata/ota/upgrade.txt"

    echo "ota_bak_path:  $ota_bak_path "  >> $OTA_DIR/ota_client.log
    echo "ota_bak_path:  $ota_bak_path "  >> $OTA_DIR/ota_client.log
    echo "config_file:   $config_file "  >> $OTA_DIR/ota_client.log

    if [ ! -d $ota_bak_path ] || [ ! -f $config_file ]; then
        echo "file not exist"  >> $OTA_DIR/ota_client.log
        return 1
    fi

    flag=`cat $config_file`
    if [[ 1 -ne $flag ]]; then
        echo "upgrade flag: $flag " >> $OTA_DIR/ota_client.log
        return 1
    fi

    ## replace folder
    echo "mv $ota_path to ${ota_path}.bak" >> $OTA_DIR/ota_client.log
    rm -rf ${ota_path}.bak
    mv $ota_path ${ota_path}.bak
    echo "cp $ota_bak_path to $ota_path"  >> $OTA_DIR/ota_client.log
    cp -rfp  $ota_bak_path $ota_path
    
    sync
    
    echo "replace charging_station_file  csv_files  maps" >> $OTA_DIR/ota_client.log
    
    if [ -d "${ota_path}.bak" ]; then
        rm -rf $ota_path/install/novabot_mapping/share/novabot_mapping/charging_station_file 
        rm -rf $ota_path/install/novabot_mapping/share/novabot_mapping/csv_files  
        rm -rf $ota_path/install/novabot_mapping/share/novabot_mapping/maps  

        cp -rf ${ota_path}.bak/install/novabot_mapping/share/novabot_mapping/charging_station_file  $ota_path/install/novabot_mapping/share/novabot_mapping/
        cp -rf ${ota_path}.bak/install/novabot_mapping/share/novabot_mapping/csv_files    $ota_path/install/novabot_mapping/share/novabot_mapping/
        cp -rf ${ota_path}.bak/install/novabot_mapping/share/novabot_mapping/maps    $ota_path/install/novabot_mapping/share/novabot_mapping/
    else
        echo "There is no file ${ota_path}.bak directory"  >> $OTA_DIR/ota_client.log

    fi
    
    echo "launch start_service.sh  start " >> $OTA_DIR/ota_client.log

    bash /root/novabot/scripts/start_service.sh  not_start >> $OTA_DIR/ota_client.log 
    
    echo "launch start_service.sh  finish" >> $OTA_DIR/ota_client.log


    if [ -d "/root/novabot/ota_lib/bcm" ]; then
        echo "replace_wifi_driver" >> $OTA_DIR/ota_client.log
        /root/novabot/ota_lib/bcm/replace_wifi_driver.sh &
        sync
        sleep 2s
    else
        echo "/root/novabot/ota_lib/bcm is not exist!"
    fi


    sleep 5s
    
    filesize=$(ls -l /root/novabot/scripts/run_novabot.sh | awk '{ print $5}') 
    if [ ! -f "/root/novabot/scripts/run_novabot.sh" ] || [  $filesize -eq 0 ]; then

        echo "/root/novabot/scripts/run_novabot.sh is not exist or filesize: $filesize!" >> $OTA_DIR/ota_client.log  
        echo "***********************/root/novabot*****************************" >> $OTA_DIR/ota_client.log 
        du /root/novabot >> $OTA_DIR/ota_client.log  
        ls -lah  /root/novabot/scripts >> $OTA_DIR/ota_client.log
        cat /root/novabot/Readme.txt >> $OTA_DIR/ota_client.log


        echo " "  >> $OTA_DIR/ota_client.log 

        echo "***********************/root/novabot.new*****************************" >> $OTA_DIR/ota_client.log 
        du /root/novabot.new >> $OTA_DIR/ota_client.log  
        ls -lah  /root/novabot.new/scripts >> $OTA_DIR/ota_client.log
        cat /root/novabot.new/Readme.txt >> $OTA_DIR/ota_client.log

        echo "Roll back the previous version  cp -rfp /root/novabot.bak /root/novabot "  >> $OTA_DIR/ota_client.log 
        rm -rf  /root/novabot
        cp -rfp /root/novabot.bak /root/novabot
        sync
        sleep 2s

        rm -rf /root/novabot.new  
        echo "Roll back /root/novabot.bak /root/novabot  success !  delete /root/novabot.new  "  >> $OTA_DIR/ota_client.log 

        cp $OTA_DIR/ota_client.log  $OTA_DIR/ota_client_error.log  
        cp $OTA_DIR/ota_client_error.log   $ota_path/data
        return 1
    fi



    echo "0" > $config_file
    sync
    flag=`cat $config_file`
    if [[ 0 -eq $flag ]]; then
        echo "upgrade finished" >> $OTA_DIR/ota_client.log  
    else
        echo "upgrade failed" >> $OTA_DIR/ota_client.log  
    fi
 
    rm -rf $ota_bak_path
    echo "reset $config_file" >> $OTA_DIR/ota_client.log  
    echo "delete $ota_bak_path" >> $OTA_DIR/ota_client.log  
    sync
    reboot -f
    
}

case "$1" in
start)

  if [ ! -f "$OTA_DIR/ota_client.log" ]; then
    touch $OTA_DIR/ota_client.log 
  fi

  echo "--------------------------------------------------------" >> $OTA_DIR/ota_client.log 

  timedatectl  >> $OTA_DIR/ota_client.log 

  log_manager  # 日志管理
  
  sleep 2s

  upgrade      # ota 升级
  
  ros2 launch ota_client ota_client.launch.py &  


  DATE_DIR=`date +%Y%m%d%h%m%s`
  touch $ROS_LOG_DIR/mqtt_error_$DATE_DIR.log
  ros2 launch novabot_api novabot_api_node.py  >> $ROS_LOG_DIR/mqtt_error_$DATE_DIR.log &
  
  sleep 2s

  ;;
stop)
  echo "stopping ota.... "
  killall -q -9 ota_client
  killall -q -9 mqtt_node

  ;;
*)
  echo "Usage: $0 {start|stop|}"
  exit 1
  ;;
esac



