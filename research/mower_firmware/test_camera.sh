#!/bin/bash
  
# 无限循环脚本  
while true; do  
    # 在这里放入你想要在每次循环中执行的命令  
    ros2 topic  pub --once /your_topic_name std_msgs/msg/String "{data: 'Hello, ROS 2!'}" &
    sleep 3
    ros2 service call /camera/preposition/start_camera std_srvs/srv/SetBool "data: true"  &
    sleep 3
    ros2 topic  pub --once /your_topic_name std_msgs/msg/String "{data: 'Hello, ROS 2!'}" &
    sleep 3
    ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "data: true"  &
    sleep 3
    ros2 service call /perception/do_perception std_srvs/srv/SetBool "data: true" &
done
