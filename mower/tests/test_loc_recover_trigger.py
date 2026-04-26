from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_check_localization_calls_loc_recover():
    src = DA.read_text()
    # in check_localization the host method must be called
    assert '_send_loc_recover_goal' in src
