 ros2 service call /enable_aruco_localization std_srvs/srv/SetBool "data: false" &
 sleep 1s
 ros2 service call /perception/do_perception std_srvs/srv/SetBool "data: true" &
ros2 action send_goal --feedback /navigate_through_coverage_paths coverage_planner/action/NavigateThroughCoveragePaths "{map_yaml: /userdata/lfi/maps/home0/map0.yaml, return_to_start: true, reset_coverage_map: true,  setting_blade_height: true, blade_height: 20, include_edge: true, adaptive_mode: 1}"
