'''
Copyright: LFI Co.,Ltd
Description: 
Version: 
Autor: zola
Date: 2022-10-13 18:52:21
LastEditors: zola
LastEditTime: 2022-10-14 01:14:50
'''

import os
 
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node
import launch_ros

def generate_launch_description():
    ld = LaunchDescription()
    config = os.path.join(
        get_package_share_directory('novabot_api'),
        'config',
        'novabot_api.yaml'
        )
    node=launch_ros.actions.Node(
        package='novabot_api',
        executable='mqtt_node',
        name='mqtt_node',
        output='screen',
        emulate_tty='true',
        respawn=True,
        respawn_delay=5,
        parameters=[config]
    )
    ld.add_action(node)
    return ld

