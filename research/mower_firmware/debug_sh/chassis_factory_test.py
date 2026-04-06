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
from std_msgs.msg import Int16

from std_msgs.msg import Bool

import json



import random
import time
import paho.mqtt.client as mqtt

import math
import numpy as np




from paho.mqtt import client as mqtt_client


import json
 
from geometry_msgs.msg import Twist

from sensor_msgs.msg import Imu



from rclpy.qos import qos_profile_system_default
from rclpy.qos import qos_profile_services_default







# hall test value

class SWITCH_STATUS:
    def __init__(self,status,trigger,time,success):
        self.num_status = status
        self.trigger_flag = trigger
        self.time = time
        self.success_flag = success








broker = 'broker.emqx.io'
port = 1883
topic = "/mqtt/demo"
# generate client ID with pub prefix randomly
# client_id = f'python-mqtt-{random.randint(0, 1000)}'
client_id = "/edge/bdlf"
 
parsed_data = 0




# file_path = "/home/zxl/Desktop/json_config.json"

file_path = "/userdata/lfi/json_config.json"



    


class ChassisMQTT(Node):
    def __init__(self):
        super().__init__('ChassisMQTT')

        self.sleep_rate = 0.025
        self.rate = 10
        self.r = self.create_rate(self.rate)
        self.broker_address= self.declare_parameter("~broker_ip_address", '119.23.212.113').value


        with open(file_path) as file:
            self.json_data = json.load(file)

        self.sn_value = self.json_data["sn"]["value"]["code"]

        self.version = "1.0.1"

        print("VERION:",self.version)
        print("SN:",self.sn_value)
        
        self.STATUS_PUB_TOPIC = self.declare_parameter("~chassis_pub_topic", 'tools/mcus_data_' + self.sn_value).value
        # self.STATUS_PUB_TOPIC = self.declare_parameter("~chassis_pub_topic", 'tools/' + sn_value).value
        self.SELF_CKECK_CONTROL_SUB_TOPIC = self.declare_parameter("~chassis_self_check_sub_topic", 'tools/mcus_control_' + self.sn_value).value
        self.mqttclient = mqtt.Client("ros2mqtt") 


        

        self.mqttclient.connect(self.broker_address)
        
        self.get_logger().info('relay_ros2_mqtt:: started...')
        self.get_logger().info(f'relay_ros2_mqtt:: broker_address = {self.broker_address}')
        self.get_logger().info(f'relay_ros2_mqtt:: MQTT_PUB_TOPIC = {self.STATUS_PUB_TOPIC}')
        self.get_logger().info(f'relay_ros2_mqtt:: ROS_TWIST_SUB_TOPIC = {self.SELF_CKECK_CONTROL_SUB_TOPIC}')

        self.mqttclient.on_message = self.chssis_shelfcheck_control_callback
        self.mqttclient.subscribe(self.SELF_CKECK_CONTROL_SUB_TOPIC, qos=1) #to subscribe more than one topic add more subscribe lines
        self.mqttclient.loop_start()



        # ros2 pub


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

        self.subscription6 = self.create_subscription(
            Bool,
            'rtk_location_lost_flag',
            self.rtk_location_lost_callback,
            10)

        self.subscription7 = self.create_subscription(
            UInt8,
            'screen_button_status',
            self.screen_button_status_callback,
            10)    

            
            




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

        #  cut motor flag
        self.cut_motor_test_flag = 0
        self.cut_motor_speed = 3000 # 0.3m/s
        self.cut_motor_test_flag = 0 #40 hz data /25ms
        self.cut_motor_keeptime = 0
        self.cut_motor_unkeeptime = 0 


        #LiftingMotor
        self.lifting_motor_test_flag = 0
        self.lifting_motor_height = 0
        self.lifting_motor_time = 0 
        self.lifting_up_hall_status = SWITCH_STATUS(0,0,0,0)
        self.lifting_cnt_hall_status = SWITCH_STATUS(0,0,0,0)
        self.lifting_down_hall_status = SWITCH_STATUS(0,0,0,0)
        
        self.lifting_hall_status_flag=[self.lifting_up_hall_status,self.lifting_cnt_hall_status,self.lifting_down_hall_status]
        self.balde_height = UInt8()



        #imu test
        self.imu_test_flag = 0
        self.imu_start_yaw_angle = 0.0
        self.imu_last_yaw_angle = 0.0


        #rtk_lora test
        self.rtk_lora_test_flag = 0
        self.rtk_lora_test_wait_cnt = 0

        timer_period = 0.2 # seconds
        self.timer = self.create_timer(timer_period, self.timer_callback)




    def hall_callback(self, msg):
        self.hall_status_flag[0].num_status = msg.hall_uplift_left
        self.hall_status_flag[1].num_status = msg.hall_uplift_right
        self.hall_status_flag[2].num_status = msg.hall_collision_left_front
        self.hall_status_flag[3].num_status = msg.hall_collision_left_behind
        self.hall_status_flag[4].num_status = msg.hall_collision_right_front
        self.hall_status_flag[5].num_status = msg.hall_collision_right_behind
        self.hall_status_flag[6].num_status = msg.hall_key_left
        self.hall_status_flag[7].num_status = msg.hall_key_right
        if self.hall_test_flag == 1:
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
                        print("success")

    


    def wheel_speed_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": "WalkMotor",
            "WalkMotor_Left": 0,
            "WalkMotor_Right": 0,
                }
        data["WalkMotor_Left"] = msg
        data["WalkMotor_Right"] = msg
        json_data = json.dumps(data)
        self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)


    def blade_speed_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": "CutMotor",
            "CutMotor": 0,
                }
        data["CutMotor"] = msg
        json_data = json.dumps(data)
        self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)

    def LiftingMotor_result_pub(self, msg,msg2):
        data =  {
            "sn": self.sn_value,
            "type": "LiftingMotor",
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
        json_data = json.dumps(data)
        self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)


    def imu_test_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": "IMU",
            "imu": 0,
                }
        data["imu"] = msg
        json_data = json.dumps(data)
        self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)

    def rtk_lora_test_result_pub(self, msg):
        data =  {
            "sn": self.sn_value,
            "type": "RTK_LORA",
            "rtk": 0,
            "lora": 0,
                }
        if msg == 0:
            data["rtk"] = 0
            data["lora"] = 0
        else:
            data["rtk"] = 1
            data["lora"] = 1
        json_data = json.dumps(data)
        self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)




    def wheel_speed_get_callback(self, msg):
        if self.walk_motor_test_flag == 1:
            if(msg.left_speed >= self.walk_motor_speed*800  and  msg.left_speed <= self.walk_motor_speed*1200 
                and msg.right_speed >= self.walk_motor_speed*800  and  msg.right_speed <= self.walk_motor_speed*1200):
                self.walk_motor_keeptime += 1
                if self.walk_motor_keeptime >= 80:
                    self.wheel_speed_result_pub(0) #success
                    self.walk_motor_test_flag = 0
            else:
                self.walk_motor_unkeeptime += 1
                if self.walk_motor_unkeeptime >= 80:
                    self.wheel_speed_result_pub(1) #fail
                    self.walk_motor_test_flag = 0
    
    def blade_speed_get_callback(self, msg):
        if self.cut_motor_test_flag == 1:
            if(msg.data >= self.cut_motor_speed*0.8 and  msg.data <= self.cut_motor_speed*1.2 ):
                self.cut_motor_keeptime += 1
                if self.cut_motor_keeptime >= 200:
                    self.blade_speed_result_pub(0) #success
                    self.cut_motor_test_flag = 0
            else:
                self.cut_motor_unkeeptime += 1
                if self.cut_motor_unkeeptime >= 200:
                    self.blade_speed_result_pub(1) #fail
                    self.cut_motor_test_flag = 0

    def blade_height_get_callback(self, msg):
        if self.lifting_motor_test_flag >= 1:
            self.lifting_motor_height = msg.data

    

    def imu_callback(self, msg):
        if self.imu_test_flag >= 1:
            
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
            angle = math.degrees(yaw)
            print("yaw angle",angle)
            if self.imu_test_flag == 1:
                self.imu_start_yaw_angle = angle
                self.imu_test_flag = 2
            elif self.imu_test_flag == 2:
                if abs(angle - self.imu_start_yaw_angle) >= 70:
                    self.imu_test_flag = 3
            elif self.imu_test_flag == 3:
                if abs(angle - self.imu_start_yaw_angle) >= 170:
                    self.imu_test_flag = 4
            elif self.imu_test_flag == 4:
                if abs(angle - self.imu_start_yaw_angle) <= 250:
                    self.imu_test_flag = 5
            elif self.imu_test_flag == 5:
                if abs(angle - self.imu_start_yaw_angle) <= 170:
                    self.imu_test_flag = 6
            elif self.imu_test_flag == 6:
                if abs(angle - self.imu_start_yaw_angle) <= 70:
                    self.imu_test_flag = 7
            elif self.imu_test_flag == 7:
                if abs(angle - self.imu_start_yaw_angle) <= 5:
                    print("imu test succes")
                    self.imu_test_flag = 0
                    self.imu_test_result_pub(0)

    def rtk_location_lost_callback(self, msg):
        #200ms loop
        if self.rtk_lora_test_flag == 1:
            self.rtk_lora_test_wait_cnt +=1
            print("rtk_location_lost_callback " ,self.rtk_lora_test_wait_cnt)
            if msg.data == True:
                self.rtk_lora_test_result_pub(1)
                self.rtk_lora_test_flag = 0
            elif self.rtk_lora_test_wait_cnt >= 20:
                self.rtk_lora_test_result_pub(0)
                self.rtk_lora_test_flag = 0
        




