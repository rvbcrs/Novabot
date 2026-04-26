from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_subscribes_to_coverage_planner_covered_path_json():
    src = R.read_text()
    assert "'/coverage_planner_server/covered_path_json'" in src
    assert '_on_covered_path' in src or '_relay_covered_path' in src
