#!/usr/bin/env python3
"""ROS2 action client voor ChassisPinCodeSet — PIN verify via chassis_control_node.

Standalone script dat aangeroepen wordt door extended_commands.py.
Vereist ROS2 Galactic environment (source setup.bash).

Gebruik:
    python3 pin_verify_ros2.py <PIN>

Output: JSON op stdout, bijv:
    {"result": 0, "status": "verified", "code": "0000"}
    {"result": 1, "status": "wrong_pin", "stm32_status": 3, "code": "xxxx"}
    {"result": 1, "status": "action_server_not_found"}

Achtergrond:
    mqtt_node's C++ action client voor ChassisPinCodeSet vindt de action server
    nooit (21s timeout). Python ROS2 clients vinden hem in <1s.
    Dit script is de workaround: extended_commands.py roept het aan via subprocess.

    ChassisPinCodeSet action definitie:
      Goal:   type (uint8), code (string)
      Result: status (uint8, 0=success), code (string)

    type=2 is verify, type=1 is set new PIN.
    STM32 v3.6.6+ retourneert status=0 bij success (was status=2 in v3.6.5).
"""

import sys
import json

# ROS2 imports — deze falen als environment niet gesourced is
try:
    import rclpy
    from rclpy.action import ActionClient
    from chassis_control.action import ChassisPinCodeSet
except ImportError as e:
    print(json.dumps({"result": 1, "status": "ros2_import_error", "error": str(e)}))
    sys.exit(1)


class PinVerifyClient:
    def __init__(self):
        rclpy.init()
        self.node = rclpy.create_node('pin_verify_client')
        self._client = ActionClient(self.node, ChassisPinCodeSet, 'chassis_pin_code_set')

    def verify(self, pin_code):
        if not self._client.wait_for_server(timeout_sec=5.0):
            return {"result": 1, "status": "action_server_not_found"}

        goal = ChassisPinCodeSet.Goal()
        goal.type = 2  # verify
        goal.code = pin_code

        future = self._client.send_goal_async(goal)
        rclpy.spin_until_future_complete(self.node, future, timeout_sec=10.0)

        if not future.done() or future.result() is None:
            return {"result": 1, "status": "goal_send_timeout"}

        handle = future.result()
        if not handle.accepted:
            return {"result": 1, "status": "goal_rejected"}

        result_future = handle.get_result_async()
        rclpy.spin_until_future_complete(self.node, result_future, timeout_sec=15.0)

        if not result_future.done() or result_future.result() is None:
            return {"result": 1, "status": "result_timeout"}

        result = result_future.result().result
        status = result.status
        code = result.code

        if status == 0:
            return {"result": 0, "status": "verified", "code": code}
        else:
            return {"result": 1, "status": "wrong_pin", "stm32_status": int(status), "code": code}

    def shutdown(self):
        self.node.destroy_node()
        rclpy.shutdown()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"result": 1, "status": "usage_error", "error": "Usage: pin_verify_ros2.py <PIN>"}))
        sys.exit(1)

    pin = sys.argv[1]
    client = PinVerifyClient()
    try:
        result = client.verify(pin)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"result": 1, "status": "exception", "error": str(e)}))
    finally:
        client.shutdown()


if __name__ == '__main__':
    main()
