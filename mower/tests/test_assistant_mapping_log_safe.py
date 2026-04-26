from pathlib import Path
import re

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_run_assistant_mapping_does_not_reference_undefined_dist():
    src = SVC.read_text()
    method = re.search(
        r'def _run_assistant_mapping[^\n]*\n(.*?)(?=\n    def |\nclass )',
        src, re.DOTALL).group(1)
    assert 'dist_from_charger' not in method, (
        'dist_from_charger is undefined in this scope; logging it raises '
        'NameError every time start_assistant_mapping is called from the '
        'charger.')
    # ensure the log line still mentions on-charger context so we don't lose info
    assert 'is_on_charger' in method
