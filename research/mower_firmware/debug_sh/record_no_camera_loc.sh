macadd=$(cat /sys/class/net/wlan0/address)
macadd=mac_${macadd//:/_}_date_$(date "+%Y%m%d_%H_%M")
filename=um960_icm40608_${macadd}
echo ${filename}
ros2 bag record  /cmd_vel /imu_raw /filtered_imu /matchedposa_raw  /psrdopa_raw /odom /odom_3d /odom_raw /gps_raw /nmea_raw /map_utm /tf /tf_static  /bestpos_parsed_data /bestvel_parsed_data /bestvel_raw  /bestpos_raw /cmd_vel /blade_speed_get /wheel_speed_get -d 360 -o ${filename}
