"""save_map must honor parent map name + branch on request.type.

References: docs/reference/MAPPING-FLOW.md
- type:0 (sub-map) generates csv_file + x3_csv_file, saves charging pose
- type:1 (total map) generates map.pgm + map.png + map.yaml, saves UTM origin
- The app sends two separate calls with ~500ms gap; handler only runs the
  matching stage (no sleep inside the handler — app drives the cadence).
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


def test_save_map_branches_on_request_type():
    """save_map must branch on request.type (0=sub, 1=total).

    The app sends two separate calls (type:0 then type:1 ~500ms later).
    The handler must only run the matching stage — running both on every
    call would double-generate files and race the firmware.
    """
    src = SVC.read_text()
    body = src.split('def _handle_save_map')[1].split('def ')[0]
    assert 'save_type == 0' in body and 'save_type == 1' in body, (
        'save_map must branch on save_type (0=sub, 1=total) to honour the '
        'two-call protocol the app uses.')
