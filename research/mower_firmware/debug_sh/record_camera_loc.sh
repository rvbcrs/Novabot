macadd=$(cat /sys/class/net/wlan0/address)
macadd=mac_${macadd//:/_}_date_$(date "+%Y%m%d_%H_%M")
filename=front307_um960_icm40608_${macadd}
echo ${filename}
ros2 bag record /cmd_vel /imu_raw /filtered_imu /odom /odom_3d /odom_raw /gps_raw /nmea_raw /map_utm /tf /tf_static  /bestpos_parsed_data /bestvel_parsed_data /bestvel_raw  /bestpos_raw /recorded_pose /recorded_path  /blade_speed_get /matchedposa_raw /wheel_speed_get /camera/preposition/image_half/compressed  /camera/tof/point_cloud /camera/tof/gray_image  /camera/tof/depth_image  /matchedposa_raw /psrdopa_raw -d 360 -o ${filename}
cp -r /userdata/lfi/camera_params/*json ${filename}/
