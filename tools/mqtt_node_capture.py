# tools/mqtt_node_capture.py
"""Subscribe to Dart/Send_mqtt/+ and Dart/Receive_mqtt/+ on the local
broker, decrypt every payload using the SN-derived AES key, write a
JSONL stream to stdout. Caller redirects to a file.

Reuses server/src/mqtt/decrypt.ts logic in Python so we have one source
of truth across capture + production. The AES helpers below are the
SAME formulae the server uses; until we have our own aes.py these are
copied here verbatim. Phase 2 Task 2.1 will replace them with `from
mqtt_node.aes import decrypt`.

Usage:
  python3 tools/mqtt_node_capture.py \\
    --broker 127.0.0.1 --duration-sec 1800 \\
    --out research/documents/mqtt_node-payload-capture-2026-04-26.jsonl
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import paho.mqtt.client as mqtt
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend


def derive_key(sn: str) -> bytes:
    return ('abcdabcd1234' + sn[-4:]).encode('utf-8')


def decrypt(sn: str, ciphertext: bytes) -> bytes | None:
    if len(ciphertext) % 16 != 0:
        return None
    key = derive_key(sn)
    iv = b'abcd1234abcd1234'
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv),
                    backend=default_backend())
    dec = cipher.decryptor()
    pt = dec.update(ciphertext) + dec.finalize()
    return pt.rstrip(b'\x00')  # null-byte stripped (matches server)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--broker', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=1883)
    ap.add_argument('--duration-sec', type=int, default=1800)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fh = out.open('w')

    def on_message(_client, _userdata, msg):
        topic = msg.topic
        sn = topic.rsplit('/', 1)[-1]
        try:
            pt = decrypt(sn, msg.payload)
            decrypted = pt.decode('utf-8', errors='replace') if pt else None
        except Exception as e:
            decrypted = f'<decrypt error: {e}>'
        rec = {
            'ts': dt.datetime.utcnow().isoformat() + 'Z',
            'topic': topic,
            'sn': sn,
            'raw_len': len(msg.payload),
            'decrypted': decrypted,
        }
        fh.write(json.dumps(rec) + '\n')
        fh.flush()

    cli = mqtt.Client(client_id='mqtt-node-capture')
    cli.on_message = on_message
    cli.connect(args.broker, args.port, keepalive=30)
    cli.subscribe('Dart/Send_mqtt/+')
    cli.subscribe('Dart/Receive_mqtt/+')
    cli.subscribe('Dart/Receive_server_mqtt/+')

    cli.loop_start()
    deadline = time.time() + args.duration_sec
    while time.time() < deadline:
        time.sleep(1)
    cli.loop_stop()
    cli.disconnect()
    fh.close()


if __name__ == '__main__':
    main()
