from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_add_area_supports_unicom_to_station_type_3():
    body = SVC.read_text().split(
        'def _handle_add_area')[1].split('def ')[0]
    assert 'request.type == 3' in body
    assert 'UNICOM_TO_STATION' in body
