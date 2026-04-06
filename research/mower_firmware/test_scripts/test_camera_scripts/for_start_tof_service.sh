 
#!/bin/bash

source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash

for ((i=1; i<=100; i++))
do

    sleep 5s
    echo "stop camera.... "
    ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "{data: False}"

    sleep 5s
    echo "start camera.... $i "
    ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "{data: True}"

done
