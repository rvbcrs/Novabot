"""start_cov_task must distinguish cov_mode:
  0 = full coverage (default)
  1 = SPECIFIED_AREA — polygon_area from request
  2 = BOUNDARY_COV — only_edge_mode=True

We assert via source inspection that all three branches exist.
"""
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_cov_mode_0_branch_exists():
    src = SVC.read_text()
    assert 'cov_mode == 0' in src or 'cov_mode in (0' in src


def test_cov_mode_1_specified_area_branch_exists():
    src = SVC.read_text()
    assert 'cov_mode == 1' in src
    assert 'polygon_area' in src


def test_cov_mode_2_only_edge_mode_set_true():
    src = SVC.read_text()
    assert 'only_edge_mode=True' in src or 'only_edge_mode = True' in src
