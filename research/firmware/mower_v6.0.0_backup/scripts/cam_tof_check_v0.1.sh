#! /bin/bash

check_module_id=2
check_module_name="novabot_cam_tof"

error_code=0
error_info="Health status, no errors"

###
    # i2cdelet 命令获取camera307相机和tof相机设备的id号
###
# camera 307 mipi device id: 1a 36
cam_check_dev_id1=$(i2cdetect -y -r 2  | sed -n '3p' | awk '{print $12}')
cam_check_dev_id2=$(i2cdetect -y -r 2  | sed -n '5p' | awk '{print $8}')

cam_307_online=false

if [ ${cam_check_dev_id1} = "1a" ] && [ ${cam_check_dev_id1} = "36" ]; then
    cam_307_online=true
fi
#echo "cam_dev_check is: ${cam_check_dev_id1}, ${cam_check_dev_id2}, dev online: ${cam_307_online}"

# tof camera mipi device id: 3d
tof_check_dev_id=$(i2cdetect -y -r 2  | sed -n '5p' | awk '{print $15}')

tof_online=false

if [ ${tof_check_dev_id} = "3d" ]; then
    tof_online=true
fi
#echo "cam_dev_check is: ${tof_check_dev_id}, dev online: ${tof_online}"

###
    # 按优先级返回错误，只返回一个错误
    # 0x0000： 正常
    # 0x0001： RGB相机和TOF相机两个设备都不在线
    # 0x0002： TOF相机设备不在线
    # 0x0003： RGB相机设备不在线
    # 错误返回： 以Json格式输出，格式：echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"
###

if [ "$cam_307_online" = false ] && [ "$tof_online" = false ]; then
    error_code=1
    error_info="camera307 and tof camera device is not online."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"

elif [ "$tof_online" = false ]; then
    error_code=2
    error_info="Tof camera device is not online."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"

elif [ "$cam_307_online" = false ]; then
    error_code=3
    error_info="Camera307 device is not online."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"
else
    error_code=0
    error_info="No error or warning"
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"
fi
