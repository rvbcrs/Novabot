ros2 service call /delete_current_edge std_srvs/srv/SetBool "data: true"
ros2  service call /mapping_control mapping_msgs/srv/MappingControl "{map_file_name: '',child_map_file_name: '',type: 0}"
ros2 service call /recording_edge mapping_msgs/srv/Recording "{type: 0}"
