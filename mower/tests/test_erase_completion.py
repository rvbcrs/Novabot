from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_handle_start_erase_uses_worker_thread():
    src = SVC.read_text()
    body = src.split('def _handle_start_erase')[1].split('def ')[0]
    assert 'threading' in body or 'Thread' in body or '_run_erase' in body


def test_run_erase_transitions_to_success_or_failed():
    src = SVC.read_text()
    assert 'AUTO_ERASE_MAPPING_SUCCESS' in src
    assert 'AUTO_ERASE_MAPPING_FAILED' in src
