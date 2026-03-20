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
uint32 request_map_ids
uint32 current_map_ids
float32 cov_ratio
float32 cov_area
float32 cov_remaining_area
float32 cov_estimate_time
float32 cov_work_time
float32 valid_cov_work_time
float32 avoiding_obstacle_time
float32 pause_time
string cov_map_path
uint8 target_height
decision_msgs/CovTaskInfo[] cov_infos # all task summary
uint8 map_num
uint8 finished_num
builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
#-------------------other message
uint8 light
uint8 perception_level
uint8 battery_power
uint8 cpu_usage
uint32 memory_remaining # remaining memory MB
uint8 cpu_temperature
uint32 disk_remaining # remaining disk space MB
uint8 loc_quality # localization quality 0-100
uint32 working_time # software running time in minutes
float32 x
float32 y
float32 theta
