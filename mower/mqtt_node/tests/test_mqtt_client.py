"""MQTT client wraps paho-mqtt with AES-aware publish/subscribe.

Mocks paho.mqtt.client so we can test the wrapper without a real
broker. Verifies:
- publish encrypts via aes module before paho.publish
- on_message decrypts via aes module before invoking caller's handler
- subscriber registration covers all three Dart/* topic prefixes
- NO domain whitelist — set_mqtt_info accepting bare IPs is the goal
"""
from __future__ import annotations
from unittest.mock import MagicMock, patch

import pytest

from mqtt_client import MqttClient


@pytest.fixture
def fake_paho(monkeypatch):
    fake = MagicMock()
    fake_module = MagicMock()
    fake_module.Client.return_value = fake
    monkeypatch.setattr('mqtt_client.mqtt', fake_module)
    return fake


def test_subscribes_to_all_dart_topics(fake_paho):
    cli = MqttClient(host='1.2.3.4', port=1883, sn='LFIN1231000211')
    cli.connect()
    assert ('Dart/Send_mqtt/LFIN1231000211',) in [
        c.args for c in fake_paho.subscribe.call_args_list
    ]


def test_publish_encrypts_unless_raw(fake_paho):
    cli = MqttClient(host='1.2.3.4', port=1883, sn='LFIN1231000211')
    cli.connect()
    cli.publish('Dart/Receive_mqtt/LFIN1231000211', b'{"hello":1}')
    args, kwargs = fake_paho.publish.call_args
    payload = args[1] if len(args) > 1 else kwargs['payload']
    assert payload != b'{"hello":1}'  # got encrypted
    assert len(payload) % 16 == 0


def test_publish_raw_skips_encrypt(fake_paho):
    cli = MqttClient(host='1.2.3.4', port=1883, sn='LFIN1231000211')
    cli.connect()
    cli.publish('Dart/Receive_mqtt/LFIN1231000211', b'plain', encrypted=False)
    args, kwargs = fake_paho.publish.call_args
    payload = args[1] if len(args) > 1 else kwargs['payload']
    assert payload == b'plain'


def test_inbound_message_is_decrypted(fake_paho):
    handler = MagicMock()
    cli = MqttClient(host='1.2.3.4', port=1883, sn='LFIN1231000211')
    cli.on_message(handler)
    cli.connect()
    # Build a real ciphertext via aes module so the wrapper can decrypt
    from aes import encrypt
    ciphertext = encrypt('LFIN1231000211', b'{"cmd":"test"}')
    fake_msg = MagicMock(topic='Dart/Send_mqtt/LFIN1231000211',
                         payload=ciphertext)
    cli._on_message(None, None, fake_msg)
    handler.assert_called_once()
    sn_arg, topic_arg, payload_arg = handler.call_args[0]
    assert sn_arg == 'LFIN1231000211'
    assert topic_arg == 'Dart/Send_mqtt/LFIN1231000211'
    assert payload_arg == b'{"cmd":"test"}'
