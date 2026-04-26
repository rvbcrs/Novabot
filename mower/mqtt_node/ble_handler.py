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


# Bluez D-Bus GATT server — Phase 4 stub. The real implementation requires
# dbus-next on the mower (bluez D-Bus is not usable on macOS dev).
def start_gatt_server(framer: BleFramer,
                      on_command: Callable[[Dict[str, Any]], None]) -> None:
    """Bluez D-Bus GATT server. Registers one service + two chars (write
    in, notify out). Every WRITE is fed into framer; framer yields full
    JSON commands which on_command receives. Notifies are sent back by
    calling _notify(payload_bytes) — wired below.

    Reference UUIDs: bootstrap/src/ble.ts (the Node.js noble client uses
    the same UUIDs the stock binary advertises). Capture from RE-6
    (research/documents/mqtt_node-ble-trace.md) is deferred — the file
    documents the protocol but live UUIDs need to be sniffed when the
    runtime acceptance phase fires up bluez on the mower.
    """
    try:
        from dbus_next.aio import MessageBus  # noqa: F401
        from dbus_next.service import (  # noqa: F401
            ServiceInterface, method, dbus_property,
        )
    except ImportError as e:
        raise RuntimeError(
            'dbus-next not installed — pip install dbus-next on the mower'
        ) from e
    # Full implementation pending RE-6 capture — refer to
    # research/documents/mqtt_node-ble-trace.md for the exact service +
    # char UUIDs the stock binary advertises before populating below.
    raise NotImplementedError(
        'BLE GATT server stub — populate from RE-6 capture before activation')
