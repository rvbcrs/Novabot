#!/usr/bin/env python3
"""
PIN Serial Test — stuurt raw PIN commando's naar de chassis MCU via /dev/ttyACM0.

Gebruik via SSH op de maaier:
  python3 /tmp/pin_serial_test.py query          # Query huidige PIN (type=0)
  python3 /tmp/pin_serial_test.py set 1234        # Set PIN naar 1234 (type=1)
  python3 /tmp/pin_serial_test.py verify 3053     # Probeer PIN te verifieren (type=2)
  python3 /tmp/pin_serial_test.py type3 3053      # Test type=3 met PIN
  python3 /tmp/pin_serial_test.py raw 4 3053      # Stuur willekeurig type byte

Serial frame formaat (15 bytes totaal):
  [02 02] [07 ff] [08] [23 tt pp pp pp pp 00 CC] [03 03]
  STX STX  CMD_ID  LEN  inner_payload (8 bytes)   ETX ETX

CRC-8 polynomial: 0x07 (ITU-T), init=0x00, over inner bytes 0-6.
"""

import sys
import os
import time
import struct

# CRC-8 lookup table (polynomial 0x07)
CRC8_TABLE = [
    0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15,
    0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
    0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65,
    0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
    0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5,
    0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
    0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85,
    0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
    0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2,
    0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
    0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2,
    0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
    0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32,
    0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
    0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42,
    0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
    0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c,
    0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
    0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec,
    0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
    0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c,
    0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
    0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c,
    0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
    0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b,
    0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
    0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b,
    0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
    0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb,
    0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
    0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb,
    0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3,
]


def crc8(data: bytes) -> int:
    """CRC-8 ITU-T (poly 0x07, init 0x00)."""
    crc = 0x00
    for b in data:
        crc = CRC8_TABLE[crc ^ b]
    return crc


def build_pin_frame(type_byte: int, pin: str) -> bytes:
    """Bouw het complete 15-byte serial frame voor een PIN commando."""
    assert len(pin) == 4 and pin.isdigit(), f"PIN moet 4 cijfers zijn, got: {pin!r}"
    assert 0 <= type_byte <= 255, f"Type byte moet 0-255 zijn, got: {type_byte}"

    # Inner payload (8 bytes): [0x23] [type] [PIN_0] [PIN_1] [PIN_2] [PIN_3] [0x00] [CRC]
    inner = bytes([
        0x23,                          # PIN command byte
        type_byte,                     # type: 0=query, 1=set, 2=verify?, 3=?
        ord(pin[0]),                   # PIN digit 0 (ASCII)
        ord(pin[1]),                   # PIN digit 1 (ASCII)
        ord(pin[2]),                   # PIN digit 2 (ASCII)
        ord(pin[3]),                   # PIN digit 3 (ASCII)
        0x00,                          # padding
    ])
    crc = crc8(inner)
    inner_with_crc = inner + bytes([crc])

    # Outer envelope: [02 02] [07 ff] [08] [inner 8 bytes] [03 03]
    frame = bytes([
        0x02, 0x02,      # STX STX
        0x07, 0xff,      # Command ID (big-endian)
        0x08,            # inner payload length = 8
    ]) + inner_with_crc + bytes([
        0x03, 0x03,      # ETX ETX
    ])

    assert len(frame) == 15, f"Frame moet 15 bytes zijn, got: {len(frame)}"
    return frame


def find_serial_port() -> str:
    """Zoek de juiste /dev/ttyACM* poort."""
    for port in ['/dev/ttyACM0', '/dev/ttyACM1', '/dev/ttyACM2']:
        if os.path.exists(port):
            return port
    raise RuntimeError("Geen /dev/ttyACM* poort gevonden")


def send_frame(frame, read_response=True):
    """Stuur een frame naar de MCU en lees optioneel het antwoord."""
    port = find_serial_port()
    print(f"[SERIAL] Poort: {port}")
    print(f"[SERIAL] Frame ({len(frame)} bytes): {frame.hex(' ')}")

    # Open serial port in raw mode
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        # Schrijf het frame
        written = os.write(fd, frame)
        print(f"[SERIAL] {written} bytes geschreven")

        if not read_response:
            return None

        # Wacht op antwoord (MCU reageert meestal binnen 100ms)
        time.sleep(0.5)

        # Probeer te lezen (non-blocking)
        response = b''
        for _ in range(10):
            try:
                chunk = os.read(fd, 256)
                if chunk:
                    response += chunk
                    print(f"[SERIAL] Ontvangen ({len(chunk)} bytes): {chunk.hex(' ')}")
                else:
                    break
            except OSError:
                break
            time.sleep(0.1)

        if response:
            print(f"[SERIAL] Totaal antwoord ({len(response)} bytes): {response.hex(' ')}")
            # Probeer het antwoord te parsen
            parse_response(response)
        else:
            print("[SERIAL] Geen antwoord ontvangen (timeout)")

        return response

    finally:
        os.close(fd)


