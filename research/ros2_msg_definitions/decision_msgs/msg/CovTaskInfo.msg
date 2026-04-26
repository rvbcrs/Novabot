# verified 2026-04-26 (live SSH from 192.168.0.100)
builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
uint8 request_type  # 请求来源
float32 cov_ratio #覆盖率
float32 cov_area #已覆盖面积
float32 cov_work_time #已工作时间/分钟
float32 valid_cov_work_time #有效割草工作时间/分钟
float32 avoiding_obstacle_time # 避障耗时/分钟
float32 pause_time # 暂停耗时
string cov_map_path #地图路径
uint8 target_height #目标高度
uint8 work_status # 状态码 9完成 2 CANCELLED 1失败
uint8 error_status #错误码（对应失败类型）
