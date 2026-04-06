if [[ $1 -ge 0 && $1 -le 80 ]]
then
    echo "channel = $1 "
else
   echo "out range"
fi
ros2 action send_goal /chassis_lora_set novabot_msgs/action/ChassisLoraSet "{channel: $1,addr: $2}"
