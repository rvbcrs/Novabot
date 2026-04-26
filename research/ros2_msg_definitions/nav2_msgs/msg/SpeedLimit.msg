# verified 2026-04-26 (live SSH from 192.168.0.100)
std_msgs/Header header
# Setting speed limit in percentage if true or in absolute values in false case
bool percentage
# Maximum allowed speed (in percent of maximum robot speed or in m/s depending
# on "percentage" value). When no-limit it is set to 0.0
float64 speed_limit
