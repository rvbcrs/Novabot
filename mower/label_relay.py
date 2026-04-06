#!/usr/bin/env python3
"""
Label relay node — remaps perception labels for boundary detection.

Approach: subscribe to /perception/points_labeled, modify labels in-place,
republish on the SAME topic. To prevent infinite loop, we check the
header.frame_id — the perception node publishes in 'tof_camera' frame.
We change it to 'tof_camera_relabeled' after processing. If we receive
a message with our marker frame, we skip it.

Remap rules:
  Everything NOT lawn (2) or known-good obstacle (5,6,7,8) → 5 (fixed obstacle)
  This makes hedges (background=1), pavement (road=3), sand (terrain=4),
  dirt (11) all appear as obstacles/boundaries in the costmap.
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2
from rclpy.qos import QoSProfile, ReliabilityPolicy

# Labels to remap → target label
REMAP_RULES = {
    0: 5,   # unlabeled → fixed obstacle (unknown = treat as boundary)
    1: 5,   # background → fixed obstacle (hedges, walls at close range)
    3: 5,   # road → fixed obstacle (pavement, paths)
    4: 5,   # terrain → fixed obstacle (sand, gravel)
    9: 5,   # faeces → fixed obstacle
    11: 5,  # dirt → fixed obstacle
    12: 5,  # sunlight → fixed obstacle
    13: 5,  # glass → fixed obstacle
}

MARKER = '_relabeled'
TOPIC = '/perception/points_labeled'


class LabelRelay(Node):
    def __init__(self):
        super().__init__('label_relay')

        qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT)

        self.sub = self.create_subscription(
            PointCloud2, TOPIC, self._on_points, qos)
        self.pub = self.create_publisher(PointCloud2, TOPIC, qos)

        self.get_logger().info(
            f'Label relay: in-place on {TOPIC}, '
            f'remap rules: {REMAP_RULES}')

    def _on_points(self, msg: PointCloud2):
        # Skip our own republished messages (marked frame_id)
        if msg.header.frame_id.endswith(MARKER):
            return

        if msg.width == 0:
            return

        # Find label field offset
        label_offset = None
        for field in msg.fields:
            if field.name == 'label':
                label_offset = field.offset
                break

        if label_offset is None:
            return

        # Remap labels
        data = bytearray(msg.data)
        for i in range(msg.width):
            off = i * msg.point_step + label_offset
            if off < len(data):
                old_label = data[off]
                if old_label in REMAP_RULES:
                    data[off] = REMAP_RULES[old_label]

        msg.data = bytes(data)
        # Mark as processed so we don't loop
        msg.header.frame_id = msg.header.frame_id + MARKER
        self.pub.publish(msg)


def main():
    rclpy.init()
    node = LabelRelay()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
