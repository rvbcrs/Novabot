from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_lora_branch_starts_recover_thread():
    src = DA.read_text()
    assert '_lora_recover_loop' in src
    body = src.split('handle_incident_during_task')[1].split('def ')[0]
    assert 'LORA_ERROR' in body
    assert 'threading' in body or 'Thread' in body or '_lora_recover_loop' in body


def test_lora_recover_loop_uses_cloud_move():
    src = DA.read_text()
    body = src.split('def _lora_recover_loop')[1].split('def ')[0]
    assert '_publish_cloud_move' in body
