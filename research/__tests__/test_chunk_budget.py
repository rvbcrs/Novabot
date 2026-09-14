#!/usr/bin/env python3
"""No subscription in mow_zone_drive may queue more than the pool can hold.

Iceoryx gives this application two pools, 4 MB and 8 MB, so EVERY message costs
a whole 4 MB chunk - a 104-byte tf transform included. A queue depth is
therefore not "a little memory" but tens of megabytes per subscription.
tf2_ros.TransformListener defaults to depth 100 on /tf and another 100 on
/tf_static: 200 slots on a pool of 100. robot_xy() emptied it in seconds and
everything that asked for a chunk afterwards got
MEPOO__MEMPOOL_GETCHUNK_POOL_IS_RUNNING_OUT_OF_CHUNKS (live LFIN2230700238,
2026-09-14, the mower stopped a metre off the dock).

Reads the source rather than importing ROS, so it runs anywhere.

Run: python3 research/__tests__/test_chunk_budget.py
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "mow_zone_drive.py")).read()

# De pool zoals we hem in shm_ioxroudi.toml zetten (zie test_shm_mempool_rebalance).
POOL_CHUNKS = 100


def depths():
    """Elke expliciete queue-diepte in het bestand."""
    out = [int(m) for m in re.findall(r"depth\s*=\s*(\d+)", SRC)]
    out += [int(m) for m in re.findall(r"create_subscription\([^)]*?,\s*(\d+)\s*\)", SRC, re.S)]
    return out


def test_the_tf_listener_does_not_use_its_default_depth():
    # Kaal aanroepen betekent 100 + 100; er moet een eigen qos mee.
    calls = re.findall(r"TransformListener\(([^)]*)\)", SRC, re.S)
    assert calls, "geen TransformListener gevonden"
    for c in calls:
        assert "qos=" in c and "static_qos=" in c, f"TransformListener zonder qos: {c.strip()}"


def test_every_queue_fits_the_pool_several_times_over():
    ds = depths()
    assert ds, "geen diepten gevonden, klopt de parser nog?"
    assert max(ds) <= POOL_CHUNKS // 4, (
        f"diepte {max(ds)} is meer dan een kwart van de pool ({POOL_CHUNKS})")


def test_the_total_of_all_queues_stays_under_the_pool():
    total = sum(depths())
    assert total < POOL_CHUNKS, f"alle wachtrijen samen {total} op een pool van {POOL_CHUNKS}"


def test_the_status_probe_only_wants_the_newest():
    blok = re.search(r"RobotStatus,\s*f\"\{DECISION\}/robot_status\".*?\)\n", SRC, re.S)
    assert blok, "robot_status-abonnement niet gevonden"
    assert "depth=1" in blok.group(0), "robot_status komt met 50 Hz; alleen de nieuwste telt"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print(f"all chunk-budget checks passed (queues total {sum(depths())} of {POOL_CHUNKS})")
