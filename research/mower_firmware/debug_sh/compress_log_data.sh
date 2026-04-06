rm -rf /root/temp_zip/log_and_data
mkdir -p  /root/temp_zip/log_and_data/data
mkdir -p  /root/temp_zip/log_and_data/maps
mkdir -p  /root/temp_zip/log_and_data/charging_station_file
var111=`cat /userdata/lfi/json_config.json |grep -Eo "LFIN[0-9]+"`

DATE=`date +%Y%m%d_%H%M`
DMESG_LOG=/root/novabot/data/dmesg.log
echo "****************** $DATE **************" > $DMESG_LOG
dmesg -T >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

df -h    >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

hrut_somstatus >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

ifconfig       >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG
ls /dev/tty* >> $DMESG_LOG
lsusb >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

top -b -n 1 >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

ls /userdata/lfi/camera_params/ -la >> $DMESG_LOG

echo "***************************************" >> $DMESG_LOG

echo "******************* 前置相机&tof相机 i2c address ********************" >> $DMESG_LOG
i2cdetect -y -r 1 >> $DMESG_LOG


echo "******************* 全景相机 i2c address ********************" >> $DMESG_LOG
i2cdetect -y -r 2 >> $DMESG_LOG



cd /root/temp_zip/
cp -p -r /root/novabot/data /root/temp_zip/log_and_data/
cp -p -r /userdata/lfi/*json /root/temp_zip/log_and_data/
cp -p -r /userdata/lfi/maps /root/temp_zip/log_and_data/
cp -p -r /userdata/lfi/charging_station_file /root/temp_zip/log_and_data/

rm -rf /root/temp_zip/log_and_data/data/ros2_log/202*
data222="${var111}_log_$(date "+%Y%m%d%H%M").zip"
zip -r ${data222} log_and_data
mv ${data222} /root/
rm -rf /root/temp_zip/log_and_data
echo ${var111}
