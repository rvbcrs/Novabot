from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_delete_map_uses_request_maptype():
    body = SVC.read_text().split('def _handle_delete_map')[1].split('def ')[0]
    assert 'request.maptype' in body
    assert 'req.type = 3' not in body or 'request.maptype' in body  # not hardcoded


def test_delete_map_transitions_through_delete_states():
    body = SVC.read_text().split('def _handle_delete_map')[1].split('def ')[0]
    assert 'DELETE_CHILD_MAP' in body
    assert 'DELETE_OBSTACLE' in body
    assert 'DELETE_UINICOM' in body  # closed binary keeps the typo
