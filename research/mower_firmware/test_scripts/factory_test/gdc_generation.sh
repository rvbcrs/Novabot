#!/bin/bash
DATE=`date +%Y%m%d_%H%M%S`
CAMERA_PATH="/userdata/lfi/camera_params"
LOG="$CAMERA_PATH/gdc_generation.log"

#运行log存放位置:  /userdata/lfi/camera_params/gdc_generation.log"

echo "$DATE Factory calibration completed, start generation  $CAMERA_PATH/gdc_map_preposition.txt" > $LOG

if [ ! -f "$CAMERA_PATH/gdc_map.py" ] || [ ! -f "$CAMERA_PATH/preposition_intrinsic.json" ] || [ ! -f "$CAMERA_PATH/layout_preposition.json" ] || [ ! -f "$CAMERA_PATH/preposition_tof_extrinsic.json" ]; then
  echo "$DATE  $CAMERA_PATH/gdc_map.py  $CAMERA_PATH/preposition_intrinsic.json  $CAMERA_PATH/layout_preposition.json $CAMERA_PATH/preposition_tof_extrinsic.json maybe not exist" >> $LOG
  exit 1
fi

python3  /userdata/lfi/camera_params/gdc_map.py  /userdata/lfi/camera_params/preposition_intrinsic.json  /userdata/lfi/camera_params/layout_preposition.json  /userdata/lfi/camera_params/gdc_map_preposition.txt

DATE=`date +%Y%m%d_%H%M%S`
echo "$DATE" >  "$CAMERA_PATH/gdc_cover.flag"  #此标志文件代表 工装工具重新标定后已经重新覆盖、后续ota 无需再生成

sync  

echo "$DATE generation  $CAMERA_PATH/gdc_map_preposition.txt finish" >> $LOG
echo "$DATE reboot -f Now" >> $LOG

reboot -f                                      #gdc文件生成后将重启机器、等待下一步回充测试



