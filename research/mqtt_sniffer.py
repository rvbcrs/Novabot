import socket

def decode_mqtt_length(data, offset):
    multiplier = 1
    value = 0
    while True:
        if offset >= len(data):
            return 0, offset
        encoded_byte = data[offset]
        offset += 1
        value += (encoded_byte & 127) * multiplier
        multiplier *= 128
        if (encoded_byte & 128) == 0:
            break
    return value, offset

def parse_connect(packet):
    """Parse MQTT CONNECT variable header + payload.
    Returns a dict with proto, level, clientId, username, password."""
    try:
        offset = 0
        # Protocol name (length-prefixed string)
        proto_len = (packet[offset] << 8) | packet[offset + 1]; offset += 2
        proto = packet[offset:offset + proto_len].decode('utf-8', errors='ignore'); offset += proto_len
        # Protocol level (3 = MQTT 3.1, 4 = MQTT 3.1.1, 5 = MQTT 5)
        level = packet[offset]; offset += 1
        # Connect flags
        flags = packet[offset]; offset += 1
        has_will     = bool(flags & 0x04)
        has_username = bool(flags & 0x80)
        has_password = bool(flags & 0x40)
        # Keep-alive (2 bytes, skip)
        offset += 2
        # Client ID
        cid_len = (packet[offset] << 8) | packet[offset + 1]; offset += 2
        client_id = packet[offset:offset + cid_len].decode('utf-8', errors='ignore'); offset += cid_len
        # Will topic + message (skip if present)
        if has_will:
            wt_len = (packet[offset] << 8) | packet[offset + 1]; offset += 2 + wt_len
            wm_len = (packet[offset] << 8) | packet[offset + 1]; offset += 2 + wm_len
        # Username
        username = None
        if has_username:
            ul = (packet[offset] << 8) | packet[offset + 1]; offset += 2
            username = packet[offset:offset + ul].decode('utf-8', errors='ignore'); offset += ul
        # Password (try UTF-8, fall back to hex for binary payloads)
        password = None
        if has_password:
            pl = (packet[offset] << 8) | packet[offset + 1]; offset += 2
            raw = packet[offset:offset + pl]
            try:
                password = raw.decode('utf-8')
            except Exception:
                password = raw.hex()
            offset += pl
        return {
            'proto': proto, 'level': level,
            'clientId': client_id, 'username': username, 'password': password,
        }
    except Exception as e:
        return {'error': str(e), 'raw_hex': packet.hex()}

def handle_client(conn, addr):
    while True:
        try:
            # We might receive fragments, but for simple telemetry this is usually enough
            data = conn.recv(4096)
            if not data: break

            offset = 0
            while offset < len(data):
                msg_type = data[offset] >> 4
                flags = data[offset] & 0x0F

                rem_len, new_offset = decode_mqtt_length(data, offset + 1)
                packet = data[new_offset:new_offset+rem_len]
                offset = new_offset + rem_len

                if msg_type == 1: # CONNECT
                    info = parse_connect(packet)
                    print(f"\n[{addr}] === CONNECT ===")
                    print(f"  clientId : {info.get('clientId')}")
                    print(f"  username : {info.get('username')}")
                    print(f"  password : {info.get('password')}")
                    print(f"  proto    : {info.get('proto')} v{info.get('level')}")
                    if 'error' in info:
                        print(f"  PARSE ERROR: {info['error']}  raw: {info.get('raw_hex')}")
                    print("="*40)
                    # Send CONNACK (Accepted, no session present)
                    conn.sendall(b'\x20\x02\x00\x00')
                elif msg_type == 8: # SUBSCRIBE
                    # Parse topic filters so we can see what the device listens to
                    sub_offset = 2  # skip packet identifier
                    topics = []
                    while sub_offset < len(packet):
                        tl = (packet[sub_offset] << 8) | packet[sub_offset + 1]; sub_offset += 2
                        topic = packet[sub_offset:sub_offset + tl].decode('utf-8', errors='ignore'); sub_offset += tl
                        qos_req = packet[sub_offset]; sub_offset += 1
                        topics.append(f"{topic} (QoS{qos_req})")
                    print(f"[{addr}] SUBSCRIBE: {', '.join(topics)}")
                    if len(packet) >= 2:
                        packet_id = packet[0:2]
                        # Send SUBACK (Success, QoS 0)
                        conn.sendall(b'\x90\x03' + packet_id + b'\x00')
                elif msg_type == 12: # PINGREQ
                    # Send PINGRESP
                    conn.sendall(b'\xd0\x00')
                elif msg_type == 3: # PUBLISH
                    print(f"\n[{addr}] === PUBLISH ===")
                    topic_len = (packet[0] << 8) | packet[1]
                    topic = packet[2:2+topic_len].decode('utf-8', errors='ignore')

                    payload_offset = 2 + topic_len
                    qos = (flags & 0x06) >> 1

                    if qos > 0:
                        packet_id = packet[payload_offset:payload_offset+2]
                        payload_offset += 2
                        if qos == 1:
                            conn.sendall(b'\x40\x02' + packet_id) # PUBACK

                    payload = packet[payload_offset:]

                    print(f"  topic  : {topic}")
                    print(f"  payload: {payload.decode('utf-8', errors='ignore')}")
                    print(f"  hex    : {payload.hex()}")
                    print("="*40)

                elif msg_type == 14: # DISCONNECT
                    print(f"[{addr}] DISCONNECT")
                    break
                else:
                    print(f"[{addr}] Unknown packet type: {msg_type}")
        except Exception as e:
            print(f"[{addr}] Error/Disconnect: {e}")
            break
    conn.close()

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('0.0.0.0', 1883))
sock.listen(5)
print("MQTT Sniffer listening on 0.0.0.0:1883 ...")

while True:
    try:
        conn, addr = sock.accept()
        print(f"\n[+] Connection from {addr}")
        handle_client(conn, addr)
    except KeyboardInterrupt:
        break
