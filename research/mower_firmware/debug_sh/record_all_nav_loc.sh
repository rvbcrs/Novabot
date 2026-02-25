macadd=$(cat /sys/class/net/wlan0/address)
macadd=mac_${macadd//:/_}_date_$(date "+%Y%m%d_%H_%M")
filename=front307_um960_icm40608_${macadd}
echo ${filename}
ros2 bag record /imu_raw /filtered_imu /odom /odom_3d /odom_raw /gps_raw /nmea_raw /map_utm /tf /tf_static  /bestpos_parsed_data /bestvel_parsed_data /bestvel_raw  /bestpos_raw /camera/preposition/image/compressed /recorded_pose /recorded_path  /blade_speed_get /wheel_speed_get /hall_status /global_costmap/costmap /local_costmap/costmap /followed_path /plan /map /coverage_map  /coverage_path /pipe_charge_status /perception/points_labeled /collision_range -d 360 -o ${filename}
