#!/usr/bin/env python3
"""lawn_edge_relay — grasrand als obstakelwand voor de costmap.

Abonneert op /perception/points_labeled (packed 13 B/punt: x,y,z float32 +
label uint8, zelfde layout als terrain_scan.py), hermapt ELK punt dat niet
label 2 (lawn) is naar label 5 (fixed obstacle) en publiceert het resultaat
op /perception/points_relabeled. De SemanticObstacleLayer ziet daardoor de
gras-rand als boundary, ongeacht of het heg, border, stoep of zand is
(de heg-als-background-zwakte uit maart 2026 wordt irrelevant).

Onderdeel van autonoom karteren route B, zie
docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md.

Run (op de maaier, via start_lawn_relay.sh voor de ROS-env):
    python3 /root/novabot/scripts/lawn_edge_relay.py
"""
import sys
import time

import numpy as np

LAWN_LABEL = 2       # infer_class.json: 2 = lawn (enige betrouwbare label)
OBSTACLE_LABEL = 5   # 5 = fixed obstacle → SemanticObstacleLayer boundary
POINT_STEP = 13      # x,y,z float32 + label uint8
LABEL_OFFSET = 12
SUB_TOPIC = "/perception/points_labeled"
PUB_TOPIC = "/perception/points_relabeled"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def relabel(data):
    """Packed labeled-buffer → zelfde buffer met alle niet-gras-labels op 5.

    Onverwachte stride (geen veelvoud van 13) → ongewijzigd doorgeven, zodat
    een firmware-wijziging in het puntformaat nooit corrupte clouds oplevert.
    """
    if not data or len(data) % POINT_STEP != 0:
        return bytes(data)
    arr = np.frombuffer(data, dtype=np.uint8).copy()
    labels = arr[LABEL_OFFSET::POINT_STEP]
    labels[labels != LAWN_LABEL] = OBSTACLE_LABEL
    return arr.tobytes()


def main():
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import PointCloud2

    rclpy.init()
    node = Node("lawn_edge_relay")
    pub = node.create_publisher(PointCloud2, PUB_TOPIC, 5)
    stats = {"in": 0, "out": 0, "bad": 0, "last_log": time.monotonic()}

    def on_labeled(msg):
        stats["in"] += 1
        if msg.point_step != POINT_STEP:
            # Onbekend formaat: ongewijzigd doorgeven zodat de costmap niet
            # blind wordt, maar wel tellen zodat het in de log opvalt.
            stats["bad"] += 1
            pub.publish(msg)
        else:
            msg.data = relabel(bytes(msg.data))
            pub.publish(msg)
        stats["out"] += 1
        now = time.monotonic()
        if now - stats["last_log"] >= 60.0:
            log(f"relay: in={stats['in']} out={stats['out']} bad_stride={stats['bad']}")
            stats["last_log"] = now

    node.create_subscription(PointCloud2, SUB_TOPIC, on_labeled, 5)
    log(f"lawn_edge_relay actief: {SUB_TOPIC} -> {PUB_TOPIC}")
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
