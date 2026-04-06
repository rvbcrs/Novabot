ource /opt/ros/galactic/setup.bash
source /userdata/camera_ws/install/setup.bash
for((i=1;i<=200;i++));
do
sleep 20s
ros2 service call /enable_aruco_localization std_srvs/srv/SetBool "data: true" &


 ros2 service call /perception/do_perception std_srvs/srv/SetBool "data: false" 
sleep 20s
 ros2 service call /enable_aruco_localization std_srvs/srv/SetBool "data: false" 

 ros2 service call /perception/do_perception std_srvs/srv/SetBool "data: true" 
done
