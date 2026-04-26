"""BLE frame parser + (later) Bluez D-Bus GATT server.

This file currently contains BleFramer — a pure-Python re-implementation
of the stock binary's frame protocol. The Bluez D-Bus GATT server lives
in start() and is a no-op import on macOS (where dbus-next is unusable).
That keeps unit tests Mac-friendly while leaving the production wiring
intact.

References:
- memory ble-provisioning-protocol.md
- memory ble-provisioning-facts.md
- bootstrap/src/ble.ts (Node.js noble implementation, source of truth
  for frame format + command sequences)
"""
from __future__ import annotations
import json
import logging
from typing import Iterator, Optional, Callable, Dict, Any

log = logging.getLogger('mqtt_node.ble_handler')

START = b'le_start'
END = b'le_end'


class BleFramer:
    def __init__(self):
        self._buf: bytearray = bytearray()

    def feed(self, chunk: bytes) -> Iterator[Dict[str, Any]]:
        self._buf.extend(chunk)
        while True:
            s = self._buf.find(START)
            if s < 0:
                # Drop everything before first START marker
                self._buf.clear()
                return
            e = self._buf.find(END, s + len(START))
            if e < 0:
                # Wait for more data
                # Trim everything before the START marker we found
                if s > 0:
                    del self._buf[:s]
                return
            body = bytes(self._buf[s + len(START):e])
            del self._buf[:e + len(END)]
            try:
                yield json.loads(body.decode('utf-8'))
            except Exception as ex:
                log.warning('ble_framer: discarded invalid frame (%d bytes): %s',
                            len(body), ex)


# Bluez D-Bus GATT server is a Phase 4 concern — see Task 4.x.
def start_gatt_server(framer: BleFramer,
                      on_command: Callable[[Dict[str, Any]], None]) -> None:
    """Production entry: register a Bluez GATT char and feed every WRITE
    into framer. Each yielded JSON gets dispatched via on_command. Not
    wired on macOS.
    """
    raise NotImplementedError('BLE GATT server wired in Phase 4 Task 4.X')
