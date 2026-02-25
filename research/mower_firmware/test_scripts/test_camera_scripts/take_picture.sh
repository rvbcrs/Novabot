 
 #!/bin/bash

source /root/novabot/install/setup.bash
ros2 launch take_picture_manager take_picture_manager.launch.py

sleep 5s

DATE_DIR=`date +%Y%m%d`
IMAGE_PATH=/media/image/$DATE_DIR
NOVABOT_TEST_PATH=/root/novabot_test

#如果文件夹不存在，创建文件夹
if [ ! -d "$NOVABOT_TEST_PATH" ]; then

    mkdir $NOVABOT_TEST_PATH
fi

rm $NOVABOT_TEST_PATH/tof_camera.jpg
rm $NOVABOT_TEST_PATH/camera_307_panoramic.jpg
rm $NOVABOT_TEST_PATH/camera_307_preposition.jpg

if [ -d "$IMAGE_PATH" ]; then

    cp $IMAGE_PATH/tof_camera*.jpg  $NOVABOT_TEST_PATH/tof_camera.jpg
    cp $IMAGE_PATH/camera_307_panoramic*.jpg  $NOVABOT_TEST_PATH/camera_307_panoramic.jpg
    cp $IMAGE_PATH/camera_307_preposition*.jpg  $NOVABOT_TEST_PATH/camera_307_preposition.jpg
else

    echo "$IMAGE_PATH is not exits,take picture failed!!"

fi
