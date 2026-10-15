"""mow_zone_drive must never touch a live task (Novabot-7xu).

Run: python3 research/test_mow_zone_guard.py
ROS modules are stubbed; only the start guard and clear_parked_task run.
"""
import io
import os
import sys
import types
import unittest
from contextlib import redirect_stdout


class _Meta(type):
    def __getattr__(cls, name):  # class attributes such as QoSHistoryPolicy.KEEP_LAST
        return _Stub()


class _Stub(metaclass=_Meta):
    """Any attribute, any call, subclassable: enough for module-level ROS names."""
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        return _Stub()

    def __call__(self, *a, **k):
        return _Stub()


class _Any(types.ModuleType):
    def __getattr__(self, name):
        return _Stub


for mod in ["rclpy", "rclpy.action", "rclpy.qos", "rcl_interfaces", "rcl_interfaces.srv", "rcl_interfaces.msg",
            "geometry_msgs", "geometry_msgs.msg", "nav_msgs", "nav_msgs.msg", "std_msgs", "std_msgs.msg",
            "std_srvs", "std_srvs.srv", "nav2_msgs", "nav2_msgs.action", "nav2_msgs.srv",
            "decision_msgs", "decision_msgs.srv", "decision_msgs.msg", "tf2_ros"]:
    sys.modules.setdefault(mod, _Any(mod))
sys.path.insert(0, os.path.dirname(__file__))
import mow_zone_drive as mzd  # noqa: E402


class FakeDrv:
    def __init__(self, status):
        self.status = status
        self.calls = []

    def wait_status(self, pred, timeout=0):
        return self.status

    def reload_map(self, *a):
        self.calls.append("reload_map")
        return True, ""

    def quit_mapping_mode(self):
        self.calls.append("quit_mapping_mode")
        self.status = (0, 0)


class Guard(unittest.TestCase):
    def test_live_task_is_left_alone(self):
        drv = FakeDrv((1, 92))  # MOVING: the app's fallback task
        out = io.StringIO()
        with redirect_stdout(out):
            rc = mzd.do_mow(drv, "map2", 100, 2, None)
        self.assertEqual(rc, 1)
        self.assertEqual(drv.calls, [])
        self.assertIn("PHASE error busy_mowing", out.getvalue())

    def test_parked_task_is_cleared(self):
        for ws in (10, 13, 15):
            drv = FakeDrv((1, ws))
            with redirect_stdout(io.StringIO()):
                mzd.clear_parked_task(drv)
            self.assertEqual(drv.calls, ["quit_mapping_mode"], ws)

    def test_live_task_is_never_cleared(self):
        drv = FakeDrv((1, 90))
        with redirect_stdout(io.StringIO()):
            mzd.clear_parked_task(drv)
        self.assertEqual(drv.calls, [])



class DockDrv(FakeDrv):
    """Idle mower standing on the dock (localized): records what it is asked."""
    def __init__(self):
        super().__init__((0, 0))

    def robot_xy(self, timeout=0):
        return (0.2, 0.1)

    def docked(self, timeout=5.0):
        return False   # not charging per RobotStatus: the position (0.2, 0.1) decides

    def undock(self, *a, **k):
        self.calls.append("undock")

    def localize_via_firmware(self, *a, **k):
        self.calls.append("localize_via_firmware")
        return None  # stop right after the departure decision

    def start_cov(self, *a, **k):
        self.calls.append("start_cov")
        return True


class StockDeparture(unittest.TestCase):
    """The departure off the dock is always the firmware's own, as stock."""
    def setUp(self):
        self.saved = (mzd._dock_zone, mzd._channel_files, mzd.clear_recharge)
        mzd._dock_zone = lambda: "map0"
        mzd.clear_recharge = lambda drv: None

    def tearDown(self):
        mzd._dock_zone, mzd._channel_files, mzd.clear_recharge = self.saved

    def test_same_zone_hands_the_whole_task_to_the_firmware(self):
        mzd._channel_files = lambda a, b: []
        drv = DockDrv()
        with redirect_stdout(io.StringIO()):
            rc = mzd.do_mow(drv, "map0", 1, 2, None)
        self.assertEqual(rc, 0)
        self.assertNotIn("undock", drv.calls)
        self.assertIn("start_cov", drv.calls)

    def test_channel_lets_the_firmware_depart_first(self):
        mzd._channel_files = lambda a, b: ["map0tomap1_0_unicom.csv"]
        drv = DockDrv()
        with redirect_stdout(io.StringIO()):
            mzd.do_mow(drv, "map1", 10, 2, None)
        self.assertNotIn("undock", drv.calls)
        self.assertIn("localize_via_firmware", drv.calls)


if __name__ == "__main__":
    unittest.main()
