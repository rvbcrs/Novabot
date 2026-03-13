#!/usr/bin/env python3
"""Parse Apple PacketLogger .pklg file and extract BLE ATT/GATT data.

PKLG format (each record):
  4 bytes: payload length (big-endian)
  4 bytes: timestamp seconds (big-endian)
  4 bytes: timestamp microseconds (big-endian, but often subseconds)
  1 byte:  type (0x00=CMD, 0x01=EVT, 0x02=ACL_TX, 0x03=ACL_RX, 0xFB=info)
  N bytes: payload
"""

import struct
import sys
import json

def parse_pklg(path):
    with open(path, 'rb') as f:
        data = f.read()

    pos = 0
    records = []
    rec_num = 0

    while pos < len(data) - 13:
        # Read header
        pkt_len = struct.unpack('>I', data[pos:pos+4])[0]
        ts_sec = struct.unpack('>I', data[pos+4:pos+8])[0]
        ts_usec = struct.unpack('>I', data[pos+8:pos+12])[0]
        pkt_type = data[pos+12]

        payload = data[pos+13:pos+13+pkt_len-1] if pkt_len > 1 else b''

        records.append({
            'num': rec_num,
            'ts': f"{ts_sec}.{ts_usec:06d}",
            'type': pkt_type,
            'type_name': {0x00:'HCI_CMD', 0x01:'HCI_EVT', 0x02:'ACL_TX', 0x03:'ACL_RX', 0xFB:'INFO'}.get(pkt_type, f'0x{pkt_type:02x}'),
            'payload': payload,
            'len': len(payload)
        })

        pos += 4 + pkt_len + 8  # 4 (len field) + pkt_len + 8 (timestamp)
        rec_num += 1

        if rec_num > 50000:  # safety limit
            break

    return records


def find_json_in_payload(payload):
    """Try to find JSON strings in a binary payload."""
    results = []
    # Look for { in the payload
    for i in range(len(payload)):
        if payload[i] == 0x7B:  # '{'
            # Try to find matching }
            depth = 0
            for j in range(i, len(payload)):
                if payload[j] == 0x7B:
                    depth += 1
                elif payload[j] == 0x7D:
                    depth -= 1
                    if depth == 0:
                        try:
                            text = payload[i:j+1].decode('utf-8', errors='ignore')
                            json.loads(text)  # validate JSON
                            results.append(text)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            pass
                        break
    return results


def find_ascii_strings(payload, min_len=6):
    """Extract printable ASCII strings from payload."""
    result = []
    current = []
    for b in payload:
        if 0x20 <= b < 0x7F:
            current.append(chr(b))
        else:
            if len(current) >= min_len:
                result.append(''.join(current))
            current = []
    if len(current) >= min_len:
        result.append(''.join(current))
    return result


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/Users/rvbcrs/GitHub/Novabot/Novabot.pklg'
    records = parse_pklg(path)

    print(f"=== Totaal {len(records)} records ===\n")

    # Summary per type
    type_counts = {}
    for r in records:
        type_counts[r['type_name']] = type_counts.get(r['type_name'], 0) + 1
    print("Record types:")
    for t, c in sorted(type_counts.items()):
        print(f"  {t}: {c}")
    print()

    # Find all records with JSON payloads (BLE GATT data)
    print("=== JSON payloads gevonden (BLE GATT commando's) ===\n")
    json_found = 0
    for r in records:
        jsons = find_json_in_payload(r['payload'])
        if jsons:
            for j in jsons:
                json_found += 1
                print(f"Record #{r['num']} [{r['type_name']}] ts={r['ts']}:")
                try:
                    parsed = json.loads(j)
                    print(f"  {json.dumps(parsed, indent=2)}")
                except:
                    print(f"  {j}")
                print()

    if json_found == 0:
        print("Geen JSON payloads gevonden in BLE data.\n")

    # Find interesting ASCII strings (mqtt, wifi, lfi, charger, error, etc.)
    print("=== Interessante ASCII strings in payloads ===\n")
    keywords = ['mqtt', 'wifi', 'lfi', 'charger', 'error', 'set_', 'get_', 'respond',
                'ssid', 'bssid', 'host', 'port', 'addr', 'token', 'password', 'cmd',
                'signal', 'CHARGER', 'PILE', 'Novabot', 'ESP32', 'pin']
    shown = set()
    for r in records:
        strings = find_ascii_strings(r['payload'], min_len=4)
        for s in strings:
            if any(kw.lower() in s.lower() for kw in keywords):
                key = s[:100]
                if key not in shown:
                    shown.add(key)
                    print(f"  Record #{r['num']} [{r['type_name']}]: \"{s[:200]}\"")

    print()

    # Also dump all ACL (BLE data) records with readable content
    print("=== Alle ACL records met leesbare data (>= 8 bytes) ===\n")
    acl_count = 0
    for r in records:
        if r['type_name'] in ('ACL_TX', 'ACL_RX') and r['len'] >= 8:
            hex_str = r['payload'][:64].hex()
            ascii_str = ''.join(chr(b) if 0x20 <= b < 0x7F else '.' for b in r['payload'][:64])
            strings = find_ascii_strings(r['payload'], min_len=4)
            if strings:
                acl_count += 1
                print(f"  #{r['num']} [{r['type_name']}] len={r['len']}: {' '.join(strings[:5])}")
                if acl_count > 100:
                    print("  ... (afgekapt)")
                    break

    print(f"\nTotaal ACL records met strings: {acl_count}")


if __name__ == '__main__':
    main()