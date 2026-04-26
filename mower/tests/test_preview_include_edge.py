from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_preview_uses_request_include_edge():
    body = SVC.read_text().split(
        'def _handle_generate_path')[1].split('def ')[0]
    assert 'req.include_edge = False' not in body, (
        'Hardcoded include_edge=False — must use request data')
    assert 'request.' in body and 'include_edge' in body
