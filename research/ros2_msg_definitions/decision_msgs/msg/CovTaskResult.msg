builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
uint8 map_num # number of maps
uint8 finished_num # finished maps
uint8 work_status # status: 9=finished, 2=CANCELLED, 1=failed
uint8 error_status # error code (failure type)
uint32 map_ids # mowing map
float32 area # mowing area
uint8 target_height # mowing height, for compatibility 0-7 levels, actual height = level+2*10
# request_type: 1x=mqtt/app, 11=normal, 12=scheduled, 2x=MCU
uint8 request_type # start type
