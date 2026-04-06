#!/usr/bin/env python
from ast import walk
from locale import MON_10
import os
import sys
import select
from time import sleep
import rclpy
from rclpy.node import Node

from std_msgs.msg import UInt8
from std_msgs.msg import String
from novabot_msgs.msg import ChassisHallStatus
from novabot_msgs.msg import ChassisData
from novabot_msgs.msg import ChassisMotorCurrent

from novabot_msgs.msg import BestPos

from std_msgs.msg import Int16

from std_msgs.msg import Bool

import json


from rclpy.action import ActionClient
from novabot_msgs.action import ChassisLoraSet  # 替换成你的消息定义


import random
import time
import paho.mqtt.client as mqtt

import math
import numpy as np
import requests
import socket



from paho.mqtt import client as mqtt_client


import json
 
from geometry_msgs.msg import Twist

from sensor_msgs.msg import Imu

import secrets
import string

from rclpy.qos import qos_profile_system_default
from rclpy.qos import qos_profile_services_default



TYPE_HALL_TEST = 10
TYPE_LiftingMotor_20 = 20
TYPE_LiftingMotor_50 = 21
TYPE_LiftingMotor_90 = 22
TYPE_LiftingMotor_20_90 = 23
TYPE_RTK_LORA = 30
TYPE_IMU = 40
TYPE_WHEEL_MOTOR = 50
TYPE_BLADE_MOTOR = 60
TYPE_SCREEN_BUTTON = 70
TYPE_TILE = 80
TYPE_upraise = 90
TYPE_Collision = 100
TYPE_STOP_KEY = 110
TYPE_RTK_LORA_ADDR_SET = 120 #RTK+LORA 通道与地址设置

CONTROL_START = 1
CONTROL_STOP = 0



LORA_CHANNEL_RESET = 60
LORA_ADDR_RESET = 0



LORA_CHANNEL_1 = 55
LORA_ADDR_1 = 5555

LORA_CHANNEL_2 = 66
LORA_ADDR_2 = 6666


# hall test value

class SWITCH_STATUS:
    def __init__(self,status,trigger,time,success):
        self.num_status = status
        self.trigger_flag = trigger
        self.time = time
        self.success_flag = success



 
parsed_data = 0



# file_path = "/home/zxl/Desktop/json_config.json"

file_path = "/userdata/lfi/json_config.json"