############################         MQTT topic  subscriber  callback               #######################################################################

    def chssis_shelfcheck_control_callback(self, client, userdata, msg):
        topic = msg.topic
        if topic == self.SELF_CKECK_CONTROL_SUB_TOPIC:
            payload_str = str(msg.payload.decode("utf-8"))
            


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
            if parsed_data["type"] == "HallSensor":
                if parsed_data["control"]  == "start_check":
                    self.hall_test_flag = 1
                    print("hall test start\r\n")
                    for x in self.hall_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0
                elif parsed_data["control"]  == "stop_check":
                    self.hall_test_flag = 0
                    print("hall test stop\r\n")
                    for x in self.hall_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0
            # ScreenButton test
            if parsed_data["type"] == "ScreenButton":
                if parsed_data["control"]  == "start_check":
                    self.screen_button_test_flag = 1
                    print("ScreenButton test start\r\n")
                    for x in self.screen_button_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0
                elif parsed_data["control"]  == "stop_check":
                    self.screen_button_test_flag = 0
                    print("ScreenButton test stop\r\n")
                    for x in self.screen_button_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0



            # walk motor test
            if parsed_data["type"] == "WalkMotor":
                if parsed_data["control"]  == "start_check":
                    self.motor_reset.publish(self.reset)
                    self.walk_motor_test_flag = 1
                    self.walk_motor_keeptime = 0
                    self.walk_motor_unkeeptime = 0
                    print("WalkMotortest start\r\n")
                elif parsed_data["control"]  == "stop_check":
                    self.walk_motor_test_flag = 0
                    self.walk_motor_keeptime = 0
                    self.walk_motor_unkeeptime = 0
                    print("WalkMotor test stop\r\n")
            #  cut motor test
            if parsed_data["type"] == "CutMotor":
                if parsed_data["control"]  == "start_check":
                    self.motor_reset.publish(self.reset)
                    self.cut_motor_test_flag = 1
                    self.cut_motor_keeptime = 0
                    self.cut_motor_unkeeptime = 0
                    print("CutMotor test start\r\n")
                elif parsed_data["control"]  == "stop_check":
                    self.cut_motor_test_flag = 0
                    self.cut_motor_keeptime = 0
                    self.cut_motor_unkeeptime = 0
                    print("CutMotor test stop\r\n")
            #  LiftingMotor test
            if parsed_data["type"] == "LiftingMotor":
                if parsed_data["control"]  == "start_check":
                    self.lifting_motor_test_flag = 1
                    self.lifting_motor_time = 0
                    for x in self.lifting_hall_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0
                    print("LiftingMotor test start\r\n")
                elif parsed_data["control"]  == "stop_check":
                    self.lifting_motor_test_flag = 0
                    self.lifting_motor_time = 0
                    for x in self.lifting_hall_status_flag:
                        x.success_flag = 0
                        x.trigger_flag = 0
                        x.time = 0
                    print("LiftingMotor test stop\r\n")
            #IMU test
            if parsed_data["type"] == "IMU":
                if parsed_data["control"]  == "start_check":
                    self.imu_test_flag = 1
                    print("IMU test start\r\n")
                elif parsed_data["control"]  == "stop_check":
                    self.imu_test_flag = 0
                    print("IMU test stop\r\n")
            #RTK_LORA test
            if parsed_data["type"] == "RTK_LORA":
                if parsed_data["control"]  == "start_check":
                    self.rtk_lora_test_flag = 1
                    print("RTK_LORA test start\r\n")
                elif parsed_data["control"]  == "stop_check":
                    self.rtk_lora_test_flag = 0
                    print("RTK_LORA test stop\r\n")




            
