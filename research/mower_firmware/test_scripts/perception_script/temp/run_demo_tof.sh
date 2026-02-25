#!/bin/bash
export ROS_DOMAIN_ID=21
echo "ROS_DOMAIN_ID is: "$ROS_DOMAIN_ID

cd /root/novabot/test_scripts/test_camera_scripts/
./demo_tof.sh

