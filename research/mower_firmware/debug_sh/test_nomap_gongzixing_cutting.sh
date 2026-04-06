ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "data: true" &
sleep 1s
 ros2 service call /enable_aruco_localization std_srvs/srv/SetBool "data: false" &
sleep 1s
ros2 service call /perception/do_perception std_srvs/srv/SetBool "data: true" &
sleep 1s
ros2 action send_goal --feedback /navigate_through_coverage_paths coverage_planner/action/NavigateThroughCoveragePaths "{coverage_type: 3, test_short_length: 1.0, test_long_length: 1.0, return_to_start: true, adaptive_mode: 1, reset_coverage_map: true, target_repeat_times: 1}"