class ChassisMQTT(Node):
    def __init__(self):
        super().__init__('ChassisROS2_factorytest')

        try:
            with open(file_path) as file:
                # 文件存在时的处理逻辑
                self.json_data = json.load(file)
                pass
        except FileNotFoundError:
            # 文件不存在时的处理逻辑
            print("File not found: ", file_path)

        self.sn_value = self.json_data["sn"]["value"]["code"]

        self.version = "2.0.1"

        print("VERION:",self.version)
        print("SN:",self.sn_value)
        

        # factory test ros2 topic 

        self.sub_factory_cmd = self.create_subscription(
            String,
            'tools/mcus_control',
            self.sub_factory_cmd_callback,
            10)

        self.pub_factory_ack = self.create_publisher(String, "tools/mcus_data", 10)





        # reset chassis
        self.motor_reset = self.create_publisher(String, "motor_driver_reset", 10)
        self.reset = String()
        self.motor_reset.publish(self.reset)

        self.cmd_vel_pub = self.create_publisher(Twist, "cmd_vel", 10)
        self.blade_pub = self.create_publisher(Int16, "blade_speed_set", 10)
        self.blade_height_pub = self.create_publisher(UInt8, "blade_height_set", 10)
        # ros2 sub
        self.subscription = self.create_subscription(
            ChassisHallStatus,
            'hall_status',
            self.hall_callback,
            10)
        self.subscription2 = self.create_subscription(
            ChassisData,
            'wheel_speed_get',
            self.wheel_speed_get_callback,
            10)
        self.subscription3 = self.create_subscription(
            Int16,
            'blade_speed_get',
            self.blade_speed_get_callback,
            10)
        self.subscription4 = self.create_subscription(
            UInt8,
            'blade_height',
            self.blade_height_get_callback,
            10)

        self.subscription5 = self.create_subscription(
            Imu,
            'filtered_imu',
            self.imu_callback,
            10)



        self.subscription7 = self.create_subscription(
            UInt8,
            'screen_button_status',
            self.screen_button_status_callback,
            10)

        self.subscription8 = self.create_subscription(
            ChassisMotorCurrent,
            'motor_current',
            self.motor_current_status_callback,
            10)   

        self.subscription9 = self.create_subscription(
            BestPos,
            'bestpos_parsed_data',
            self.bestpos_parsed_data_callback,
            10)  


        self.action_client = ActionClient(
            self,
            ChassisLoraSet,
            'chassis_lora_set'
        )
            
            




        # hall flag
        self.hall_test_flag = 0
        self.hall_status1 = SWITCH_STATUS(0,0,0,0)
        self.hall_status2 = SWITCH_STATUS(0,0,0,0)
        self.hall_status3 = SWITCH_STATUS(0,0,0,0)
        self.hall_status4 = SWITCH_STATUS(0,0,0,0)
        self.hall_status5 = SWITCH_STATUS(0,0,0,0)
        self.hall_status6 = SWITCH_STATUS(0,0,0,0)
        self.hall_status7 = SWITCH_STATUS(0,0,0,0)
        self.hall_status8 = SWITCH_STATUS(0,0,0,0)
        self.hall_status_flag=[self.hall_status1,self.hall_status2,self.hall_status3,self.hall_status4,self.hall_status5,self.hall_status6,self.hall_status7,self.hall_status8]


        # screen button flag
        self.screen_button_test_flag = 0
        self.button_status1 = SWITCH_STATUS(0,0,0,0)
        self.button_status2 = SWITCH_STATUS(0,0,0,0)
        self.button_status3 = SWITCH_STATUS(0,0,0,0)
        self.button_status4 = SWITCH_STATUS(0,0,0,0)
        self.button_status5 = SWITCH_STATUS(0,0,0,0)
        self.button_status6 = SWITCH_STATUS(0,0,0,0)
        self.button_status7 = SWITCH_STATUS(0,0,0,0)
        self.button_status8 = SWITCH_STATUS(0,0,0,0)
        self.screen_button_status_flag=[self.button_status1,self.button_status2,self.button_status3,self.button_status4,self.button_status5,self.button_status6,self.button_status7,self.button_status8]

        
        
        # walk motor flag
        self.walk_motor_test_flag = 0
        self.walk_motor_speed = 0.3 # 0.3m/s
        self.walk_motor_test_flag = 0 #40 hz data /25ms
        self.walk_motor_keeptime = 0 
        self.walk_motor_unkeeptime = 0
        self.left_motor_keeptime = 0 
        self.left_motor_unkeeptime = 0
        self.right_motor_keeptime = 0 
        self.right_motor_unkeeptime = 0 
        self.left_motor_current_average = 0
        self.right_motor_current_average = 0

        #  cut motor flag
        self.cut_motor_test_flag = 0
        self.cut_motor_speed = 3000 # 0.3m/s
        self.cut_motor_test_flag = 0 #40 hz data /25ms
        self.cut_motor_keeptime = 0
        self.cut_motor_unkeeptime = 0
        self.cut_motor_current_average = 0
        


        #LiftingMotor
        self.lifting_motor_test_flag = 0
        self.lifting_motor_height= 0
        self.lifting_motor_target_height = 0
        self.lifting_motor_time = 0 
        self.lifting_up_hall_status = SWITCH_STATUS(0,0,0,0)
        self.lifting_cnt_hall_status = SWITCH_STATUS(0,0,0,0)
        self.lifting_down_hall_status = SWITCH_STATUS(0,0,0,0)
        
        self.lifting_hall_status_flag=[self.lifting_up_hall_status,self.lifting_cnt_hall_status,self.lifting_down_hall_status]
        self.balde_height = UInt8()
        self.lifting_motor_status = 0


        #imu test
        self.imu_test_flag = 0
        self.imu_start_yaw_angle = 0.0
        self.imu_last_yaw_angle = 0.0


        #rtk_lora test
        self.rtk_lora_test_flag = 0
        self.rtk_lora_test_wait_cnt = 0
        self.rtk_lora_test_bestpos_qual = 0
        self.rtk_lora_test_satellite_num = 0
        self.rtk_lora_test_bestpos_diff_age = 0


        #tile test
        self.tile_test_flag = 0

        #tile test
        self.lifting_test_flag = 0

        #collision test
        self.collision_test_flag = 0

        #stop test
        self.stop_test_flag = 0


        



        timer_period = 0.2 # seconds
        self.timer = self.create_timer(timer_period, self.timer_callback)





    def stop_all_test(self):
        print("stop all test\r\n")
        self.screen_button_test_flag = 0
        self.hall_test_flag = 0
        self.walk_motor_test_flag = 0
        self.cut_motor_test_flag = 0
        self.lifting_motor_test_flag = 0
        self.imu_test_flag = 0
        self.rtk_lora_test_flag = 0
        self.tile_test_flag = 0
        self.lifting_test_flag = 0
        self.collision_test_flag = 0
        self.stop_test_flag = 0
    

