macadd=$(cat /sys/class/net/wlan0/address)
macadd=mac_${macadd//:/_}_date_$(date "+%Y%m%d_%H_%M")
filename=navigation_debug_tof_map_tf_${macadd}
echo ${filename}
ros2 bag record /coverage_planner_server/coverage_path /hall_status /tf /tf_static /odom /global_costmap/costmap /local_costmap/costmap /followed_path /plan /map /coverage_map /cmd_vel /protect_back_vel /cloud_move_cmd /coverage_path /local_plan  /lookahead_point /pipe_charge_status /perception/points_labeled /collision_range /nav2_single_node_navigator/recorded_path -o ${filename}
