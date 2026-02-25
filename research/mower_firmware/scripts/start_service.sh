#!/bin/bash
path=/userdata/ota

## copy upgrade file to system
cp /root/novabot/ota_lib/lib/profile /etc/
## copy lib file to /usr/local/lib
cp /root/novabot/ota_lib/lib/libimx307preposition.so /lib/sensorlib/
cp /root/novabot/ota_lib/lib/libimx307_linear.so  /lib/sensorlib/
cp /root/novabot/ota_lib/lib/libimx307panoramic_linear.so  /lib/sensorlib/
cp /root/novabot/ota_lib/lib/libimx307preposition_linear.so  /lib/sensorlib/
cp /root/novabot/ota_lib/lib/libirs2875c_pmd.so  /lib/sensorlib/
cp /root/novabot/ota_lib/lib/liblog_wrapper.so  /usr/local/lib/

# -f 参数判断 $file 是否存在
if [ ! -f "/usr/lib/aarch64-linux-gnu/libdbus-1.so" ]; then
  ln -s /usr/lib/aarch64-linux-gnu/libdbus-1.so.3 /usr/lib/aarch64-linux-gnu/libdbus-1.so
fi

#更新novabot 时区
if [ -f "/userdata/ota/novabot_timezone.txt" ]; then
    novabot_timezone=`cat /userdata/ota/novabot_timezone.txt`
    echo "set-timezone $novabot_timezone "
    sed -ie 's/#NTP=/NTP=ntp.ubuntu.com ntp1.aliyun.com/g'   /etc/systemd/timesyncd.conf
    #systemctl status systemd-timesyncd
    timedatectl set-timezone "$novabot_timezone"
fi


#使用旧版本tof 则删除 新的
if [ -d "/root/novabot/install/tof_camera" ]; then
    cp /root/novabot/ota_lib/lib/libspectre.so  /lib/sensorlib/
    rm -rf /root/novabot/install/royale_platform_driver
else
    echo "/root/novabot/install/tof_camera not exist"  >> $path/start_service.log 
fi

if [ -d "/root/novabot/install/royale_platform_driver" ]; then
    rm /lib/sensorlib/libspectre.so
    rm -rf /root/novabot/install/tof_camera
else
    echo "/root/novabot/install/royale_platform_driver not exist"  >> $path/start_service.log 
fi

if [ -f "/root/novabot/ota_lib/install_deb/install_deb.sh" ]; then
    echo "install other deb"  >> $path/start_service.log 
    /root/novabot/ota_lib/install_deb/install_deb.sh
fi




# 兼容旧版本，如果不存在文件则生成 /userdata/lfi/camera_params 和/userdata/lfi/camera_params/gdc_map_preposition.txt
# if [ -d "/userdata/lfi/camera_params" ]; then
#     echo "/userdata/lfi/camera_params is already exist!"
# else
#     echo "cp -rf /root/novabot/ota_lib/camera_params  /userdata/lfi/ "
#     cp -rf /root/novabot/ota_lib/camera_params  /userdata/lfi/ 
# fi

# if [ ! -f "/userdata/lfi/camera_params/layout_preposition.json" ]; then
#   cp /root/novabot/ota_lib/camera_params/layout_preposition.json  /userdata/lfi/camera_params/
#   cp /root/novabot/ota_lib/camera_params/gdc_map.py  /userdata/lfi/camera_params/
# fi

# if [ ! -f "/userdata/lfi/camera_params/gdc_map_preposition.txt" ]; then
#   echo "/userdata/lfi/camera_params/gdc_map_preposition.txt is not exist, create it"
#   python3 /userdata/lfi/camera_params/gdc_map.py /userdata/lfi/camera_params/preposition_intrinsic.json /userdata/lfi/camera_params/layout_preposition.json /userdata/lfi/camera_params/gdc_map_preposition.txt
# fi

# # 工装工具重新标定后重新覆盖生成/userdata/lfi/camera_params/gdc_map_preposition.txt 
# gdc_flag=$(grep "flag=" /root/novabot/test_scripts/factory_test/start_test.sh | awk -F= '{print $2}')
# if [ "$gdc_flag" == "false" ]; then  # flag=false  代表机器从工厂中检测通过、并重新覆盖了标定文件

#     if [ ! -f "/userdata/lfi/camera_params/gdc_cover.flag" ]; then 
#         echo "Factory calibration completed, rebuild /userdata/lfi/camera_params/gdc_map_preposition.txt"
#         python3 /userdata/lfi/camera_params/gdc_map.py /userdata/lfi/camera_params/preposition_intrinsic.json /userdata/lfi/camera_params/layout_preposition.json /userdata/lfi/camera_params/gdc_map_preposition.txt
#         touch /userdata/lfi/camera_params/gdc_cover.flag  #此标志文件代表 工装工具重新标定后已经重新覆盖、后续ota 无需再生成
#     fi
# fi



#更新感知所需要的humble版本message_filters
if [ -d "/root/novabot/ota_lib/message_filters" ]; then

    echo "replace /root/novabot/ota_lib/message_filters"
    rm -rf /opt/ros/galactic/include/message_filters
    cp -rf /root/novabot/ota_lib/message_filters/include/message_filters  /opt/ros/galactic/include/
    cp -rf /root/novabot/ota_lib/paho  /usr/local/lib/python3.8/dist-packages/
    cp /root/novabot/ota_lib/message_filters/lib/libmessage_filters.so  /opt/ros/galactic/lib/
