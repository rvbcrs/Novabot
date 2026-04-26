"""OTA client downloads firmware via HTTP Range, verifies MD5, installs
atomically. Mock requests + filesystem; do not touch real disk."""
from unittest.mock import MagicMock, patch

import pytest

from ota_client import OtaClient


def _md5_of(b: bytes) -> str:
    import hashlib
    return hashlib.md5(b).hexdigest()


def test_handle_upgrade_happy_path(tmp_path):
    progress = []
    cli = OtaClient(work_dir=tmp_path, progress_cb=progress.append)

    fw_bytes = b'firmware-payload-bytes-' * 100
    cmd = {
        'cmd': 'upgrade',
        'type': 'full',
        'content': 'app',
        'url': 'http://x/firmware.tar.gz',
        'md5': _md5_of(fw_bytes),
        'version': '6.0.2-custom-25',
    }

    with patch('ota_client.requests.get') as mock_get:
        mock_get.return_value = MagicMock(content=fw_bytes, status_code=200)
        cli.handle_upgrade(cmd)

    assert progress[0] == 0
    assert progress[-1] == 100
    assert (tmp_path / 'firmware.tar.gz').exists()


def test_md5_mismatch_aborts(tmp_path):
    progress = []
    cli = OtaClient(work_dir=tmp_path, progress_cb=progress.append)
    fw_bytes = b'wrong'
    cmd = {
        'cmd': 'upgrade', 'type': 'full', 'content': 'app',
        'url': 'http://x/y', 'md5': 'deadbeef', 'version': 'x',
    }
    with patch('ota_client.requests.get') as mock_get:
        mock_get.return_value = MagicMock(content=fw_bytes, status_code=200)
        with pytest.raises(ValueError, match='md5'):
            cli.handle_upgrade(cmd)


def test_missing_required_field_aborts(tmp_path):
    cli = OtaClient(work_dir=tmp_path, progress_cb=lambda _p: None)
    with pytest.raises(ValueError, match='cmd'):
        cli.handle_upgrade({'type': 'full', 'url': 'x', 'md5': 'x', 'version': 'x'})
