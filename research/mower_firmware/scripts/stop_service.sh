#!/bin/bash

#stop
systemctl stop  novabot_launch.service		            # 1 Start sequence
systemctl stop  novabot_ota_launch.service				# 2

#disable
systemctl disable  novabot_launch.service	
systemctl disable  novabot_ota_launch.service

rm /lib/systemd/system/novabot*	
rm /etc/systemd/system/novabot*	