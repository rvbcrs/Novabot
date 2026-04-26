"""BLE handler frame parser + command dispatch.

Per memory `ble-provisioning-protocol.md`:
- Frames begin with 'le_start' magic, end with 'le_end'
- Body is plain JSON
- Fragmented frames are reassembled by the framer; full JSON is what
  the dispatcher sees
"""
import json

import pytest

from ble_handler import BleFramer


def test_single_frame_yields_decoded_json():
    framer = BleFramer()
    payload = b'le_start{"set_wifi_info": {"ssid": "x"}}le_end'
    decoded = list(framer.feed(payload))
    assert decoded == [{'set_wifi_info': {'ssid': 'x'}}]


def test_fragmented_frame_reassembled():
    framer = BleFramer()
    out = []
    out.extend(framer.feed(b'le_start{"set_'))
    out.extend(framer.feed(b'mqtt_info":{"addr":"x","port":1883}}le_end'))
    assert out == [{'set_mqtt_info': {'addr': 'x', 'port': 1883}}]


def test_garbage_outside_markers_ignored():
    framer = BleFramer()
    out = list(framer.feed(b'JUNKle_start{"a":1}le_endMORE'))
    assert out == [{'a': 1}]


def test_invalid_json_in_frame_skipped():
    framer = BleFramer()
    out = list(framer.feed(b'le_start{not json}le_end'))
    assert out == []
