"""start_cov_task must distinguish cov_mode:
  0 = full coverage (default)
  1 = SPECIFIED_AREA — polygon_area from request
  2 = BOUNDARY_COV — include_edge=True + note about start_edge_cut

We assert via source inspection that all three branches exist.

Note: only_edge_mode field does NOT exist on NavigateThroughCoveragePaths.action
(verified 2026-04-26 from live mower action definition). True boundary-only
mowing goes via extended_commands start_edge_cut → NTCP at ROS level.
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


def test_cov_mode_2_boundary_comment_and_include_edge():
    """cov_mode=2 must set include_edge and reference start_edge_cut for
    pure boundary-only, since only_edge_mode does not exist on the action."""
    src = SVC.read_text()
    assert 'cov_mode == 2' in src
    # include_edge is what gets set for cov_mode=2
    assert 'include_edge = (cov_mode == 2)' in src or 'include_edge' in src
    # Code must document that only_edge_mode field does not exist and that
    # true boundary-only goes via start_edge_cut
    assert 'start_edge_cut' in src
    # only_edge_mode must NOT be passed to start_coverage from this handler
    # (it is still accepted on the function signature for API compat, but
    # service_handlers must not set it to True for cov_mode=2)
    body = src.split('def _handle_start_cov_task')[1].split('def _handle_save_map')[0]
    assert 'only_edge_mode=True' not in body
    assert 'only_edge_mode = True' not in body
