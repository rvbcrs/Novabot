
for((i=1;i<=200;i++));
do
echo "----------------------------           $i       ----------------"
ros2 action send_goal --feedback /auto_charging automatic_recharge_msgs/action/AutoCharging "
overwrite: false
non_charging_pose_mode: true
enable_no_visual_recharge: false
max_retry: 5
disable_charge_check: false
keep_alive: false
rotate_searching: false"

ros2 topic pub -1 /motor_driver_reset std_msgs/msg/String "data: ''" &
ros2 topic pub -1 /release_charge_lock std_msgs/msg/UInt8 "data: 0" &
ros2 topic pub -r 5 -t 30 /cmd_vel geometry_msgs/msg/Twist "linear:
  x: -0.2
  y: 0.0
  z: 0.0
angular:
  x: 0.0
  y: 0.0
  z: 0.0"
sleep 5s
done

