from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_no_direct_cmd_vel_publish_inside_recover_paths():
    src = DA.read_text()
    # _execute_slip_escape and _execute_loc_recover must NOT call cmd_vel_pub
    assert 'cmd_vel_pub.publish' not in src, (
        'Slip + loc recovery must publish CloudMoveCmd, not Twist on cmd_vel '
        '(CChassisControl gates cmd_vel — see memory feedback_safety.md).')
    assert '_publish_cloud_move' in src
