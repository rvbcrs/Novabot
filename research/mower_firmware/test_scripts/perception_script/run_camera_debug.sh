#!/bin/bash
#export ROS_DOMAIN_ID=21
echo "ROS_DOMAIN_ID is: "$ROS_DOMAIN_ID
source /root/novabot/install/setup.bash

cd /userdata/perception_script

./start_iox-roudi.sh start 
./start_iox_preposition.sh start
./start_demo_tof.sh start