# ############          hall_test                    ############################################ 
        
    hall_test_loop_time = 0
    def hall_test(self):
        # 0.2S loop
        # hall_test
        if self.hall_test_flag == 1:
            self.hall_test_loop_time += 1
            if(self.hall_test_loop_time <=2):
                return
            self.hall_test_loop_time = 0
            data = {
                    "sn": self.sn_value,
                    "type": "HallSensor",
                    "hall_uplift_left": False,
                    "hall_uplift_right": False,
                    "hall_collision_left_front": False,
                    "hall_collision_left_behind": False,
                    "hall_collision_right_front": False,
                    "hall_collision_right_behind": False,
                    "hall_stop_key1": False,
                    "hall_stop_key2": False
                    }
            
            if self.hall_status_flag[0].success_flag == 1:
                data["hall_uplift_left"] = True
            else:
                data["hall_uplift_left"] = False
            if self.hall_status_flag[1].success_flag == 1:
                data["hall_uplift_right"] = True
            else:
                data["hall_uplift_right"] = False
            if self.hall_status_flag[2].success_flag == 1:
                data["hall_collision_left_front"] = True
            else:
                data["hall_collision_left_front"] = False
            if self.hall_status_flag[3].success_flag == 1:
                data["hall_collision_left_behind"] = True
            else:
                data["hall_collision_left_behind"] = False
            if self.hall_status_flag[4].success_flag == 1:
                data["hall_collision_right_front"] = True
            else:
                data["hall_collision_right_front"] = False
            if self.hall_status_flag[5].success_flag == 1:
                data["hall_collision_right_behind"] = True
            else:
                data["hall_collision_right_behind"] = False
            if self.hall_status_flag[6].success_flag == 1:
                data["hall_stop_key1"] = True
            else:
                data["hall_stop_key1"] = False
            if self.hall_status_flag[7].success_flag == 1:
                data["hall_stop_key2"] = True
            else:
                data["hall_stop_key2"] = False
            json_data = json.dumps(data)
            self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)