def parse_response(data: bytes) -> None:
    """Probeer een MCU response te parsen."""
    # Zoek naar 02 02 header
    for i in range(len(data) - 6):
        if data[i] == 0x02 and data[i + 1] == 0x02:
            cmd_id = (data[i + 2] << 8) | data[i + 3]
            payload_len = data[i + 4]
            if i + 5 + payload_len + 2 <= len(data):
                payload = data[i + 5:i + 5 + payload_len]
                print(f"  [PARSE] CMD ID: 0x{cmd_id:04x}, payload len: {payload_len}")
                print(f"  [PARSE] Payload: {payload.hex(' ')}")
                if payload_len >= 2:
                    inner_cmd = payload[0]
                    print(f"  [PARSE] Inner CMD: 0x{inner_cmd:02x}")
                    if inner_cmd == 0x23 and payload_len >= 7:
                        # PIN response
                        status = payload[1]
                        pin_bytes = payload[2:6]
                        try:
                            pin_str = pin_bytes.decode('ascii')
                        except Exception:
                            pin_str = pin_bytes.hex(' ')
                        print(f"  [PARSE] PIN response: status={status}, code={pin_str}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    action = sys.argv[1].lower()

    if action == 'query':
        pin = sys.argv[2] if len(sys.argv) > 2 else '0000'
        print(f"\n=== PIN QUERY (type=0, pin={pin}) ===")
        frame = build_pin_frame(0, pin)
        send_frame(frame)

    elif action == 'set':
        if len(sys.argv) < 3:
            print("Gebruik: pin_serial_test.py set <4-digit-pin>")
            sys.exit(1)
        pin = sys.argv[2]
        print(f"\n=== PIN SET (type=1, pin={pin}) ===")
        frame = build_pin_frame(1, pin)
        send_frame(frame)

    elif action == 'verify':
        if len(sys.argv) < 3:
            print("Gebruik: pin_serial_test.py verify <4-digit-pin>")
            sys.exit(1)
        pin = sys.argv[2]
        print(f"\n=== PIN VERIFY (type=2, pin={pin}) ===")
        frame = build_pin_frame(2, pin)
        send_frame(frame)

    elif action == 'type3':
        if len(sys.argv) < 3:
            print("Gebruik: pin_serial_test.py type3 <4-digit-pin>")
            sys.exit(1)
        pin = sys.argv[2]
        print(f"\n=== PIN TYPE 3 (type=3, pin={pin}) ===")
        frame = build_pin_frame(3, pin)
        send_frame(frame)

    elif action == 'raw':
        if len(sys.argv) < 4:
            print("Gebruik: pin_serial_test.py raw <type_byte> <4-digit-pin>")
            sys.exit(1)
        type_byte = int(sys.argv[2])
        pin = sys.argv[3]
        print(f"\n=== PIN RAW (type={type_byte}, pin={pin}) ===")
        frame = build_pin_frame(type_byte, pin)
        send_frame(frame)

    elif action == 'scan':
        # Test alle type waarden 0-15
        pin = sys.argv[2] if len(sys.argv) > 2 else '3053'
        print(f"\n=== SCAN ALLE TYPES (pin={pin}) ===")
        for t in range(16):
            print(f"\n--- Type {t} ---")
            frame = build_pin_frame(t, pin)
            send_frame(frame)
            time.sleep(1.0)

    elif action == 'hex':
        # Direct hex bytes sturen
        if len(sys.argv) < 3:
            print("Gebruik: pin_serial_test.py hex <hex_bytes>")
            print("  bijv: pin_serial_test.py hex 0202 07ff 08 23 02 33303533 00 XX 0303")
            sys.exit(1)
        hex_str = ''.join(sys.argv[2:]).replace(' ', '')
        data = bytes.fromhex(hex_str)
        print(f"\n=== RAW HEX ({len(data)} bytes): {data.hex(' ')} ===")
        port = find_serial_port()
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            os.write(fd, data)
            print(f"[SERIAL] {len(data)} bytes geschreven naar {port}")
            time.sleep(0.5)
            try:
                resp = os.read(fd, 512)
                if resp:
                    print(f"[SERIAL] Antwoord ({len(resp)} bytes): {resp.hex(' ')}")
                    parse_response(resp)
            except OSError:
                print("[SERIAL] Geen antwoord")
        finally:
            os.close(fd)

    else:
        print(f"Onbekende actie: {action}")
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
