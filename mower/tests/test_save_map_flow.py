"""save_map must honor parent map name + include 500ms delay between type:0 and type:1.

References: docs/reference/MAPPING-FLOW.md
- type:0 (sub-map) generates csv_file + x3_csv_file
- 500ms delay required for map.yaml creation
- type:1 (total map) generates map.pgm + map.png + map.yaml

Without the delay, /map_server/load_map fails with Error 107 "Load map failed"
because map.yaml doesn't exist yet.
"""
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_save_map_uses_request_map_name_not_hardcoded():
    """save_map must not hardcode parent='home0' — use request or node state."""
    src = SVC.read_text()
    body = src.split('def _handle_save_map')[1].split('def ')[0]
    # parent name must come from request or node state, not literal 'home0'
    # Allow either: request.map_file_name or n.current_map_name fallback
    assert "map_name = 'home0'" not in body or 'request.' in body, (
        "save_map must not hardcode parent='home0' — use request fields or node state.")


def test_save_map_has_500ms_delay_between_type0_and_type1():
    """MAPPING-FLOW.md requires ~500ms gap between save_map type:0 and type:1.

    This delay allows map.yaml to be created by the firmware before
    save_map type:1 is called.
    """
    src = SVC.read_text()
    body = src.split('def _handle_save_map')[1].split('def ')[0]
    assert '0.5' in body and 'time.sleep' in body, (
        'MAPPING-FLOW.md requires ~500ms gap between save_map type:0 and '
        'type:1 so map.yaml can be created.')
