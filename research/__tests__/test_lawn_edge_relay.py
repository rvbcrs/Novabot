#!/usr/bin/env python3
"""Self-check voor de pure hermapkern van research/lawn_edge_relay.py.
Run: python3 research/__tests__/test_lawn_edge_relay.py"""
import importlib.util, os, struct
import numpy as np

spec = importlib.util.spec_from_file_location(
    "ler", os.path.join(os.path.dirname(__file__), "..", "lawn_edge_relay.py"))
ler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ler)


def make_buf(points):
    """points = [(x, y, z, label), ...] → packed 13B/punt buffer."""
    out = b""
    for x, y, z, lab in points:
        out += struct.pack("<fffB", x, y, z, lab)
    return out


def test_relabel_non_lawn_to_obstacle():
    buf = make_buf([(1.0, 2.0, 0.1, 2),    # lawn → blijft 2
                    (1.5, 2.0, 0.2, 1),    # background → 5
                    (2.0, 2.0, 0.3, 8),    # bush → 5
                    (2.5, 2.0, 0.0, 2)])   # lawn → blijft 2
    out = ler.relabel(buf)
    labels = np.frombuffer(out, dtype=np.uint8)[ler.LABEL_OFFSET::ler.POINT_STEP]
    assert list(labels) == [2, 5, 5, 2], labels


def test_relabel_preserves_xyz():
    buf = make_buf([(1.25, -3.5, 0.75, 11)])
    out = ler.relabel(buf)
    x, y, z, lab = struct.unpack("<fffB", out)
    assert (x, y, z) == (1.25, -3.5, 0.75)
    assert lab == 5


def test_relabel_bad_stride_passthrough():
    buf = b"\x00" * 14  # geen veelvoud van 13 → ongewijzigd terug
    assert ler.relabel(buf) == buf


def test_relabel_empty():
    assert ler.relabel(b"") == b""


if __name__ == "__main__":
    test_relabel_non_lawn_to_obstacle()
    test_relabel_preserves_xyz()
    test_relabel_bad_stride_passthrough()
    test_relabel_empty()
    print("OK - alle lawn_edge_relay kern-tests geslaagd")
