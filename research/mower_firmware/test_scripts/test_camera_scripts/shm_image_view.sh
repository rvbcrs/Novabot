
 #!/bin/bash

source /root/novabot/install/setup.bash

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml


ros2 launch shm_utils shm_image_view.launch.py  camera_ns:='camera/preposition'

#ros2 launch shm_utils shm_image_view.launch.py  camera_ns:='camera/panoramic'
unset RMW_IMPLEMENTATION
unset CYCLONEDDS_URI

# colcon build  --packages-select  camera_307_cap 
# colcon build  --packages-select  horizon_wrapper
# colcon build  --packages-select  tof_camera
