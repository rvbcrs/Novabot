#ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "data: false" &
#sleep 1s
ros2 action send_goal --feedback /auto_charging automatic_recharge_msgs/action/AutoCharging "
overwrite: false
non_charging_pose_mode: true
enable_no_visual_recharge: false
max_retry: 5
disable_charge_check: false
keep_alive: false
rotate_searching: false"