############################         MQTT result ros  topic  subscriber  callback               #######################################################################
    def wheel_speed_result_pub(self, msg1,msg2,msg3,msg4,msg5,msg6):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_WHEEL_MOTOR,
            "WalkMotor_Left": 0,
            "WalkMotor_Right": 0,
                }
        data["WalkMotor_Left"] = msg1
        data["WalkMotor_Right"] = msg2
        data["WalkMotor_Left_AveCurrent_ma"] = msg3
        data["WalkMotor_Right_AveCurrent_ma"] = msg4
        data["WalkMotor_Left_Speed"] = msg5
        data["WalkMotor_Right_Speed"] = msg6
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)


    def blade_speed_result_pub(self, msg1,msg2,msg3):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_BLADE_MOTOR,
            "CutMotor": 0,
                }
        data["CutMotor"] = msg1
        data["CutMotor_AveCurrent_ma"] = msg2
        data["CutMotor_Speed"] = msg3
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def LiftingMotor_result_pub(self, height,msg,msg2):
        print(height)
        data =  {
            "sn": self.sn_value,
            "type": height,
            "hall_up": True,
            "hall_down": True,
            "hall_cnt": True,
            "lifting_motor":0
                }
        data["lifting_motor"] = msg
        if msg2 == 0:
            data["hall_up"] = True
            data["hall_down"] = True
            data["hall_cnt"] = True
        elif msg2 == 1: #up hall error
            data["hall_up"] = False
            data["hall_down"] = True
            data["hall_cnt"] = True
        elif msg2 == 2: #down hall error
            data["hall_up"] = True
            data["hall_down"] = False
            data["hall_cnt"] = True
        elif msg2 == 3: #cnt hall error
            data["hall_up"] = True
            data["hall_down"] = True
            data["hall_cnt"] = False
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)


    def imu_test_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_IMU,
            "imu": 0,
                }
        data["imu"] = msg
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def rtk_lora_test_result_pub(self, msg,msg2):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_RTK_LORA,
            "rtk": 0,
            "lora": 0,
                }
        data["satellite_num"] = msg2
        if msg == 0:
            data["rtk"] = 0
            data["lora"] = 0
        else:
            data["rtk"] = 1
            data["lora"] = 1
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)


    def tile_test_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_TILE,
                }
        data["tilt_angle"] = msg
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def lifting_test_result_pub(self, msg1, msg2):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_upraise,
                }
        data["hall_uplift_left"] = msg1
        data["hall_uplift_right"] = msg2
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def collision_test_result_pub(self, msg1, msg2, msg3, msg4):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_Collision,
                }
        data["hall_collision_left_front"]  = msg1
        data["hall_collision_left_behind"] = msg2
        data["hall_collision_right_front"] = msg3
        data["hall_collision_right_behind"] = msg4
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def stop_test_result_pub(self, msg1, msg2):
        data =  {
            "sn": self.sn_value,
            "type": TYPE_STOP_KEY,
                }
        data["hall_stop_key1"] = msg1
        data["hall_stop_key2"] = msg2
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)

    def screen_button_test_result_pub(self, msg1, msg2, msg3, msg4 ,msg5, msg6, msg7, msg8):
        data = {
                    "sn": self.sn_value,
                    "type": TYPE_SCREEN_BUTTON,
                    "left_button": False,
                    "right_button": False,
                    "up_button": False,
                    "down_button": False,
                    "switch_button": False,
                    "setting_button": False,
                    "back_button": False,
                    "enter_button": False
                    }
        if msg1 == 1:
            data["right_button"] = True
        else:
            data["right_button"] = False
        if msg2 == 1:
            data["left_button"] = True
        else:
            data["left_button"] = False
        if msg3 == 1:
            data["up_button"] = True
        else:
            data["up_button"] = False
        if msg4 == 1:
            data["down_button"] = True
        else:
            data["down_button"] = False
        if msg5 == 1:
            data["enter_button"] = True
        else:
            data["enter_button"] = False
        if msg6 == 1:
            data["back_button"] = True
        else:
            data["back_button"] = False
        if msg7 == 1:
            data["setting_button"] = True
        else:
            data["setting_button"] = False
        if msg8 == 1:
            data["switch_button"] = True
        else:
            data["switch_button"] = False
        json_data = json.dumps(data)
        msg = String()
        msg.data = json_data
        self.pub_factory_ack.publish(msg)




