from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_lora_ok_initialized_true():
    """Test that self.lora_ok is initialized to True in __init__"""
    src = R.read_text()
    init_body = src.split('def __init__')[1].split('def ')[0]
    assert 'self.lora_ok = True' in init_body or 'self.lora_ok=True' in init_body


def test_on_incident_sets_lora_ok():
    """Test that lora_ok is tracked based on LORA_ERROR bit"""
    src = R.read_text()
    # Check either _on_incident or _process_incident_errors tracks it
    on_incident_body = src.split('def _on_incident')[1].split('def ')[0]
    process_errors_body = src.split('def _process_incident_errors')[1].split('def ')[0]
    combined = on_incident_body + process_errors_body
    assert 'lora_ok' in combined
    assert 'error_lora' in combined
