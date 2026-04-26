"""Periodic HTTP loops the stock binary runs.

net_check_fun:
- Endpoint: POST http://<host>:<port>/api/nova-network/network/connection
- Period: 30 seconds
- Body: {"sn": "<serial>"}
- Failure tolerance: per CLAUDE.md, more than 3 failures triggers a WiFi
  reconnect on the firmware side. We just count and log; the firmware
  has its own watchdog.

http_work_fun:
- Sensor sync to the local server (same host, different endpoint).
- Period: 60 seconds
"""
from __future__ import annotations
import logging
import threading
import time
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

    def http_work_once(self) -> None:
        url = self._url('/api/nova-work/sync')
        try:
            r = requests.post(url, json={'sn': self.sn}, timeout=5)
            log.debug('http_work %s → %s', url, r.status_code)
        except Exception as e:
            log.warning('http_work failed (%s): %s', url, e)

    # ── Loop helpers ───────────────────────────────────────────────
    def _loop(self, fn, period_sec: float) -> None:
        while not self._stop.is_set():
            fn()
            self._stop.wait(period_sec)

    def start(self) -> None:
        t1 = threading.Thread(target=self._loop, args=(self.net_check_once, 30.0),
                              daemon=True, name='net_check_fun')
        t2 = threading.Thread(target=self._loop, args=(self.http_work_once, 60.0),
                              daemon=True, name='http_work_fun')
        for t in (t1, t2):
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2.0)
