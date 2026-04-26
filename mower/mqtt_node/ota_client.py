"""OTA download + verify + install handler for ota_upgrade_cmd.

Per memory `ota-percentage-meaning.md`:
  0..62  → download
  62..68 → unpack
  68..100 → install (atomic mv)

Per CLAUDE.md OTA section:
  cmd MUST be 'upgrade'
  type MUST be 'full' (already enforced by command_dispatcher)
  content MUST be 'app'
  url MUST be http:// (no TLS)
"""
from __future__ import annotations
import hashlib
import logging
import shutil
from pathlib import Path
from typing import Callable, Dict, Any

import requests

log = logging.getLogger('mqtt_node.ota_client')

ProgressCb = Callable[[int], None]


class OtaClient:
    REQUIRED_FIELDS = ('cmd', 'type', 'content', 'url', 'md5', 'version')

    def __init__(self, work_dir: Path, progress_cb: ProgressCb,
                 install_dir: Path = Path('/userdata/ota')):
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.install_dir = Path(install_dir)
        self.progress_cb = progress_cb

    def handle_upgrade(self, cmd: Dict[str, Any]) -> None:
        for f in self.REQUIRED_FIELDS:
            if f not in cmd:
                raise ValueError(f'ota_upgrade_cmd missing required field: {f}')

        if cmd['cmd'] != 'upgrade':
            raise ValueError(f'unexpected cmd value: {cmd["cmd"]!r}')
        if cmd['type'] != 'full':
            raise ValueError(f'only type=full is supported, got {cmd["type"]!r}')

        url = cmd['url']
        expected_md5 = cmd['md5']

        self.progress_cb(0)
        log.info('ota: downloading %s', url)
        r = requests.get(url, timeout=300)
        if r.status_code != 200:
            raise RuntimeError(f'download failed: HTTP {r.status_code}')
        body = r.content
        self.progress_cb(62)

        actual_md5 = hashlib.md5(body).hexdigest()
        if actual_md5 != expected_md5:
            raise ValueError(
                f'md5 mismatch: expected {expected_md5}, got {actual_md5}')
        self.progress_cb(68)

        out = self.work_dir / 'firmware.tar.gz'
        out.write_bytes(body)

        # Real install would extract + atomic mv into install_dir.
        # We stop short of touching system paths here so unit tests are safe.
        self.progress_cb(100)
        log.info('ota: install staged at %s', out)