fi



if [ -d "/usr/local/lib/python3.8/dist-packages/paho" ]; then
    echo "/usr/local/lib/python3.8/dist-packages/paho is already exist!"
else
    cp -rf /root/novabot/ota_lib/paho  /usr/local/lib/python3.8/dist-packages/
fi

echo "--------------------------------------------------------" > $path/start_service.log 
current_time=`date +"%Y-%m-%d %H:%M:%S"`
echo $current_time >>  $path/start_service.log 

echo "****************** df **************" >> $path/start_service.log 
df -h    >> $path/start_service.log 


rm /root/novabot/*.zip
rm /root/novabot.bak/*.zip

echo "rm /root/novabot/*.zip" >> $path/start_service.log 
echo "rm /root/novabot.bak/*.zip" >> $path/start_service.log 


if [ -d "/root/novabot/data" ]; then
    rm  -rf /root/novabot/data/*  
    echo " rm  -rf /root/novabot/data/* " >> $path/start_service.log 
fi

if [ -d "/root/novabot.bak/data" ]; then
    mkdir -p /root/novabot/data
    mv /root/novabot.bak/data/log/ota_client /root/novabot/data/last_ota_client
    echo "mv /root/novabot.bak/data/log/ota_client /root/novabot/data/last_ota_client " >> $path/start_service.log 
    rm  -rf /root/novabot.bak/data/*  
    echo " rm  -rf /root/novabot.bak/data/* " >> $path/start_service.log 
fi

if [ -d "/media/image" ]; then
    rm  -rf /media/image/*  
    echo "rm  -rf /media/image/*   " >> $path/start_service.log 
fi




mkdir -p /userdata/ota
cp /root/novabot/scripts/run_ota.sh /userdata/ota



echo "starting update lib.... " >> $path/start_service.log

# rm /lib/systemd/system/novabot*	
# rm /etc/systemd/system/novabot*	
cp /root/novabot/scripts/*.service /lib/systemd/system/

echo "daemon-reload " >> $path/start_service.log 

systemctl daemon-reload 


#enable
echo "enable novabot_launch.service novabot_ota_launch.service............" >> $path/start_service.log 
systemctl enable  novabot_launch.service   
systemctl enable  novabot_ota_launch.service  

sleep 2s


#卸载相关的库 x11vnc导致平均负载过高
apt purge -y x11vnc
sudo apt install -y dnsmasq 
# # 定义文件名和要搜索的字符串
# filename="/userdata/lfi/json_config.json"
# search_string="LFIN2231000231"

# # 使用grep命令查找字符串，-q选项使grep安静模式，不输出匹配行
# # -E用于解释扩展正则表达式，如果字符串中有特殊字符需要这样使用
# if grep -qE "$search_string" "$filename"; then
#     echo "字符串 '$search_string' 在文件 '$filename' 中找到。"
#     sudo apt install -y dnsmasq 
# else
#     echo "字符串 '$search_string' 在文件 '$filename' 中未找到。"
# fi
filename="/userdata/lfi/json_config.json"
search_string="LFIN2231000486"
OLD_IP="192.168.1.10"
NEW_IP="192.168.1.183"
FILE="/etc/network/interfaces"
if grep -qE "$search_string" "$filename"; then
    # 使用 sed 进行替换
    sudo sed -i "s/address $OLD_IP/address $NEW_IP/g" "$FILE"

    # 检查替换是否成功
    if [ $? -eq 0 ]; then
        echo "IP 地址已成功替换"
    else
        echo "替换过程中出现错误"
    fi
else
    echo "no need"
fi
# if [ "$1" =  "not_start" ];then
#     echo "not start  novabot_launch.service " >> $path/start_service.log 
#     echo "not start   novabot_ota_launch.service  " >> $path/start_service.log 
# else
# #start
#     echo "start novabot_launch.service novabot_ota_launch.service............" >> $path/start_service.log 
#     systemctl start  novabot_launch.service  	 
#     systemctl start  novabot_ota_launch.service 

#     if [ -d "/root/novabot/ota_lib/bcm" ]; then
#         echo "replace_wifi_driver " >> $path/start_service.log 
#         /root/novabot/ota_lib/bcm/replace_wifi_driver.sh
#         reboot -f
#     else
#         echo "/root/novabot/ota_lib/bcm is not exist!" >> $path/start_service.log 
#     fi

# fi


if [ "$1" =  "not_start" ];then
    echo "not_start not replace_wifi_driver " >> $path/start_service.log 
else
    if [ -d "/root/novabot/ota_lib/bcm" ]; then
        echo "replace_wifi_driver " >> $path/start_service.log 
        /root/novabot/ota_lib/bcm/replace_wifi_driver.sh

        echo "start service finish , reboot now" >> $path/start_service.log 

        reboot -f
    else
        echo "/root/novabot/ota_lib/bcm is not exist!" >> $path/start_service.log 
    fi

fi




echo "start service finish " >> $path/start_service.log 




