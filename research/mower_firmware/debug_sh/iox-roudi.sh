 
 #!/bin/bash

# 将配置文件shm_cyclonedds.xml  shm_fastdds.xml  shm_ioxroudi.toml 拷贝到/userdata
# cd src/camera_307_cap/config
# cp -r shm_* /userdata


#设置共享内存
#path=/userdata/novabot_slam/run_camera
#source /userdata/novabot_slam/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml
iox-roudi  -m on -c /root/novabot/shm_config/shm_ioxroudi.toml --log-level verbose  
unset RMW_IMPLEMENTATION
unset CYCLONEDDS_URI
 

