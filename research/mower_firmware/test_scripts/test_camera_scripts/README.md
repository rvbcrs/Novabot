
## 版本

camera_307_cap ---->  devel_refactor 分支
tof_camera            ---->  devel_refactor 分支

### 注意需要手动更新相关的库

cp /root/novabot/ota_lib/libimx307preposition.so /lib/sensorlib/
cp /root/novabot/ota_lib/libimx307_linear.so  /lib/sensorlib/
cp /root/novabot/ota_lib/liblog_wrapper.so  /usr/local/lib/


### 1. 当前共享内存配置文件shm_cyclonedds.xml  shm_fastdds.xml  shm_ioxroudi.toml 在 /root/novabot/shm_config



### 2. 运行所有相机、camera_307_cap 以共享内存方式启动

```

./iox_run_all_camera.sh         共享内存方式运行  iox_all_camera.log

./demo_run_all_camera.sh start  非共享内存方式运行  日志存放在all_camera.log

```

### 3. 单独运行相机、非共享内存方式启动、请开启多终端运行

```
./demo_preposition.sh   非共享内存方式启动 前置相机
./demo_panoramic.sh     非共享内存方式启动 全景相机
./demo_tof.sh           非共享内存方式启动 tof相机
```

### 4. 单独运行相机、共享内存方式启动、请开启多终端运行

```
./iox-roudi.sh            开启共享内存、映射共享内存空间
./iox_preposition.sh      共享内存方式启动前置相机
./iox_panoramic.sh        共享内存方式启动全景相机
./demo_tof.sh             非共享内存方式启动 tof相机
```

### 5. 订阅共享内存例子
```
./shm_image_view.sh       根据需要自己修改订阅前置或者全景

```

### 6. 查看相机topic的发布频率

```
ros2 topic hz /camera/preposition/image/compressed   前置

ros2 topic hz /camera/panoramic/image/compressed     全景

ros2 topic hz /tof_filtered_cloud                    tof
```

### 7. 查看地平线sdk的帧率

```
cat /sys/devices/platform/soc/a4042000.pym/fps （查看pym帧率）
cat /sys/devices/platform/soc/b3000000.isp/fps （查看isp帧率）
cat /sys/devices/platform/soc/a4001000.sif/fps （查看sif帧率）
cat /sys/devices/platform/soc/a4040000.ipu/fps （查看ipu帧率）
cat /sys/devices/platform/soc/a8000000.vpu/fps （查看vpu帧率）
cat /sys/devices/platform/soc/a4010000.gdc0/fps（查看gdc帧率）
```

### 8. 编译

```
colcon build --packages-select  log_wrapper
colcon build --packages-select  horizon_wrapper  shm_msgs shm_utils camera_307_cap --cmake-args -DCMAKE_BUILD_TYPE=Release
colcon build --packages-select  tof_camera
colcon build --packages-select  take_picture_manager
```


### 9. 开机启动
```
systemctl daemon-reload
systemctl stop     novabot_launch.service
systemctl disable  novabot_launch.service
systemctl enable   novabot_launch.service
systemctl start    novabot_launch.service

```


### 10. 相机时钟频率设置
```
37.125M
echo 1 > /sys/class/vps/mipi_host2/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host1/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host0/param/snrclk_en

echo 37125000 > /sys/class/vps/mipi_host2/param/snrclk_freq
echo 37125000 > /sys/class/vps/mipi_host1/param/snrclk_freq
echo 24750000 > /sys/class/vps/mipi_host0/param/snrclk_freq


24M
echo 1 > /sys/class/vps/mipi_host2/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host1/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host0/param/snrclk_en

echo 24000000 > /sys/class/vps/mipi_host2/param/snrclk_freq
echo 24000000 > /sys/class/vps/mipi_host1/param/snrclk_freq
echo 24000000 > /sys/class/vps/mipi_host0/param/snrclk_freq

```



### 11. 相机拍照功能

```

./demo_run_all_camera.sh start  非共享内存方式启动三个相机       

  sleep 10s

./take_picture.sh


查看 /root/novabot_test/ 目录下是否有三张照片，如果没有则表示某一个相机异常

camera_307_panoramic.jpg  camera_307_preposition.jpg  tof_camera.jpg

```


### 拍照（一秒拍一张）

ros2 service call -r 1 /camera/panoramic/save_camera std_srvs/srv/Empty

ros2 service call -r 1 /camera/preposition/save_camera std_srvs/srv/Empty

ros2 service call -r 1 /camera/tof/save_camera std_srvs/srv/Empty