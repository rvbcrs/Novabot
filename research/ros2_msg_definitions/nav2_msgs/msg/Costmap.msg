# verified 2026-04-26 (live SSH from 192.168.0.100)
# This represents a 2-D grid map, in which each cell has an associated cost

std_msgs/Header header

# MetaData for the map
CostmapMetaData metadata

# The cost data, in row-major order, starting with (0,0).
uint8[] data
