
#!/bin/bash

colcon build --packages-select  log_wrapper
colcon build --packages-select  horizon_wrapper  shm_msgs shm_utils camera_307_cap 
colcon build --packages-select  tof_camera 
colcon build --packages-select  take_picture_manager
