# !/usr/bin/env python
#
# Copyright (c) 2011, Willow Garage, Inc.
# All rights reserved.
#
# Software License Agreement (BSD License 2.0)
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions
# are met:
#
#  * Redistributions of source code must retain the above copyright
#    notice, this list of conditions and the following disclaimer.
#  * Redistributions in binary form must reproduce the above
#    copyright notice, this list of conditions and the following
#    disclaimer in the documentation and/or other materials provided
#    with the distribution.
#  * Neither the name of {copyright_holder} nor the names of its
#    contributors may be used to endorse or promote products derived
#    from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
# "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
# LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
# FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
# COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
# INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
# BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
# CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
# LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
# ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
#
# Author: Darby Lim

import os
from pickletools import uint8
import select
import string
import sys
from tokenize import String
import rclpy

from geometry_msgs.msg import Twist
from std_msgs.msg import Int16
from std_msgs.msg import UInt8
from rclpy.qos import QoSProfile
from std_msgs.msg import String

if os.name == 'nt':
    import msvcrt
else:
    import termios
    import tty

NOVABOT_MAX_LIN_VEL = 0.6
# about three seconds  per lap
NOVABOT_MAX_ANG_VEL = 2.094

BURGER_MAX_LIN_VEL = 0.7
BURGER_MAX_ANG_VEL = 2.84

LIN_VEL_STEP_SIZE = 0.02
ANG_VEL_STEP_SIZE = 0.1
MAX_BLADE_SPEED=3600
WORK_BLADE_SPEED=2300
ROBOT_MODEL = "NOVABOT"

msg = """
Control Your NOVABOT!
---------------------------
Moving around:
        w    
   a    s    d 
        x
w/x : increase/decrease linear velocity (NOVABOT : ~ 0.6,)
a/d : increase/decrease angular velocity (NOVABOT : ~ 2.094)
space key, s : force stop,  "s"  will also stop blade
g: setting angular velocity to zero 
----------
q/e: +/- 200  circle blade_speed, max 3600,min 0
b:  3000  blade_speed pub in 10 hz
j/k:  bladeMotor Up/Down
r:  MotorMcu Reset
2~9: 20mm~90mm balde motor hieght above ground setting
o/p: light level up/down setting
z:  reciprocating running
l:  Release the charging self-lock, you must leave the charging post within 5S, otherwise it will be re-locked
----------
CTRL-C to quit
"""

e = """
Communications Failed
"""


def get_key(settings):
    if os.name == 'nt':
        return msvcrt.getch().decode('utf-8')
    tty.setraw(sys.stdin.fileno())
    rlist, _, _ = select.select([sys.stdin], [], [], 0.1)
    if rlist:
        key = sys.stdin.read(1)
    else:
        key = ''

    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, settings)
    return key


def print_vels(target_linear_velocity, target_angular_velocity):
    print('currently:\tlinear velocity {0}\t angular velocity {1} '.format(
        target_linear_velocity,
        target_angular_velocity))
    if target_angular_velocity>0.001 or target_angular_velocity<-0.001:
        print("rotate radius in meter: {:.3f}".format(target_linear_velocity/target_angular_velocity))

def make_simple_profile(output, input, slop):
    if input > output:
        output = min(input, output + slop)
    elif input < output:
        output = max(input, output - slop)
    else:
        output = input

    return output


def constrain(input_vel, low_bound, high_bound):
    if input_vel < low_bound:
        input_vel = low_bound
    elif input_vel > high_bound:
        input_vel = high_bound
    else:
        input_vel = input_vel

    return input_vel


def check_linear_limit_velocity(velocity):
    if ROBOT_MODEL == 'burger':
        return constrain(velocity, -BURGER_MAX_LIN_VEL, BURGER_MAX_LIN_VEL)
    else:
        return constrain(velocity, -NOVABOT_MAX_LIN_VEL, NOVABOT_MAX_LIN_VEL)


def check_angular_limit_velocity(velocity):
    if ROBOT_MODEL == 'burger':
        return constrain(velocity, -BURGER_MAX_ANG_VEL, BURGER_MAX_ANG_VEL)
    else:
        return constrain(velocity, -NOVABOT_MAX_ANG_VEL, NOVABOT_MAX_ANG_VEL)