# ############          screen_button_test                    ############################################ 
        
    screen_button_test_loop_time = 0
    def screen_button_test(self):
        # 0.2S loop
        # screen_button_test
        if self.screen_button_test_flag == 1:
            self.screen_button_test_loop_time += 1
            if(self.screen_button_test_loop_time <=2):
                return
            self.screen_button_test_loop_time = 0
            data = {
                    "sn": self.sn_value,
                    "type": "ScreenButton",
                    "left_button": False,
                    "right_button": False,
                    "up_button": False,
                    "down_button": False,
                    "switch_button": False,
                    "setting_button": False,
                    "back_button": False,
                    "enter_button": False
                    }
            
            if self.screen_button_status_flag[0].success_flag == 1:
                data["right_button"] = True
            else:
                data["right_button"] = False
            if self.screen_button_status_flag[1].success_flag == 1:
                data["left_button"] = True
            else:
                data["left_button"] = False
            if self.screen_button_status_flag[2].success_flag == 1:
                data["up_button"] = True
            else:
                data["up_button"] = False
            if self.screen_button_status_flag[3].success_flag == 1:
                data["down_button"] = True
            else:
                data["down_button"] = False
            if self.screen_button_status_flag[4].success_flag == 1:
                data["enter_button"] = True
            else:
                data["enter_button"] = False
            if self.screen_button_status_flag[5].success_flag == 1:
                data["back_button"] = True
            else:
                data["back_button"] = False
            if self.screen_button_status_flag[6].success_flag == 1:
                data["setting_button"] = True
            else:
                data["setting_button"] = False
            if self.screen_button_status_flag[7].success_flag == 1:
                data["switch_button"] = True
            else:
                data["switch_button"] = False
            json_data = json.dumps(data)
            self.mqttclient.publish(self.STATUS_PUB_TOPIC,json_data,qos=0, retain=False)



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
    def LiftingMotor_test(self):
        #LiftingMotor
        if self.lifting_motor_test_flag == 1:
            print("lifting_motor_test motor to 20mm")
            self.balde_height.data = 20
            self.blade_height_pub.publish(self.balde_height)
            self.lifting_motor_test_flag = 2
        elif self.lifting_motor_test_flag == 2:
            self.lifting_motor_time += 1 #200ms loop
            if self.lifting_motor_height == 20:
                if self.lifting_motor_time < 50:
                    self.lifting_motor_test_flag = 0
                    print("lifting_motor_test motor down hall error")
                    self.LiftingMotor_result_pub(0,2) #FAIL down hall error
                else:
                    sleep(3)
                    self.lifting_motor_test_flag = 3
                    self.lifting_motor_time = 0
                    self.balde_height.data = 90
                    self.blade_height_pub.publish(self.balde_height)
                    print("lifting_motor_test motor to 90mm")
            elif self.lifting_motor_time >= 200:
                print("lifting_motor_test motor stall")
                self.lifting_motor_test_flag = 0
                self.LiftingMotor_result_pub(1,0) #FAIL motor error
        elif self.lifting_motor_test_flag == 3:
            self.lifting_motor_time += 1 #200ms loop
            print("self.lifting_motor_time",self.lifting_motor_time)
            if self.lifting_motor_height == 90:
                if self.lifting_motor_time < 50:
                    self.lifting_motor_test_flag = 0
                    print("lifting_motor_test motor up hall error")
                    self.LiftingMotor_result_pub(0,1) #FAIL up hall error
                else:
                    print("lifting_motor_test motor success")
                    self.lifting_motor_test_flag = 0
                    self.LiftingMotor_result_pub(0,0) #SUCCESS
            elif self.lifting_motor_time >= 200:
                print("lifting_motor_test motor stall")
                self.lifting_motor_test_flag = 0
                self.LiftingMotor_result_pub(1,0) #FAIL motor error
    


# ############          timer_callback                    ############################################ 
    def timer_callback(self):
        # 0.2S loop
        # hall_test
        self.hall_test()
        # screen_button_test
        self.screen_button_test()
        # walk motor test
        self.walk_motor_test()
        # cut motor test
        self.cut_motor_test()
        # LiftingMotor
        self.LiftingMotor_test()


 





def main(args=None):
    rclpy.init(args=args)

    chassis_mqtt = ChassisMQTT()
    rclpy.spin(chassis_mqtt)
    chassis_mqtt.destroy_node()
    rclpy.shutdown()



if __name__ == '__main__':
    main()