#! /bin/bash

check_module_id=1
check_module_name="novabot_core_x3"

error_code=0
error_info="Health status, no errors"

disk_total=0
disk_used=0

###
    # 获取硬盘所有磁盘分区的的信息，计算磁盘的整个利用率
###
while read line;
do 
    # 获取单个磁盘分区的大小，计算总共的磁盘大小
    # echo "Single disk partition-> $line"
    single_disk_size=$(echo $line | awk '{print $2}')

    # # echo "sds1-> $single_disk_size"
    if [ $(echo $single_disk_size | grep 'K') ]; then
        disk_part_size=$(echo $single_disk_size | grep 'K' | sed 's/.$//g'|awk '{sum += $1} END {print sum}')
    elif [ $(echo $single_disk_size | grep 'M') ]; then
        disk_part_size=$(echo $single_disk_size | grep 'M'| sed 's/.$//g'|awk '{print ($1 * 1024)}'|awk '{sum += $1} END {print sum}')
    elif [ $(echo $single_disk_size | grep 'G') ]; then
        disk_part_size=$(echo $single_disk_size | grep 'G'| sed 's/.$//g'|awk '{print ($1 * 1024 * 1024)}'|awk '{sum += $1} END {print sum}')
    else
        # echo "no value"
        continue;
    fi

    disk_part_size_g=$(echo "scale=6; ${disk_part_size}/1024/1024" | bc)
    # echo "disk disk_part_size_g: ${disk_part_size_g}"
    disk_total=$(echo $disk_total + $disk_part_size_g | bc)
    # echo "disk total: ${disk_total} G"
   
    # 获取单个磁盘分区的已用空间, 计算地盘已使用的空间大小
    single_disk_used=$(echo $line | awk '{print $3}')

    # echo "sds1-> $single_disk_used"
    if [ $(echo $single_disk_used | grep 'K') ]; then
        disk_part_used=$(echo $single_disk_used | grep 'K' | sed 's/.$//g'|awk '{sum += $1} END {print sum}')
    elif [ $(echo $single_disk_used | grep 'M') ]; then
        disk_part_used=$(echo $single_disk_used | grep 'M'| sed 's/.$//g'|awk '{print ($1 * 1024)}'|awk '{sum += $1} END {print sum}')
    elif [ $(echo $single_disk_used | grep 'G') ]; then
        disk_part_used=$(echo $single_disk_used | grep 'G'| sed 's/.$//g'|awk '{print ($1 * 1024 * 1024)}'|awk '{sum += $1} END {print sum}')
    else
        # echo "no value"
        continue;
    fi

    disk_part_used_g=`echo "scale=6; ${disk_part_used}/1024/1024" | bc`
    # echo "disk disk_part_used_g: ${disk_part_used_g}"
    disk_used=$(echo $disk_used + $disk_part_used_g | bc)
    # echo "disk_used: ${disk_used} G"

done <<< $(df -h) # 不能使用done < <(...),会提示syntax error near unexpected token `<'错误

x3_disk_usage=$(echo "scale=2; (100*$disk_used/$disk_total)" | bc)
# echo "disk total: ${disk_total} G, disk_used: ${disk_used} G, usage: ${x3_disk_usage} %"

###
    #获取内存使用率的脚本
###
 
memory_used_rate=`free -m | sed -n '2p' | awk '{printf "%f\n",($3)/$2*100}'`
# echo "memory USE:${memory_used_rate}%"
# memory=$(echo "$memory_used_rate" | cut -d "." -f 1)

###
    # 获取内存使用率
    # CPU使用率计算公式：cpu_usage=100-空闲CPU占用率（top %Cpu(s): id）
###

cpu_used_rate=$(top -b -n 1 | grep Cpu | awk '{printf "%f\n", 100-($8)}')
# echo "cpu_rate: ${cpu_used_rate}%"

###
    # 按优先级返回错误，只返回一个错误
    # 0x0000： 正常
    # 0x0001： 内存使用过高，超过90%
    # 0x0002： 磁盘内存不足，超过80%
    # 0x0003： CPU使用过高，超过90%
    # 错误返回： 以Json格式输出，格式：echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"
###

if [ `echo "$memory_used_rate > 90.0"|bc` -eq 1 ]; then
    error_code=1
    error_info="Memory usage is too high."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"

elif [ `echo "$disk_used > 80.0"|bc` -eq 1 ]; then
    error_code=2
    error_info="Disk usage is too high."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"

elif [ `echo "$cpu_used_rate > 90.0"|bc` -eq 1 ]; then
    error_code=3
    error_info="CPU usage is too high."
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"fi
else
    error_code=0
    error_info="No error or warning"
    echo "{ \"id\":$check_module_id,\"name\":\"$check_module_name\",\"errCode\": $error_code,\"errStr\":\"$error_info\"}"
fi





