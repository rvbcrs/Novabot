# verified 2026-04-26 (live SSH from 192.168.0.100)
builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
uint8 map_num # 地图数量
uint8 finished_num #已完成地图
uint8 work_status # 状态码 9完成 2 CANCELLED 1失败
uint8 error_status #错误码（对应失败类型）
uint32 map_ids #割草地图
float32 area #割草面积
uint8 target_height #割草高度，为兼容旧接口0-7级，实际高度为 级别+2*10
# 请求类型，不同设备请求和不同类型， 待定
# 1 开头的mqtt/app启动  11 普通启动   12 排期割草  13  14
# 2 开头的MCU启动命     21  普通启动  22 排期割草  23   24
uint8 request_type # 开始类型
#decision_msgs/CovTaskInfo[] cov_infos # all task summary
