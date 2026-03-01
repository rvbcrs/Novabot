#!/bin/bash

if [[ $1 -eq 1 ]]; then
        top -s -b -n 1 |grep -E "Cpu|KiB Mem |KiB Swap" | awk '{ print ($2+$4)/100}' | tr -d '\n\r'   #cpu 使用率
elif [[ $1 -eq 2 ]]; then
    free -m | grep "Mem:" | awk '{print $3 / $2}' | tr -d '\n\r'     #内存使用率
elif [[ $1 -eq 3 ]]; then
    df -h | grep root | awk '{print $5 / 100}' | tr -d '\n\r'   #硬盘占用情况
elif [[ $1 -eq 4 ]]; then
    cat /sys/devices/virtual/thermal/thermal_zone0/temp  | awk '{print $1 / 1000}' | tr -d '\n\r'   #获取CPU核心温度
fi