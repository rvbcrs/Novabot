rm -rf /root/temp_zip/novabot
mkdir -p  /root/temp_zip/novabot/install
cd /root/temp_zip
cp -r /root/novabot/install/automatic_recharge /root/temp_zip/novabot/install/
cp -r /root/novabot/install/automatic_recharge_msgs /root/temp_zip/novabot/install/
cp -r /root/novabot/install/boundary_follow_planner /root/temp_zip/novabot/install/
cp -r /root/novabot/install/coverage_planner /root/temp_zip/novabot/install/
cp -r /root/novabot/install/path_record /root/temp_zip/novabot/install/
cp -r /root/novabot/install/rcl_logging_spdlog /root/temp_zip/novabot/install/
cp -r /root/novabot/install/nav2_regulated_pure_pursuit_controller /root/temp_zip/novabot/install/
cp -r /root/novabot/install/nav2_pro_msgs /root/temp_zip/novabot/install/
cp -r /root/novabot/install/nav2_single_node_navigator /root/temp_zip/novabot/install/
cp -r /root/novabot/install/robot_combination_localization /root/temp_zip/novabot/install/
cp -r /root/novabot/install/localization_msgs /root/temp_zip/novabot/install/
cp -r /root/novabot/install/nav2_controller /root/temp_zip/novabot/install/
cp -r /root/novabot/install/aruco_localization /root/temp_zip/novabot/install/
cp -r /root/novabot/install/chassis_control /root/temp_zip/novabot/install/
cp -r /root/novabot/install/novabot_msgs /root/temp_zip/novabot/install/
cp -r /root/novabot/debug_sh /root/temp_zip/novabot/

zip -r novabot_$(date "+%Y%m%d")_only_zxl_package.zip novabot
mv novabot_$(date "+%Y%m%d")_only_zxl_package.zip ../
rm -rf /root/temp_zip/novabot
