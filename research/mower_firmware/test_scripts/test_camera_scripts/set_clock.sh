#!/bin/bash

echo 0 > /sys/class/vps/mipi_host2/param/snrclk_en
echo 0 > /sys/class/vps/mipi_host1/param/snrclk_en
echo 0 > /sys/class/vps/mipi_host0/param/snrclk_en


echo 1 > /sys/class/vps/mipi_host2/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host1/param/snrclk_en
echo 1 > /sys/class/vps/mipi_host0/param/snrclk_en

echo 37125000 > /sys/class/vps/mipi_host2/param/snrclk_freq
echo 37125000 > /sys/class/vps/mipi_host1/param/snrclk_freq
echo 24750000 > /sys/class/vps/mipi_host0/param/snrclk_freq


# echo 27000000 > /sys/class/vps/mipi_host2/param/snrclk_freq
# echo 27000000 > /sys/class/vps/mipi_host1/param/snrclk_freq
# echo 24750000 > /sys/class/vps/mipi_host0/param/snrclk_freq
 

# echo 24000000 > /sys/class/vps/mipi_host2/param/snrclk_freq
# echo 24000000 > /sys/class/vps/mipi_host1/param/snrclk_freq
# echo 24000000 > /sys/class/vps/mipi_host0/param/snrclk_freq
 