killall -q -9 robot_decision
kill -2 $(ps aux | grep nav2_perception_navigator.launch.py | tr -s ' '| cut -d ' ' -f 2)
