
#!/bin/bash
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
ros2 launch camera_307_cap camera_307_panoramic_node.launch.py use_shm:=false
