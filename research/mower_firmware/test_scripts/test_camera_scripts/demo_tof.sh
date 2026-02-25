 
#!/bin/bash
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
ros2 launch tof_camera tof_demo_test.launch.py

# ros2 launch tof_camera tof_camera.launch.py

# ros2 service call /start_tof std_srvs/srv/SetBool "{data: True}"
# ros2 service call /start_tof std_srvs/srv/SetBool "{data: False}"
