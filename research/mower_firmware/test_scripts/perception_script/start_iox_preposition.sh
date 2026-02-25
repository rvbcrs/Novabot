
 #!/bin/bash
source /root/novabot/install/setup.bash

case "$1" in
start)
	echo "start front perception...."
	export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
	export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml

	ros2 launch camera_307_cap camera_307_preposition_node.launch.py  use_shm:=true &

	unset RMW_IMPLEMENTATION
	unset CYCLONEDDS_URI
	;;
stop)
	echo "stop front perception..."
	killall -q 15 camera_307_cap
	killall -q 9 camera_307_cap
	;;
*)
	echo "Usage: $) {start|stop|}"
	exit 1
	;;
esac

