# verified 2026-04-26 (live SSH from 192.168.0.100)
# enum is used for merged_work_status, simplyfied status
uint8 FREE=0
uint8 COVER=1
uint8 RECHARING=2
uint8 MAPPING=3
uint8 CHARGING=4
uint8 STOP=5
builtin_interfaces/Time stamp

# task mode: cover mode/ mapping mode/ patrolling mode/control or no task mode/ other mode
uint8 task_mode
# according to task mode, there many detail modes
uint8 work_status
# recharge status
uint8 recharge_status
# error status for all task
uint8 error_status
uint8 prev_work_status
uint8 prev_recharge_status
uint8 prev_task_mode
uint8 merged_work_status  # used for app /mqtt/chassis,
# ----------message to show to user
string msg
string error_msg
#---------------coverage data
uint32 request_map_ids #请求的割草地图（id）,用于与app上报
uint32 current_map_ids #当前割草地图（id）,用于与app上报
float32 cov_ratio #覆盖率
float32 cov_area #已覆盖面积
float32 cov_remaining_area  #剩余面积
float32 cov_estimate_time #估计剩余时间
float32 cov_work_time #已工作时间
float32 valid_cov_work_time #割工作时间
float32 avoiding_obstacle_time # 避障耗时
float32 pause_time # 暂停耗时
string cov_map_path #地图路径
uint8 target_height #目标高度
decision_msgs/CovTaskInfo[] cov_infos # all task summary
uint8 map_num # 地图数量
uint8 finished_num # 已完成地图
builtin_interfaces/Time start_time #开始时间
builtin_interfaces/Time end_time #结束时间
#-------------------other message
uint8 light #
uint8 perception_level # perception level
uint8 battery_power # 电池电量
uint8 cpu_usage
uint32 memory_remaining # 剩余内存MB
uint8 cpu_temperature # CPU温度
uint32  disk_remaining # 剩余磁盘空间MB
uint8 loc_quality #定位质量0-100
uint32 working_time #软件运行时间,单位分钟
float32 x
float32 y
float32 theta