def main():
    settings = None
    if os.name != 'nt':
        settings = termios.tcgetattr(sys.stdin)

    rclpy.init()

    qos = QoSProfile(depth=10)
    node = rclpy.create_node('teleop_keyboard')
    pub = node.create_publisher(Twist, 'cmd_vel', qos)
    blade_pub = node.create_publisher(Int16, "blade_speed_set", qos)
    blade_up_pub = node.create_publisher(String, "blade_up_set", qos)
    blade_down_pub = node.create_publisher(String, "blade_down_set", qos)
    motor_reset_pub = node.create_publisher(String, "motor_driver_reset", qos)
    blade_height_pub = node.create_publisher(UInt8, "blade_height_set", qos)
    release_charge_lock_pub = node.create_publisher(UInt8, "release_charge_lock", qos)
    led_pub = node.create_publisher(UInt8, "led_set", qos)
    status = 0
    target_linear_velocity = 0.0
    target_angular_velocity = 0.0
    control_linear_velocity = 0.0
    control_angular_velocity = 0.0
    blade_add_index = 0
    blade_speed_size = 100
    data = Int16()
    blade_pub_always = False
    reciprocating_running = False
    reciprocating_running_forward = 1.0
    angular_speed_zero =False
    BladeUp_str = String()
    BladeDown_str = String()
    Bmotor_reset_str = String()
    BladeHight_data = UInt8()
    release_charge_lock_data = UInt8()
    Led_data = UInt8()
    led_set_data = 0
    led_turn_flag = 0
    try:
        print(msg)
        last_change_time = node.get_clock().now()
        led_last_change_time = node.get_clock().now()
        while (1):
            key = get_key(settings)
            if reciprocating_running:
                if (node.get_clock().now() - last_change_time).to_msg().sec > 5.0:
                    reciprocating_running_forward = reciprocating_running_forward * -1.0
                    print((node.get_clock().now() - last_change_time).to_msg())
                    last_change_time = node.get_clock().now()
                    target_linear_velocity = 0.3 * reciprocating_running_forward
                    target_angular_velocity = 0.0
                    print("reciprocating_running......................reverse speed")
                    print_vels(target_linear_velocity, target_angular_velocity)
                else:
                    target_linear_velocity = 0.3 * reciprocating_running_forward
                    target_angular_velocity = 0.0
            if key == 'z':
                reciprocating_running = not reciprocating_running
                if reciprocating_running:
                    last_change_time = node.get_clock().now()
                    reciprocating_running_forward = 1.0
                    print("reciprocating_running......................")
            elif key == 'w':
                reciprocating_running = False
                target_linear_velocity = \
                    check_linear_limit_velocity(target_linear_velocity + LIN_VEL_STEP_SIZE)
                status = status + 1
                print_vels(target_linear_velocity, target_angular_velocity)
            elif key == 'x':
                reciprocating_running = False
                target_linear_velocity = \
                    check_linear_limit_velocity(target_linear_velocity - LIN_VEL_STEP_SIZE)
                status = status + 1
                print_vels(target_linear_velocity, target_angular_velocity)
            elif key == 'a':
                reciprocating_running = False
                target_angular_velocity = \
                    check_angular_limit_velocity(target_angular_velocity + ANG_VEL_STEP_SIZE)
                status = status + 1
                print_vels(target_linear_velocity, target_angular_velocity)
            elif key == 'd':
                reciprocating_running = False
                target_angular_velocity = \
                    check_angular_limit_velocity(target_angular_velocity - ANG_VEL_STEP_SIZE)
                status = status + 1
                print_vels(target_linear_velocity, target_angular_velocity)
            elif (key == ' ' or key == 's') :
                reciprocating_running = False
                target_linear_velocity = 0.0
                control_linear_velocity = 0.0
                target_angular_velocity = 0.0
                control_angular_velocity = 0.0
                print_vels(target_linear_velocity, target_angular_velocity)
                if key == 's':
                    blade_speed_send = 0
                    blade_add_index = 0
                    blade_pub_always = False
                    print("Stop pub blade speed")
            elif key == 'q':
                reciprocating_running = False
                # node.get_logger().warn("Blade speed is not test!!!")
                blade_add_index = blade_add_index + 1
                blade_speed_send = blade_add_index * blade_speed_size
                if (blade_speed_send > MAX_BLADE_SPEED):
                    blade_speed_send = MAX_BLADE_SPEED
                    blade_add_index = int(MAX_BLADE_SPEED/blade_speed_size)
                data.data = blade_speed_send
                blade_pub.publish(data)
                print("setting blade_speed :", blade_speed_send)
            elif key == 'e':
                reciprocating_running = False
                # node.get_logger().warn("Blade speed is not test!!!")
                blade_add_index = blade_add_index - 1
                blade_speed_send = blade_add_index * blade_speed_size
                if (blade_speed_send < 0):
                    blade_speed_send = 0
                    blade_add_index = 0
                data.data = blade_speed_send
                blade_pub.publish((data))
                blade_pub_always = False
                print("setting blade_speed :", blade_speed_send)
            elif key == 'b':
                reciprocating_running = False
                blade_pub_always = True
                blade_speed_send = WORK_BLADE_SPEED
                print("setting blade_speed :", blade_speed_send)
            elif key == 'g':
                reciprocating_running = False
                angular_speed_zero =True
                target_angular_velocity = 0.0
                print_vels(target_linear_velocity, target_angular_velocity)
            elif key == 'j':
                BladeUp_str.data = ""
                blade_up_pub.publish(BladeUp_str)
                BladeHight_data.data = 0
                blade_height_pub.publish(BladeHight_data)
            elif key == 'k':
                BladeDown_str.data = ""
                blade_down_pub.publish(BladeDown_str)
                BladeHight_data.data = 1
                blade_height_pub.publish(BladeHight_data)
            elif key == 'r':
                Bmotor_reset_str.data = ""
                motor_reset_pub.publish(Bmotor_reset_str)
            elif key == '9':
                BladeHight_data.data = 90
                blade_height_pub.publish(BladeHight_data)
            elif key == '8':
                BladeHight_data.data = 80
                blade_height_pub.publish(BladeHight_data)
            elif key == '7':
                BladeHight_data.data = 70
                blade_height_pub.publish(BladeHight_data)
            elif key == '6':
                BladeHight_data.data = 60
                blade_height_pub.publish(BladeHight_data)
            elif key == '5':
                BladeHight_data.data = 50
                blade_height_pub.publish(BladeHight_data)
            elif key == '4':
                BladeHight_data.data = 40
                blade_height_pub.publish(BladeHight_data)
            elif key == '3':
                BladeHight_data.data = 30
                blade_height_pub.publish(BladeHight_data)
            elif key == '2':
                BladeHight_data.data = 20
                blade_height_pub.publish(BladeHight_data)
            elif key == 'o': #字母 o led up
                led_set_data = led_set_data + 10
                if led_set_data >= 100:
                    led_set_data = 100
                Led_data.data = led_set_data
                led_pub.publish(Led_data)
            elif key == 'p': #字母 o led down
                led_set_data = led_set_data - 10
                if led_set_data  <= 0:
                    led_set_data = 0
                Led_data.data = led_set_data
                led_pub.publish(Led_data)
            elif key == 'l': #释放充电自锁
                release_charge_lock_data.data = 0
                release_charge_lock_pub.publish(release_charge_lock_data)

                

                
            else:
                if (key == '\x03'):
                    break

            if status == 20:
                print(msg)
                status = 0
            if blade_pub_always:
                data.data = blade_speed_send
                blade_pub.publish(data)

            twist = Twist()

            control_linear_velocity = make_simple_profile(
                control_linear_velocity,
                target_linear_velocity,
                (LIN_VEL_STEP_SIZE / 2.0))

            twist.linear.x = control_linear_velocity
            twist.linear.y = 0.0
            twist.linear.z = 0.0
            if angular_speed_zero:
                control_angular_velocity = 0.0
                angular_speed_zero =False
            else:
                control_angular_velocity = make_simple_profile(
                    control_angular_velocity,
                    target_angular_velocity,
                    (ANG_VEL_STEP_SIZE / 2.0))

            twist.angular.x = 0.0
            twist.angular.y = 0.0
            twist.angular.z = control_angular_velocity

            pub.publish(twist)

    except Exception as e:
        print(e)

    finally:
        twist = Twist()
        twist.linear.x = 0.0
        twist.linear.y = 0.0
        twist.linear.z = 0.0

        twist.angular.x = 0.0
        twist.angular.y = 0.0
        twist.angular.z = 0.0

        pub.publish(twist)

        if os.name != 'nt':
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, settings)


if __name__ == '__main__':
    main()
