#!/bin/bash

flag=false
log_path=/root/novabot/data/ros2_log

start(){

mkdir -p /userdata/lfi/camera_params/

#启动IP广播服务
#cd ~/novabot/test_scripts/factory_test/
#./udp_client > udp_client.log  &
#echo "start udp client success"

#启动电机节点服务
source /etc/profile
cd ~/novabot/test_scripts/factory_test/
python3 ./chassis_factory_test_ROS2.py > $log_path/chassis_factory_test.log &
echo "start chassis factory test.py"

}

stop(){
#killall -p -9 udp_client
#killall -p -9 data_capture_node
#ps -axu | grep chassis_factory_test.py | awk '{print $2}' | xargs kill -9
    echo "no need to execute factory test"
}

if [[ "$flag" = true ]];then
    start
    echo "start the factory test"	
else
   stop
fi


