#!/usr/bin/env python3
"""Self-check for plan_canvas_growth() in research/extended_commands.py.

The mower plans coverage on map.pgm, which only covers terrain it has driven.
A zone drawn on the dashboard beyond that edge had zero free cells, so the
planner refused it however large the polygon was (live .244, 2026-09-12:
map4/5/6 lay entirely outside the raster). The raster now grows to fit.

The one thing that must never break: an old pixel keeps its world position
after growing, otherwise every existing map silently shifts.

Run: python3 research/__tests__/test_canvas_growth.py
"""
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

RES = 0.05
# The real .244 raster on 2026-09-12: 612 x 340 cells, covering
# x -25.55..5.05 and y -1.55..15.45 metres.
OX, OY, W, H = -25.55, -1.55, 612, 340


def world_y(oy, height, row):
    return oy + (height - 1 - row) * RES


def world_x(ox, col):
    return ox + col * RES


def test_inside_needs_no_growth():
    pts = [(0.0, 5.0), (3.0, 8.0)]           # well inside, margin fits too
    assert ec.plan_canvas_growth(OX, OY, RES, W, H, pts) is None


def test_growth_covers_the_drawn_area_with_margin():
    pts = [(12.0, 20.0), (18.0, 26.0)]        # right of and above the raster
    plan = ec.plan_canvas_growth(OX, OY, RES, W, H, pts, margin_m=2.0)
    assert plan is not None
    assert plan["pad_l"] == 0 and plan["pad_b"] == 0   # nothing needed on those sides
    right_edge = plan["ox"] + plan["W"] * RES
    top_edge = plan["oy"] + plan["H"] * RES
    assert right_edge >= 18.0 + 2.0 - 1e-9
    assert top_edge >= 26.0 + 2.0 - 1e-9


def test_old_pixels_keep_their_world_position():
    pts = [(-40.0, -12.0), (20.0, 30.0)]      # grows on all four sides
    plan = ec.plan_canvas_growth(OX, OY, RES, W, H, pts)
    assert plan is not None
    assert plan["pad_l"] > 0 and plan["pad_r"] > 0
    assert plan["pad_b"] > 0 and plan["pad_t"] > 0
    for row, col in [(0, 0), (H - 1, W - 1), (123, 45)]:
        assert abs(world_x(OX, col) - world_x(plan["ox"], col + plan["pad_l"])) < 1e-9
        assert abs(world_y(OY, H, row) - world_y(plan["oy"], plan["H"], row + plan["pad_t"])) < 1e-9


def test_refuses_to_grow_past_the_cell_budget():
    pts = [(5000.0, 5000.0)]                  # a mis-projected point, not a garden
    assert ec.plan_canvas_growth(OX, OY, RES, W, H, pts) is None


def test_no_points_is_no_growth():
    assert ec.plan_canvas_growth(OX, OY, RES, W, H, []) is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all canvas-growth checks passed")
