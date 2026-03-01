#!/bin/bash
ifconfig wlan0 | grep broadcast | awk '{print $6}' 
