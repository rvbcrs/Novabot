#!/usr/bin/env python3
"""Self-check for the iceoryx mempool rebalance in build_custom_firmware.sh.

Every large message on this robot (Image4m, PointCloud2) fits the 4 MB pool;
the 8 MB pool has never handed out a chunk. Measured on LFIN1231000211 after
20 days: 4 MB 32/50 in use with 17 free at the low-water mark, 8 MB 0/50 with
50 free. When the 4 MB pool runs out, camera_307_cap cannot publish and the
camera stack ends up in a restart loop that only a power cycle clears.

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


def rewrite(src):
    """Run the build script's rewriter over a toml and return the result."""
    block = re.search(r"python3 - \"\$SHM_TOML\" << 'SHMEOF'\n(.*?)\nSHMEOF",
                      open(BUILD).read(), re.S)
    assert block, "mempool rewriter not found in build_custom_firmware.sh"
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as fh:
        fh.write(src)
        path = fh.name
    subprocess.run([sys.executable, "-c", block.group(1), path], check=True)
    return open(path).read()


def counts(toml):
    return dict(re.findall(r"size\s*=\s*(\d+)\s*\ncount\s*=\s*(\d+)", toml))


def test_chunks_move_from_the_dead_pool_to_the_starved_one():
    got = counts(rewrite(STOCK))
    assert got == {"4194944": "100", "8389272": "10"}, got


def test_the_new_layout_costs_less_memory_than_stock():
    before = sum(int(s) * int(c) for s, c in counts(STOCK).items())
    after = sum(int(s) * int(c) for s, c in counts(rewrite(STOCK)).items())
    assert after < before, (after, before)
    assert after / 1e6 < 520 and before / 1e6 > 620


def test_rerunning_the_build_is_idempotent():
    once = rewrite(STOCK)
    assert rewrite(once) == once


def test_an_unknown_pool_size_is_left_alone():
    src = STOCK + "\n[[segment.mempool]]\nsize = 131072\ncount = 64\n"
    assert counts(rewrite(src))["131072"] == "64"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all mempool checks passed")
