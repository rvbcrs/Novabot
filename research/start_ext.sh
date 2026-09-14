#!/bin/bash
# Herstart extended_commands.py MET de ROS-omgeving.
#
# Zonder deze omgeving draait het script wel, maar praat het tegen een andere
# DDS dan de firmware: de RtkRelay krijgt dan geen /rtk_fix_quality meer door en
# de RTK-status in het dashboard valt stil, zonder foutmelding. Daarom nooit
# handmatig `python3 extended_commands.py`, altijd dit script.
#
# De boot doet dit al zelf in run_novabot.sh; dit is de handmatige route.
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=1
cd /root
exec python3 /root/novabot/scripts/extended_commands.py
