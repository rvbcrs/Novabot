#!/bin/bash
export ROS_DOMAIN_ID=21
echo "ROS_DOMAIN_ID is: "$ROS_DOMAIN_ID
source /root/novabot/install/setup.bash
# cd /userdata/perception_script/
# ./run_iox.sh start
# ./run_camera.sh start
# ./run_perception_shm_detect_debug_test.sh

cd /root/novabot/test_scripts/test_camera_scripts/
./iox-roudi.sh 
./iox_preposition.sh

