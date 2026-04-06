 
#!/bin/bash
#source /opt/ros/galactic/setup.bash
#source /root/novabot/install/setup.bash
case "$1" in
start)
  	echo "starting demo_tof.... "
	ros2 launch tof_camera tof_demo_test.launch.py
	;;
stop)
  	echo "stopping demo_tof.... "
  	killall -q -2 demo_tof 
  	;;
*)
  	echo "Usage: $0 {start|stop|}"
  	exit 1
  	;;
esac



