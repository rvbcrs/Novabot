builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
uint8 request_type  # request source
float32 cov_ratio # coverage ratio
float32 cov_area # covered area
float32 cov_work_time # work time in minutes
float32 valid_cov_work_time # valid mowing work time in minutes
float32 avoiding_obstacle_time # obstacle avoidance time in minutes
float32 pause_time # pause time
string cov_map_path # map path
uint8 target_height # target height
uint8 work_status # status: 9=finished, 2=CANCELLED, 1=failed
uint8 error_status # error code (failure type)
