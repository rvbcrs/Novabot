
#!/bin/bash

cd /root/novabot
colcon build --packages-select  log_wrapper
colcon build --packages-select  horizon_wrapper  shm_msgs shm_utils camera_307_cap --cmake-args -DCMAKE_BUILD_TYPE=Release
colcon build --packages-select  tof_camera horizon_wrapper tof_camera --cmake-args -DCMAKE_BUILD_TYPE=Release
colcon build --packages-select  take_picture_manager
