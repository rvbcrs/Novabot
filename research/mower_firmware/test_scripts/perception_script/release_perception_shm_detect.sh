 #!/bin/bash
#export ROS_DOMAIN_ID=21
echo "ROS_DOMAIN_ID is: "$ROS_DOMAIN_ID
path=/root/novabot
source  $path/install/setup.sh
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
#使用共享内存、Debug 发布中间结果版本
#pub_debug_image： publish debug image
ros2 launch perception_node perception_node_shm.launch.py pub_debug_image:=false
unset RMW_IMPLEMENTATION
unset CYCLONEDDS_URI
