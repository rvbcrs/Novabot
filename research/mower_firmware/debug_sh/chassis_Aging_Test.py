
from ast import If
import os
import sys
import select
from time import sleep


import rclpy
from rclpy.node import Node

from pickletools import uint8

from std_msgs.msg import String
from std_msgs.msg import UInt8
from std_msgs.msg import Bool

from novabot_msgs.msg import ChassisData

from novabot_msgs.msg import ChassisHallStatus

from novabot_msgs.msg import ChassisIncident

from novabot_msgs.msg import ChassisMotorCurrent

from std_msgs.msg import Int16

from std_msgs.msg import String

from geometry_msgs.msg import Twist



msg = """
NOVABOT TEST!
---------------------------
c: stop all
z: blade height up and down loop
b: blade motor test
w: walk motor test
m: move and collision test

CTRL-C to quit

"""




if os.name == 'nt':
    import msvcrt
else:
    import termios
    import tty

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





class FactoryTest(Node):

    

    # 
    hall_uplift_left_cnt = 0
    hall_uplift_right_cnt = 0
    hall_collision_behind_cnt = 0
    hall_collision_front_cnt = 0
    hall_cutmotor_cnt_cnt = 0
    hall_cutmotor_up_cnt = 0
    hall_cutmotor_down_cnt = 0
    hall_key_left_cnt = 0
    hall_key_right_cnt = 0
    hall_collision_behind2_cnt = 0
    hall_collision_front2_cnt = 0

    # button
    screen_button1 = 0
    screen_button2 = 0
    screen_button3 = 0
    screen_button4 = 0
    screen_button5 = 0
    screen_button6 = 0
    screen_button7 = 0
    screen_button8 = 0
    def __init__(self):
        super().__init__('chassis_test')

        print(msg)
        self.get_logger().info('chassis_test:: started...')

        #######  subscription  init ####### 
        self.subscription = self.create_subscription(
            ChassisHallStatus,
            'hall_status',
            self.hall_callback,
            10)

        self.subscription2 = self.create_subscription(
            UInt8,
            'screen_button_status',
            self.screen_button_callback,
            10)
        
        self.subscription3 = self.create_subscription(
            UInt8,
            'blade_height',
            self.blade_height_get_callback,
            10)

        self.subscription4 = self.create_subscription(
            ChassisIncident,
            'chassis_incident',
            self.chassis_incident_callback,
            10)
        
        #chassis_init_flag_pub_ = node_->create_publisher<std_msgs::msg::Bool>("/chassis_node/init_ok", 10);

        self.subscription5 = self.create_subscription(
            Bool,
            '/chassis_node/init_ok',
            self.chassis_init_ok_callback,
            10)

            
        
        # self.subscription5 = self.create_subscription(
        #     ChassisMotorCurrent,
        #     'chassis_incident',
        #     self.motor_current_callback,
        #     10)


        #######  publisher  init #######

        self.motor_reset = self.create_publisher(String, "motor_driver_reset", 10)
        self.reset = String()
        self.motor_reset.publish(self.reset)




        #chassis init ok flag

        self.chassis_init_ok_flag = False

        # hall test

        self.hall_test_start_flag = 0

        # blade height
        self.blade_height_pub = self.create_publisher(UInt8, "blade_height_set", 10)
        self.blade_height_loop_flag = 0
        self.blade_height_loop_wait_flag = 0
        self.blade_height_loop_cnt = 0
        self.blade_height_set_data = 0
        self.blade_height_get = 0

        # motor
        self.cmd_vel_pub = self.create_publisher(Twist, "cmd_vel", 10)
        self.chassis_reset_pub = self.create_publisher(String, "motor_driver_reset", 10)
        self.blade_pub = self.create_publisher(Int16, "blade_speed_set", 10)
        
        # walk motor
        self.walk_test_start_flag = 0
        self.walk_motor_speed = 0.3 # 0.3m/s
        self.walk_motor_angle_speed = 0.3 # 0.3m/s
        self.walk_motor_loop_time = 0
        self.left_motor_overcur_or_stall_cnt = 0
        self.right_motor_overcur_or_stall_cnt = 0
        self.left_motor_reset_time  = 0
        self.right_motor_reset_time  = 0

        #blade motor
        self.blade_test_start_flag = 0
        self.blade_motor_speed = 3000 # 3000r/min
        self.blade_motor_overcur_or_stall_cnt = 0
        self.blade_motor_reset_time  = 0


        self.blade_motor_over_current = 0
        self.left_motor_over_current = 0
        self.right_motor_over_current = 0
        self.blade_motor_stall = 0
        self.left_motor_stall = 0
        self.right_motor_stall = 0


        # collison move test
        self.collison_move_test_flag = 0
        self.warning_collision_stop = 0
        self.collison_trigger_cnt = 0
        self.collison_step_flag = 0

        timer_period = 0.02  # seconds
        self.timer = self.create_timer(timer_period, self.timer_callback)
        self.timer2 = self.create_timer(0.2, self.timer_callback2)


        # all aging test start

        self.blade_time = 0
        self.blade_flag = 0
        self.walk_motor_speed = 0.0
        self.walk_motor_dir = 0
        self.walk_time = 0

        self.blade_height_loop_flag = 1
        self.blade_height_set_data = 20
        self.get_logger().info('start blade_height_loop\r\n')
        self.walk_test_start_flag = 1
        self.get_logger().info('start walk_motor_test')
        self.blade_test_start_flag = 1
        self.get_logger().info('start blade_motor_test')






    def hall_callback(self, msg):
        if self.hall_test_start_flag == 1:
            if(msg.hall_uplift_left == 1):
                self.hall_uplift_left_cnt = self.hall_uplift_left_cnt + 1
                self.get_logger().info('hall_uplift_left_cnt: "%d"' % self.hall_uplift_left_cnt)
            if(msg.hall_uplift_right == 1):
                self.hall_uplift_right_cnt = self.hall_uplift_right_cnt + 1
                self.get_logger().info('hall_uplift_right_cnt: "%d"' % self.hall_uplift_right_cnt)
            if(msg.hall_collision_behind == 1):
                hall_collision_behind_cnt = self.hall_collision_behind_cnt + 1
                self.get_logger().info('hall_collision_behind_cnt: "%d"' % self.hall_collision_behind_cnt)
            if(msg.hall_collision_front == 1):
                self.hall_collision_front_cnt = self.hall_collision_front_cnt + 1
                self.get_logger().info('hall_collision_front_cnt: "%d"' % self.hall_collision_front_cnt)
            if(msg.hall_key_left == 1):
                self.hall_key_left_cnt = self.hall_key_left_cnt + 1
                self.get_logger().info('hall_key_left_cnt: "%d"' % self.hall_key_left_cnt)
            if(msg.hall_key_right == 1):
                self.hall_key_right_cnt = self.hall_key_right_cnt + 1
                self.get_logger().info('hall_key_right_cnt: "%d"' % self.hall_key_right_cnt)
            if(msg.hall_collision_behind2 == 1):
                self.hall_collision_behind2_cnt = self.hall_collision_behind2_cnt + 1
                self.get_logger().info('hall_collision_behind2_cnt: "%d"' % self.hall_collision_behind2_cnt)
        
    def screen_button_callback(self, msg):
        if(msg.data == 1):
            self.screen_button1 = self.screen_button1+1
            self.get_logger().info('screen_button1: "%d"' % self.screen_button1)
        if(msg.data == 2):
            self.screen_button2 = self.screen_button2+1
            self.get_logger().info('screen_button2: "%d"' % self.screen_button2)
        if(msg.data == 3):
            self.screen_button3 = self.screen_button3+1
            self.get_logger().info('screen_button3: "%d"' % self.screen_button3)
        if(msg.data == 4):
            self.screen_button4 = self.screen_button4+1
            self.get_logger().info('screen_button4: "%d"' % self.screen_button4)
        if(msg.data == 5):
            self.screen_button5 = self.screen_button5+1
            self.get_logger().info('screen_button5: "%d"' % self.screen_button5)
        if(msg.data == 6):
            self.screen_button6 = self.screen_button6+1
            self.get_logger().info('screen_button6: "%d"' % self.screen_button6)
        if(msg.data == 7):
            self.screen_button7 = self.screen_button7+1
            self.get_logger().info('screen_button7: "%d"' % self.screen_button7)
        if(msg.data == 8):
            self.screen_button8 = self.screen_button8+1
            self.get_logger().info('screen_button8: "%d"' % self.screen_button8)

    def blade_height_get_callback(self, msg):
        self.blade_height_get = msg.data

    def chassis_init_ok_callback(self, msg):
        self.chassis_init_ok_flag = msg.data
        
    


    def chassis_incident_callback(self, msg):
        if msg.warning_left_motor_stall_stop == True :# 左轮堵转 
            self.left_motor_stall = 1
        else:
            self.left_motor_stall == 0
        if msg.warning_right_motor_stall_stop == True :# 右轮堵转 
            self.right_motor_stall = 1
        else:
             self.right_motor_stall == 0
        if msg.warning_blade_motor_stall_stop == True:# 割草电机堵转 
            self.blade_motor_stall = 1
        else:
            self.blade_motor_stall == 0
        if msg.warning_left_motor_overcur_stop == True:# 左轮过流
            self.left_motor_over_current = 1
        else:
            self.left_motor_over_current == 0
        if msg.warning_right_motor_overcur_stop == True:# 右轮过流 
            self.right_motor_over_current = 1
        else:
            self.right_motor_over_current == 0
        if msg.warning_blade_motor_overcur_stop == True:# 割草电机过流 
            self.blade_motor_over_current = 1
        else:
            self.blade_motor_over_current == 0

        if  self.collison_move_test_flag == 1 :
            if msg.warning_collision_stop == True:
                self.warning_collision_stop = 1
            else:
                self.warning_collision_stop = 0


    def timer_callback(self):


        
        # blade height loop
        if self.blade_height_loop_flag == 1:
            if self.chassis_init_ok_flag == True:
                if self.blade_height_loop_wait_flag == 0:
                    sleep(3)
                    self.BladeHight_data = UInt8()
                    self.BladeHight_data.data = self.blade_height_set_data
                    self.blade_height_pub.publish(self.BladeHight_data)
                    self.blade_height_loop_wait_flag = 1
                elif self.blade_height_get == self.blade_height_set_data:
                    if self.blade_height_set_data == 20:
                        self.blade_height_set_data = 90
                    elif self.blade_height_set_data == 90:
                        self.blade_height_set_data = 20
                        self.blade_height_loop_cnt = self.blade_height_loop_cnt + 1
                        self.get_logger().info('blade_height_loop_cnt: "%d"' % self.blade_height_loop_cnt )
                    self.blade_height_loop_wait_flag = 0
            elif self.chassis_init_ok_flag == False:
                print("wait chassis_init_ok_flag")
       

    def timer_callback2(self): 
        # 0.2s
         # left right motor
        if self.walk_test_start_flag == 1:
            
            self.walk_time = self.walk_time + 1
            if self.walk_time > 1:
                self.walk_time = 0
                if self.walk_motor_dir == 0:
                    self.walk_motor_speed  = self.walk_motor_speed + 0.05
                    if self.walk_motor_speed >= 0.4:
                        self.walk_motor_dir = 1
                if self.walk_motor_dir == 1:
                    self.walk_motor_speed  = self.walk_motor_speed - 0.05
                    if self.walk_motor_speed <= -0.4:
                        self.walk_motor_dir = 0
            twist = Twist()
            twist.linear.x = self.walk_motor_speed
            twist.linear.y = 0.0
            twist.linear.z = 0.0
            twist.angular.x = 0.0
            twist.angular.y = 0.0
            twist.angular.z = 0.0
            self.cmd_vel_pub.publish(twist)

        
        # balde motor
        if self.blade_test_start_flag == 1:
            self.blade_time = self.blade_time + 1
            if self.blade_time > 500:
                self.blade_time = 0
                self.blade_test_start_flag = 0
            print("blade start\r\n")
            blade_speed = Int16()
            blade_speed.data = self.blade_motor_speed
            self.blade_pub.publish(blade_speed)
        elif self.blade_test_start_flag == 0:
            self.blade_time = self.blade_time + 1
            print("blade stop\r\n")
            if self.blade_time > 50:
                self.blade_time = 0
                self.blade_test_start_flag = 1
            blade_speed = Int16()
            blade_speed.data = 0
            self.blade_pub.publish(blade_speed)

        

            

            


def main(args=None):
    rclpy.init(args=args)

    factory_test = FactoryTest()

    rclpy.spin(factory_test)

    # Destroy the node explicitly
    # (optional - otherwise it will be done automatically
    # when the garbage collector destroys the node object)
    factory_test.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