############################         MQTT topic  subscriber  callback               #######################################################################

    def sub_factory_cmd_callback(self, msg):
        payload_str = msg.data
        try:
            parsed_data = json.loads(payload_str)
            # 解析成功，继续处理解析后的数据
        except json.decoder.JSONDecodeError as e:
            # 解析错误，处理异常
            print("JSON解析错误:")
            print("错误位置:", e.pos)
            print("错误原因:", e.msg)
            print("错误内容:", e.doc)
            return

        # HallSensor test
        if parsed_data["type"] == TYPE_HALL_TEST:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.hall_test_flag = 1
                print("hall test start\r\n")
                for x in self.hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
            elif parsed_data["control"]  == CONTROL_STOP:
                self.hall_test_flag = 0
                print("hall test stop\r\n")
                for x in self.hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
        # ScreenButton test
        if parsed_data["type"] == TYPE_SCREEN_BUTTON:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.screen_button_test_flag = 1
                print("ScreenButton test start\r\n")
                for x in self.screen_button_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
            elif parsed_data["control"]  == CONTROL_STOP:
                self.screen_button_test_flag = 0
                print("ScreenButton test stop\r\n")
                for x in self.screen_button_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0



        # walk motor test
        if parsed_data["type"] == TYPE_WHEEL_MOTOR:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.motor_reset.publish(self.reset)
                self.balde_height.data = 90
                self.blade_height_pub.publish(self.balde_height)
                self.walk_motor_test_flag = 1
                self.left_motor_keeptime = 0
                self.left_motor_unkeeptime = 0
                self.right_motor_keeptime = 0
                self.right_motor_unkeeptime = 0
                print("WalkMotortest start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.walk_motor_test_flag = 0
                self.left_motor_keeptime = 0
                self.left_motor_unkeeptime = 0
                self.right_motor_keeptime = 0
                self.right_motor_unkeeptime = 0
                print("WalkMotor test stop\r\n")
        #  cut motor test
        if parsed_data["type"] == TYPE_BLADE_MOTOR:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.motor_reset.publish(self.reset)
                self.balde_height.data = 90
                self.blade_height_pub.publish(self.balde_height)
                self.cut_motor_test_flag = 1
                self.cut_motor_keeptime = 0
                self.cut_motor_unkeeptime = 0
                print("CutMotor test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.cut_motor_test_flag = 0
                self.cut_motor_keeptime = 0
                self.cut_motor_unkeeptime = 0
                print("CutMotor test stop\r\n")
        #  LiftingMotor test
        if parsed_data["type"] == TYPE_LiftingMotor_20 or parsed_data["type"] == TYPE_LiftingMotor_50 or parsed_data["type"] == TYPE_LiftingMotor_90 or parsed_data["type"] == TYPE_LiftingMotor_20_90 :
            if parsed_data["control"]  == CONTROL_START:
                if parsed_data["type"] == TYPE_LiftingMotor_20:
                    self.lifting_motor_target_height = 20
                elif parsed_data["type"] == TYPE_LiftingMotor_50:
                    self.lifting_motor_target_height = 50
                elif parsed_data["type"] == TYPE_LiftingMotor_90:
                    self.lifting_motor_target_height = 90
                elif parsed_data["type"] == TYPE_LiftingMotor_20_90:
                    self.lifting_motor_target_height = 2090
                for x in self.lifting_hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
                self.stop_all_test()
                self.lifting_motor_test_flag = 1
                self.lifting_motor_time = 0
                print("LiftingMotor test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.lifting_motor_test_flag = 0
                self.lifting_motor_time = 0
                for x in self.lifting_hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
                print("LiftingMotor test stop\r\n")
        #IMU test
        if parsed_data["type"] == TYPE_IMU:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.imu_test_flag = 1
                print("IMU test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.imu_test_flag = 0
                print("IMU test stop\r\n")
        #RTK_LORA test
        if parsed_data["type"] == TYPE_RTK_LORA:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.rtk_lora_test_flag = 1
                self.rtk_lora_test_wait_cnt = 0
                self.rtk_lora_test_bestpos_qual = 255
                self.rtk_lora_test_bestpos_diff_age = 255
                print("RTK_LORA test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.rtk_lora_test_flag = 0
                self.rtk_lora_test_wait_cnt = 0
                self.rtk_lora_test_bestpos_qual = 255
                self.rtk_lora_test_bestpos_diff_age = 255
                print("RTK_LORA test stop\r\n")
        #Tile test
        if parsed_data["type"] == TYPE_TILE:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.tile_test_flag = 1
                print("TileTest test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.tile_test_flag = 0
                print("TileTest test stop\r\n")
        #LiftingTest test
        if parsed_data["type"] == TYPE_upraise:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.lifting_test_flag = 1
                for x in self.hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
                print("LiftingTest test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.lifting_test_flag = 0
                print("LiftingTest test stop\r\n")
        #CollisionTest test
        if parsed_data["type"] == TYPE_Collision:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.collision_test_flag = 1
                for x in self.hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
                print("CollisionTest test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.collision_test_flag = 0
                print("CollisionTest test stop\r\n")
        #StopTest test
        if parsed_data["type"] == TYPE_STOP_KEY:
            if parsed_data["control"]  == CONTROL_START:
                self.stop_all_test()
                self.stop_test_flag = 1
                for x in self.hall_status_flag:
                    x.success_flag = 0
                    x.trigger_flag = 0
                    x.time = 0
                print("StopTest test start\r\n")
            elif parsed_data["control"]  == CONTROL_STOP:
                self.stop_test_flag = 0
                print("StopTest test stop\r\n")
        
        #StopTest test
        if parsed_data["type"] == TYPE_RTK_LORA_ADDR_SET:
            goal_msg = ChassisLoraSet.Goal()
            
            if parsed_data["control"]  == 1: #set lora 
                if parsed_data["channel_address_id"]  == 0: # first addr
                    print("first start\r\n")
                    goal_msg.channel = LORA_CHANNEL_1  # 设置目标参数
                    goal_msg.addr = LORA_ADDR_1  # 设置目标参数
                elif parsed_data["channel_address_id"]  == 1: #second addr
                    print("second start\r\n")
                    goal_msg.channel = LORA_CHANNEL_2  # 设置目标参数
                    goal_msg.addr = LORA_ADDR_2  # 设置目标参数
                print(f"lora set Result: channel={goal_msg.channel}, addr={goal_msg.addr}")
                future = self.action_client.send_goal_async(goal_msg)
            elif parsed_data["control"]  == 0: #reset lora
                print("reset lora\r\n")
                goal_msg.channel = LORA_CHANNEL_RESET  # 设置目标参数
                goal_msg.addr = LORA_ADDR_RESET  # 设置目标参数
                print(f"lora set Result: channel={goal_msg.channel}, addr={goal_msg.addr}")
                future = self.action_client.send_goal_async(goal_msg)
            
        









############################        hall get  ros  topic  subscriber  callback               #######################################################################
    def hall_callback(self, msg):
        self.hall_status_flag[0].num_status = msg.hall_uplift_left
        self.hall_status_flag[1].num_status = msg.hall_uplift_right
        self.hall_status_flag[2].num_status = msg.hall_collision_left_front
        self.hall_status_flag[3].num_status = msg.hall_collision_left_behind
        self.hall_status_flag[4].num_status = msg.hall_collision_right_front
        self.hall_status_flag[5].num_status = msg.hall_collision_right_behind
        self.hall_status_flag[6].num_status = msg.hall_key_left
        self.hall_status_flag[7].num_status = msg.hall_key_right
        if self.hall_test_flag == 1 or self.lifting_test_flag == 1 or self.collision_test_flag == 1 or self.stop_test_flag == 1:
            for x in self.hall_status_flag:
                if x.num_status == 0 and x.trigger_flag == 0:
                    x.trigger_flag = 1
                    x.time = self.get_clock().now()
                if x.trigger_flag == 1:
                    if (self.get_clock().now() - x.time).to_msg().sec >= 1.0:
                        x.trigger_flag = 0
                    elif x.num_status == 1:
                        x.success_flag = 1
                        x.trigger_flag = 0
        
        if self.lifting_motor_test_flag == 1:
            self.lifting_hall_status_flag[0].num_status = msg.hall_cutmotor_up
            self.lifting_hall_status_flag[1].num_status = msg.hall_cutmotor_cnt
            self.lifting_hall_status_flag[2].num_status = msg.hall_cutmotor_down
            if self.lifting_motor_test_flag == 1:
                for x in self.lifting_hall_status_flag:
                    if x.num_status == 1 and x.trigger_flag == 0:
                        x.trigger_flag = 1
                        x.time = self.get_clock().now()
                    if x.trigger_flag == 1:
                        if (self.get_clock().now() - x.time).to_msg().sec >= 1.0:
                            x.trigger_flag = 0
                        elif x.num_status == 0:
                            x.success_flag = 1
                            x.trigger_flag = 0




############################        screen_button get  ros  topic  subscriber  callback               #######################################################################
    def screen_button_status_callback(self, msg):
        self.screen_button_status_flag[0].num_status = 0
        self.screen_button_status_flag[1].num_status = 0
        self.screen_button_status_flag[2].num_status = 0
        self.screen_button_status_flag[3].num_status = 0
        self.screen_button_status_flag[4].num_status = 0
        self.screen_button_status_flag[5].num_status = 0
        self.screen_button_status_flag[6].num_status = 0
        self.screen_button_status_flag[7].num_status = 0
        
        if(msg.data!=0):
            self.screen_button_status_flag[msg.data - 1].num_status = 1
        if self.screen_button_test_flag == 1:
            print("button msg.data",msg.data)
            for x in self.screen_button_status_flag:
                if x.num_status == 1 and x.trigger_flag == 0:
                    x.trigger_flag = 1
                    x.time = self.get_clock().now()
                if x.trigger_flag == 1:
                    if (self.get_clock().now() - x.time).to_msg().sec >= 1.0:
                        x.trigger_flag = 0
                    elif x.num_status == 0:
                        x.success_flag = 1
                        x.trigger_flag = 0




    walk_motor_cnt = 0
    cut_motor_cnt = 0
    left_result = -1
    right_result = -1

    left_motor_current_result =0
    right_motor_current_result =0
    left_motor_speed_result =0
    right_motor_speed_result =0
    left_speed_total = 0
    right_speed_total = 0

############################         wheel speed get  ros  topic  subscriber  callback               #######################################################################
    def wheel_speed_get_callback(self, msg):
        # 25ms loop
        if self.walk_motor_test_flag == 1:
            self.left_motor_keeptime += 1
            self.left_speed_total += msg.left_speed 
            self.right_speed_total += msg.right_speed
            if self.left_motor_keeptime == 80: #25*80 = 2s
                print("start cal current")
                self.walk_motor_cnt = 0
                self.left_motor_current_average = 0
                self.right_motor_current_average = 0
                self.left_speed_total = 0
                self.right_speed_total = 0
            elif self.left_motor_keeptime == 80*5: #10s
                print("end test")
                self.left_motor_current_result = self.left_motor_current_average / self.walk_motor_cnt
                self.right_motor_current_result = self.right_motor_current_average / self.walk_motor_cnt
                self.left_motor_speed_result = self.left_speed_total / (80*4)
                self.right_motor_speed_result = self.right_speed_total / (80*4)
                self.wheel_speed_result_pub(0,0,self.left_motor_current_result,self.right_motor_current_result,self.left_motor_speed_result,self.right_motor_speed_result) #result
                self.walk_motor_test_flag = 0
                self.walk_motor_cnt = 0
                self.left_motor_current_average = 0
                self.right_motor_current_average = 0
                self.left_speed_total = 0
                self.right_speed_total = 0


    cut_motor_current_result = 0
    cut_motor_speed_total = 0
    cut_motor_speed_result =0
############################         blade speeed get  ros  topic  subscriber  callback               #######################################################################
    def blade_speed_get_callback(self, msg):
        # 25ms loop
        if self.cut_motor_test_flag == 1:
            self.cut_motor_keeptime += 1
            self.cut_motor_speed_total += msg.data
            if self.cut_motor_keeptime == 80*3: #25*240 = 6s
                print("start cal current")
                self.cut_motor_speed_total = 0
                self.cut_motor_current_average = 0
                self.cut_motor_cnt = 0
            elif self.cut_motor_keeptime == 80*7: #14s
                print("test end")
                self.cut_motor_current_result = self.cut_motor_current_average / self.cut_motor_cnt
                self.cut_motor_speed_result = self.cut_motor_speed_total / (80*4)
                self.blade_speed_result_pub(0,self.cut_motor_current_result,self.cut_motor_speed_result) #success
                self.cut_motor_test_flag = 0
                self.cut_motor_speed_total = 0
                self.cut_motor_current_average = 0
                self.cut_motor_cnt = 0


############################        motor current get  ros  topic  subscriber  callback               #######################################################################

    def motor_current_status_callback(self, msg):
        if self.cut_motor_test_flag == 1:
            self.cut_motor_current_average += msg.cut_motor_current_ma
            self.cut_motor_cnt += 1
        else:
            self.cut_motor_current_average = 0
            self.cut_motor_cnt = 0
        if self.walk_motor_test_flag == 1:
            self.left_motor_current_average += msg.left_motor_current_ma
            self.right_motor_current_average += msg.right_motor_current_ma
            self.walk_motor_cnt += 1
        else:
            self.left_motor_current_average = 0
            self.right_motor_current_average = 0
            self.walk_motor_cnt = 0


############################        bestpos_parsed_data_callback  ros  topic  subscriber  callback               #######################################################################


    
    def bestpos_parsed_data_callback(self, msg):
        #200ms loop
        if self.rtk_lora_test_flag == 1:
            self.rtk_lora_test_bestpos_qual = msg.qual
            self.rtk_lora_test_bestpos_diff_age = msg.diff_age
            self.rtk_lora_test_satellite_num = msg.sol_in_svs



    



############################         blade heigh ros  topic  subscriber  callback               #######################################################################
    def blade_height_get_callback(self, msg):
        if self.lifting_motor_test_flag >= 1:
            self.lifting_motor_height = msg.data

    
############################         imu ros  topic  subscriber  callback               #######################################################################

    imu_callback_time = 0

    def imu_callback(self, msg):

        #10ms loop
        if self.imu_test_flag >= 1 or self.tile_test_flag == 1:
            
            # 声明一个 Decimal 类型的浮点数
            q0 = msg.orientation.w
            q1 = msg.orientation.x
            q2 = msg.orientation.y
            q3 = msg.orientation.z
            q = np.array([q0, q1, q2, q3])

            # 将四元数转换为旋转矩阵
            q_conj = np.array([q[0], -q[1], -q[2], -q[3]])
            R = np.array([[1-2*(q[2]**2+q[3]**2), 2*(q[1]*q[2]-q[0]*q[3]), 2*(q[0]*q[2]+q[1]*q[3])],
                        [2*(q[1]*q[2]+q[0]*q[3]), 1-2*(q[1]**2+q[3]**2), 2*(q[2]*q[3]-q[0]*q[1])],
                        [2*(q[1]*q[3]-q[0]*q[2]), 2*(q[0]*q[1]+q[2]*q[3]), 1-2*(q[1]**2+q[2]**2)]])

            # 计算偏航角
            yaw = np.arctan2(R[1,0], R[0,0])
            # 计算俯仰角
            pitch = np.arcsin(-R[2, 0])
            # 计算翻滚角
            roll = np.arctan2(R[2, 1], R[2, 2])
            
            yaw_angle = math.degrees(yaw)
            pitch_angle = math.degrees(pitch)
            roll_angle = math.degrees(roll)


            if self.imu_test_flag >= 1:

                print("yaw angle",yaw_angle)
                if self.imu_test_flag == 1:
                    self.imu_start_yaw_angle = yaw_angle
                    self.imu_test_flag = 2
                elif self.imu_test_flag == 2:
                    if abs(yaw_angle - self.imu_start_yaw_angle) >= 70:
                        self.imu_test_flag = 3
                elif self.imu_test_flag == 3:
                    if abs(yaw_angle - self.imu_start_yaw_angle) >= 170:
                        self.imu_test_flag = 4
                elif self.imu_test_flag == 4:
                    if abs(yaw_angle - self.imu_start_yaw_angle) <= 250:
                        self.imu_test_flag = 5
                elif self.imu_test_flag == 5:
                    if abs(yaw_angle - self.imu_start_yaw_angle) <= 170:
                        self.imu_test_flag = 6
                elif self.imu_test_flag == 6:
                    if abs(yaw_angle - self.imu_start_yaw_angle) <= 70:
                        self.imu_test_flag = 7
                elif self.imu_test_flag == 7:
                    if abs(yaw_angle - self.imu_start_yaw_angle) <= 5:
                        print("imu test succes")
                        self.imu_test_flag = 0
                        self.imu_test_result_pub(0)

            if self.tile_test_flag == 1:
                # 计算旋转矩阵
                rotation_matrix = np.array([[np.cos(pitch), -np.sin(roll)*np.sin(pitch), -np.cos(roll)*np.sin(pitch)],
                                            [0, np.cos(roll), -np.sin(roll)],
                                            [np.sin(pitch), np.sin(roll)*np.cos(pitch), np.cos(roll)*np.cos(pitch)]])

                # 计算与水平面的夹角
                angle_with_horizontal = np.arccos(rotation_matrix[2, 2])

                # 将弧度转换为度数
                angle_with_horizontal_deg = np.degrees(angle_with_horizontal)

                # 打印与水平面的夹角
                # print("与水平面的夹角: ", angle_with_horizontal_deg)
                self.imu_callback_time += 1
                if(self.imu_callback_time > 20): #200ms
                    self.imu_callback_time = 0
                    self.tile_test_result_pub(angle_with_horizontal_deg)

                
        


        








            
# ############          hall_test                    ############################################ 
        
    hall_test_loop_time = 0
    def hall_test(self):
        # 0.2S loop
        # hall_test
        
        if self.lifting_test_flag == 1:
            if self.hall_status_flag[0].success_flag == 1:
                hall_uplift_left = True
            else:
                hall_uplift_left = False
            if self.hall_status_flag[1].success_flag == 1:
                hall_uplift_right = True
            else:
                hall_uplift_right = False
            self.lifting_test_result_pub(hall_uplift_left,hall_uplift_right)

        if self.collision_test_flag == 1:
            if self.hall_status_flag[2].success_flag == 1:
                hall_collision_left_front = True
            else:
                hall_collision_left_front = False
            if self.hall_status_flag[3].success_flag == 1:
                hall_collision_left_behind = True
            else:
                hall_collision_left_behind = False
            if self.hall_status_flag[4].success_flag == 1:
                hall_collision_right_front = True
            else:
                hall_collision_right_front = False
            if self.hall_status_flag[5].success_flag == 1:
                hall_collision_right_behind = True
            else:
                hall_collision_right_behind = False
            self.collision_test_result_pub(hall_collision_left_front,hall_collision_left_behind,hall_collision_right_front,hall_collision_right_behind)

        if self.stop_test_flag == 1:
            if self.hall_status_flag[6].success_flag == 1:
                hall_stop_key1 = True
            else:
                hall_stop_key1 = False
            if self.hall_status_flag[7].success_flag == 1:
                hall_stop_key2 = True
            else:
                hall_stop_key2 = False
            self.stop_test_result_pub(hall_stop_key1,hall_stop_key2)







# ############          hall_test                    ############################################ 
        
    def screen_button_test(self):
        # 0.2S loop
        # screen_button_test
        
        if self.screen_button_test_flag == 1:
            self.screen_button_test_result_pub(self.screen_button_status_flag[0].success_flag, \
                                                self.screen_button_status_flag[1].success_flag, \
                                                 self.screen_button_status_flag[2].success_flag, \
                                                  self.screen_button_status_flag[3].success_flag, \
                                                    self.screen_button_status_flag[4].success_flag, \
                                                     self.screen_button_status_flag[5].success_flag, \
                                                        self.screen_button_status_flag[6].success_flag, \
                                                            self.screen_button_status_flag[7].success_flag)


        

# ############          walk_motor_test                    ############################################ 
    def walk_motor_test(self):
        # walk motor test
        if self.walk_motor_test_flag == 1:
            twist = Twist()
            twist.linear.x = self.walk_motor_speed
            twist.linear.y = 0.0
            twist.linear.z = 0.0

            twist.angular.x = 0.0
            twist.angular.y = 0.0
            twist.angular.z = 0.0
            self.cmd_vel_pub.publish(twist)


# ############          cut_motor_test                    ############################################ 
    def cut_motor_test(self):
        # cut motor test
        if self.cut_motor_test_flag == 1:
            balde_speed = Int16()
            balde_speed.data = self.cut_motor_speed 
            self.blade_pub.publish(balde_speed)


# ############          LiftingMotor                    ############################################ 
    # ############          LiftingMotor                    ############################################ 
    height_str = ""
    hall_error_data = 0
    def LiftingMotor_test(self):
        #LiftingMotor
        
        
        if self.lifting_motor_test_flag == 1:
            print("lifting_motor_test motor to ",self.lifting_motor_target_height)

            if(self.lifting_motor_target_height == 20):#up
                self.height_str = TYPE_LiftingMotor_20
                self.hall_error_data = 1
            elif(self.lifting_motor_target_height == 50): #cnt
                self.height_str = TYPE_LiftingMotor_50
                self.hall_error_data = 3
            elif(self.lifting_motor_target_height == 90): #down
                self.height_str = TYPE_LiftingMotor_90
                self.hall_error_data = 2
            elif(self.lifting_motor_target_height == 2090): #down
                self.height_str = TYPE_LiftingMotor_20_90
                self.hall_error_data = 1
            
            if (self.lifting_motor_target_height == 20 or self.lifting_motor_target_height == 50 or self.lifting_motor_target_height == 90):
                self.lifting_motor_time = 0
                self.balde_height.data = self.lifting_motor_target_height
                self.blade_height_pub.publish(self.balde_height)
                self.lifting_motor_test_flag = 2
            elif self.lifting_motor_target_height == 2090:
                self.lifting_motor_time = 0
                self.balde_height.data = 20
                self.blade_height_pub.publish(self.balde_height)
                self.lifting_motor_test_flag = 3
        elif self.lifting_motor_test_flag == 2:
            self.lifting_motor_time += 1 #200ms loop
            if self.lifting_motor_height == self.lifting_motor_target_height:
                if self.lifting_motor_time < 10:
                    self.lifting_motor_test_flag = 0
                    print("lifting_motor_test motor down hall error")
                    self.LiftingMotor_result_pub(self.height_str,0,self.hall_error_data) #FAIL hall error
                else:
                    print("lifting_motor_test motor success")
                    self.lifting_motor_test_flag = 0
                    
                    self.LiftingMotor_result_pub(self.height_str,0,0) #SUCCESS
            elif self.lifting_motor_time >= 200:
                print("lifting_motor_test motor stall")
                self.lifting_motor_test_flag = 0
                self.LiftingMotor_result_pub(self.height_str,1,0) #FAIL motor error

        #20~90
        elif self.lifting_motor_test_flag == 3:
            self.lifting_motor_time += 1 #200ms loop
            if self.lifting_motor_height == 20:
                if self.lifting_motor_time < 10:
                    self.lifting_motor_test_flag = 0
                    print("lifting_motor_test motor down hall error")
                    self.LiftingMotor_result_pub(self.height_str,0,self.hall_error_data) #FAIL hall error
                else:
                    print("lifting_motor_test motor 20 success")
                    self.lifting_motor_time = 0
                    self.balde_height.data = 90
                    self.blade_height_pub.publish(self.balde_height)
                    self.lifting_motor_test_flag = 4
            elif self.lifting_motor_time >= 200:
                print("lifting_motor_test motor stall")
                self.lifting_motor_test_flag = 0
                self.LiftingMotor_result_pub(self.height_str,1,0) #FAIL motor error
        elif self.lifting_motor_test_flag == 4:
            self.lifting_motor_time += 1 #200ms loop
            if self.lifting_motor_height == 90:
                if self.lifting_motor_time < 10:
                    self.lifting_motor_test_flag = 0
                    print("lifting_motor_test motor down hall error")
                    self.LiftingMotor_result_pub(self.height_str,0,self.hall_error_data) #FAIL hall error
                else:
                    print("lifting_motor_test motor success")
                    self.lifting_motor_test_flag = 0
                    
                    self.LiftingMotor_result_pub(self.height_str,0,0) #SUCCESS
            elif self.lifting_motor_time >= 200:
                print("lifting_motor_test motor stall")
                self.lifting_motor_test_flag = 0
                self.LiftingMotor_result_pub(self.height_str,1,0) #FAIL motor error


# ############          rtk lora test                    ############################################ 
    def RTK_LORA_test(self):
        #rtk lora test
        if self.rtk_lora_test_flag == 1:
            self.rtk_lora_test_wait_cnt +=1
            print("rtk_location_lost_callback " ,self.rtk_lora_test_wait_cnt)
            print("rtk_lora_test_bestpos_qual " ,self.rtk_lora_test_bestpos_qual)
            if self.rtk_lora_test_bestpos_qual == 4 or self.rtk_lora_test_bestpos_qual == 5:
                self.rtk_lora_test_result_pub(0,self.rtk_lora_test_satellite_num)
                self.rtk_lora_test_flag = 0
            elif self.rtk_lora_test_wait_cnt >= 100:
                self.rtk_lora_test_result_pub(1,self.rtk_lora_test_satellite_num)
                self.rtk_lora_test_flag = 0
                
    


# ############          timer_callback                    ############################################ 
    def timer_callback(self):
        # 0.2S loop
        # hall_test
        self.hall_test()
        # walk motor test
        self.walk_motor_test()
        # cut motor test
        self.cut_motor_test()
        # LiftingMotor
        self.LiftingMotor_test()
        #rtk lora test
        self.RTK_LORA_test()

        self.screen_button_test()


 





def main(args=None):
    rclpy.init(args=args)

    chassis_mqtt = ChassisMQTT()
    rclpy.spin(chassis_mqtt)
    chassis_mqtt.destroy_node()
    rclpy.shutdown()



if __name__ == '__main__':
    main()
