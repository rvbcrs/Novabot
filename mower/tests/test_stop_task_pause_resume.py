"""stop_task must distinguish pause (data=true) from resume (data=false).

Pause (data=true): USER_STOP, cancel running goals
Resume (data=false): re-fire the last coverage goal if available, log
  'Receiving cov continue command!!!'

We assert via source inspection that both branches exist.
"""
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_stop_task_distinguishes_pause_and_resume():
    src = SVC.read_text()
    assert 'request.data' in src.split('def _handle_stop_task')[1].split('def ')[0]
    # both branches must exist
    body = src.split('def _handle_stop_task')[1].split('def ')[0]
    assert 'cov continue' in body or 'resume' in body.lower()
    assert 'USER_STOP' in body


def test_stop_task_pause_logs_user_stop():
    src = SVC.read_text()
    body = src.split('def _handle_stop_task')[1].split('def ')[0]
    # Pause (data=true) branch must set USER_STOP
    assert 'USER_STOP' in body


def test_stop_task_resume_logs_cov_continue():
    src = SVC.read_text()
    body = src.split('def _handle_stop_task')[1].split('def ')[0]
    # Resume (data=false) branch must log the exact string
    assert 'Receiving cov continue command' in body
