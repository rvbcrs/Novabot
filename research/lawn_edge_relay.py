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


if __name__ == "__main__":
    from lawn_edge_relay_main import main  # placeholder tot Task 2; zie Step 3 daar
    sys.exit(main())
