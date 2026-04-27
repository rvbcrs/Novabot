"""Periodic HTTP loops the stock binary runs.

Confirmed endpoints (research/documents/mqtt_node-strings.md:752-767):
  /api/nova-network/network/connection — periodic health check (verified)
  /api/nova-data/cut                   — cut-grass work record (multipart)
  /api/nova-data/equipment             — equipment state heartbeat
  /api/nova-message/machine            — machine messages
  /api/nova-user/equipment/machine     — equipment management
  /api/nova-file-server/map/upload     — map upload (event-driven, not periodic)

net_check_fun:
- Endpoint: POST http://<host>:<port>/api/nova-network/network/connection
- Period: 30 seconds
- Body: {"sn": "<serial>"}
- Failure tolerance: per CLAUDE.md, more than 3 failures triggers a WiFi
  reconnect on the firmware side. We just count and log; the firmware
  has its own watchdog.

http_work_fun:
- Stock posts multipart cut-grass records to /api/nova-data/cut and
  equipment state to /api/nova-data/equipment. Body shape NOT yet
  reverse-engineered (gap analysis §9). Loop is intentionally inert
  until we have real payload schemas — sending bogus JSON would just
  log errors on the server.
"""
from __future__ import annotations
import logging
import threading
from typing import Optional

import requests

log = logging.getLogger('mqtt_node.http_client')


class HttpClient:
    def __init__(self, host: str, port: int, sn: str):
        self.host = host
        self.port = port
        self.sn = sn
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def _url(self, path: str) -> str:
        return f'http://{self.host}:{self.port}{path}'

    # ── Single-shot helpers (testable) ─────────────────────────────
    def net_check_once(self) -> None:
        url = self._url('/api/nova-network/network/connection')
        try:
            r = requests.post(url, json={'sn': self.sn}, timeout=5)
            log.debug('net_check %s → %s', url, r.status_code)
        except Exception as e:
            log.warning('net_check failed (%s): %s', url, e)

    # ── Loop helpers ───────────────────────────────────────────────
    def _loop(self, fn, period_sec: float) -> None:
        while not self._stop.is_set():
            fn()
            self._stop.wait(period_sec)

    def start(self) -> None:
        t = threading.Thread(target=self._loop,
                             args=(self.net_check_once, 30.0),
                             daemon=True, name='net_check_fun')
        t.start()
        self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2.0)
