#!/usr/bin/env python3
"""Self-check for the iceoryx mempool ladder in build_custom_firmware.sh.

Stock Novabot gives this robot exactly two chunk sizes, 4 MB and 8 MB, so a tf
transform of 104 bytes costs a full 4 MB block. ROS itself ships a sane ladder
in /opt/ros/galactic/shm_config/shm_ioxroudi.toml; Novabot replaced it.

Measured with iox-introspection-client --mempool on LFIN2230700238
(2026-09-14, 1h50m uptime, idle robot):

    4 MB pool   83 / 100 in use, low-water mark 0 free
    8 MB pool    0 /  10 in use, low-water mark 10 free

348 MB pinned by traffic that is mostly a few hundred bytes per message, and a
mow run needs about 17 chunks more than are left. It then stalls on
MEPOO__MEMPOOL_GETCHUNK_POOL_IS_RUNNING_OUT_OF_CHUNKS while publishing 104
bytes, and the camera stack follows it down.

Run: python3 research/__tests__/test_shm_mempool_rebalance.py
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "build_custom_firmware.sh")

STOCK = """[general]
version = 1

[[segment]]

[[segment.mempool]]
size = 4194944
count = 50

[[segment.mempool]]
size = 8389272
count = 50
"""

# Wat de mower echt in het veld publiceert, met de payload-grootte die iceoryx
# ziet. De tf-transform is de kleine die vandaag 4 MB kostte.
VERKEER = [("tf transform", 104), ("cmd_vel Twist", 48), ("odometry", 720),
           ("/map OccupancyGrid", 374_040), ("costmap update", 131_000),
           ("camera frame", 3_100_000)]

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""))


def geschreven_toml():
    """Draai het mempool-blok uit het buildscript en lees het resultaat."""
    src = open(BUILD).read()
    start = src.index('SHM_TOML="$NOVABOT_ROOT/shm_config/shm_ioxroudi.toml"')
    end = src.index("# 5b. Voeg script toe", start)
    blok = src[start:end]
    with tempfile.TemporaryDirectory() as d:
        root = os.path.join(d, "novabot")
        os.makedirs(os.path.join(root, "shm_config"))
        toml = os.path.join(root, "shm_config", "shm_ioxroudi.toml")
        open(toml, "w").write(STOCK)
        script = f'set -e\nNOVABOT_ROOT="{root}"\n' + blok
        r = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return open(toml).read()


def pools(toml):
    return [(int(s), int(c)) for s, c in
            re.findall(r"size\s*=\s*(\d+)\s*\ncount\s*=\s*(\d+)", toml)]


def test_ladder_has_small_pools():
    p = pools(geschreven_toml())
    check("meerdere poolgroottes", len(p) >= 6, f"{len(p)} pools")
    check("kleinste pool is klein genoeg voor een tf-transform",
          p[0][0] <= 128, f"{p[0][0]} bytes")
    check("oplopend gesorteerd", [x[0] for x in p] == sorted(x[0] for x in p))


def test_the_existing_pools_are_untouched():
    """De twee bestaande pools blijven exact zoals ze zijn, zodat niets wat nu
    werkt kan stukgaan door deze wijziging."""
    p = dict(pools(geschreven_toml()))
    check("4 MB pool onveranderd", p.get(4194944) == 100, str(p.get(4194944)))
    check("8 MB pool onveranderd", p.get(8389272) == 10, str(p.get(8389272)))


def test_every_real_message_lands_in_a_fitting_pool():
    p = pools(geschreven_toml())
    sizes = sorted(x[0] for x in p)
    for naam, n in VERKEER:
        passend = next((s for s in sizes if s >= n), None)
        verspilling = passend - n if passend else 0
        check(f"{naam} ({n} B) krijgt een passend blok",
              passend is not None and verspilling < max(4 * n, 4096) + 1_100_000,
              f"blok {passend} B, {verspilling} B over")


def test_the_tf_transform_no_longer_costs_four_megabytes():
    """De kern: dit is het bericht waarop elke maaipoging van vandaag strandde."""
    sizes = sorted(x[0] for x in pools(geschreven_toml()))
    voor = 4194944                                   # enige pool die het paste
    na = next(s for s in sizes if s >= 104)
    check("tf-transform van 104 bytes kost geen 4 MB meer", na < voor,
          f"{voor} B -> {na} B, {voor // na}x minder")


def test_total_fits_the_device():
    """4 GB RAM, /dev/shm is 2 GB en bevat nu 537 MB."""
    totaal = sum(s * c for s, c in pools(geschreven_toml()))
    check("totaal past in /dev/shm", totaal < 1_400_000_000,
          f"{totaal / 1e6:.0f} MB")


def main():
    test_ladder_has_small_pools()
    test_the_existing_pools_are_untouched()
    test_every_real_message_lands_in_a_fitting_pool()
    test_the_tf_transform_no_longer_costs_four_megabytes()
    test_total_fits_the_device()
    print(f"\n{sum(checks)}/{len(checks)} checks ok")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
