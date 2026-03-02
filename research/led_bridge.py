#!/usr/bin/env python3
"""
MQTT → ROS bridge voor directe LED/headlight controle op de Novabot maaier.

Subscribed op MQTT topic `novabot/cmd/<SN>` (onversleuteld) en publiceert
naar ROS 2 topic `/led_set` (std_msgs/msg/UInt8).

Commando's:
  {"led_set": 2}   -> Headlight AAN
  {"led_set": 0}   -> Headlight UIT
  {"led_set": N}    -> Willekeurige UInt8 waarde

Draait als achtergrond-service naast mqtt_node.
Vereist: ROS 2 Galactic, Python 3.8+
MQTT client: minimale ingebouwde implementatie (geen paho dependency)
"""

import json
import os
import signal
import socket
import struct
import sys
import threading
import time

# ── Configuratie ────────────────────────────────────────────────────────────
MQTT_RECONNECT_INTERVAL = 5   # seconden tussen reconnect pogingen
MQTT_KEEPALIVE = 60           # MQTT keepalive interval
LOG_PREFIX = "[LED-BRIDGE]"

def log(msg):
    print(f"{LOG_PREFIX} {msg}", flush=True)


# ── SN en broker adres uit json_config.json lezen ──────────────────────────
def read_config():
    """Lees SN en MQTT broker adres uit /userdata/lfi/json_config.json."""
    cfg_file = "/userdata/lfi/json_config.json"
    sn = None
    mqtt_addr = "127.0.0.1"
    mqtt_port = 1883

    try:
        with open(cfg_file) as f:
            cfg = json.load(f)
        sn = cfg.get("sn", {}).get("value", {}).get("code")
        mqtt_addr = cfg.get("mqtt", {}).get("value", {}).get("addr", mqtt_addr)
        mqtt_port = int(cfg.get("mqtt", {}).get("value", {}).get("port", mqtt_port))
    except Exception as e:
        log(f"Config lezen mislukt: {e}")

    if not sn or sn == "LFIN_ERROR_ERROR":
        log("WAARSCHUWING: Geen geldig SN gevonden, gebruik fallback")
        sn = "LFIN2230700238"

    return sn, mqtt_addr, mqtt_port


# ── Minimale MQTT 3.1.1 client (geen externe dependencies) ────────────────
class MiniMQTT:
    """Minimale MQTT 3.1.1 subscriber — alleen CONNECT, SUBSCRIBE, PUBLISH rx."""

    def __init__(self, broker_host, broker_port, client_id, on_message=None):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.client_id = client_id
        self.on_message = on_message
        self._sock = None
        self._connected = False
        self._subscriptions = []

    def connect(self):
        """Verbind met MQTT broker."""
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(MQTT_KEEPALIVE + 10)
        self._sock.connect((self.broker_host, self.broker_port))

        # CONNECT packet
        client_id_bytes = self.client_id.encode('utf-8')
        # Variable header: protocol name + level + flags + keepalive
        var_header = (
            b'\x00\x04MQTT'    # Protocol Name
            b'\x04'             # Protocol Level (3.1.1)
            b'\x02'             # Connect Flags (Clean Session)
            + struct.pack('!H', MQTT_KEEPALIVE)  # Keep Alive
        )
        payload = struct.pack('!H', len(client_id_bytes)) + client_id_bytes
        packet = var_header + payload
        self._send_packet(0x10, packet)  # CONNECT = 0x10

        # Wacht op CONNACK
        pkt_type, data = self._read_packet()
        if pkt_type != 0x20:  # CONNACK
            raise ConnectionError(f"Verwacht CONNACK, kreeg 0x{pkt_type:02x}")
        if len(data) >= 2 and data[1] != 0:
            raise ConnectionError(f"CONNACK return code: {data[1]}")

        self._connected = True
        log(f"Verbonden met {self.broker_host}:{self.broker_port}")

        # Hersubscribe
        for topic in self._subscriptions:
            self._do_subscribe(topic)

    def subscribe(self, topic):
        """Subscribe op een topic."""
        if topic not in self._subscriptions:
            self._subscriptions.append(topic)
        if self._connected:
            self._do_subscribe(topic)

    def _do_subscribe(self, topic):
        topic_bytes = topic.encode('utf-8')
        # Packet ID (1) + topic + QoS 0
        payload = (
            b'\x00\x01'  # Packet ID
            + struct.pack('!H', len(topic_bytes)) + topic_bytes
            + b'\x00'  # QoS 0
        )
        self._send_packet(0x82, payload)  # SUBSCRIBE = 0x82
        log(f"Subscribed op: {topic}")

    def loop_forever(self):
        """Hoofdloop — lees packets en verwerk ze."""
        ping_interval = MQTT_KEEPALIVE * 0.8
        last_ping = time.time()

        while self._connected:
            try:
                # Check of we PINGREQ moeten sturen
                if time.time() - last_ping > ping_interval:
                    self._send_packet(0xC0, b'')  # PINGREQ
                    last_ping = time.time()

                pkt_type, data = self._read_packet()
                if pkt_type is None:
                    continue

                if pkt_type == 0x30 or (pkt_type & 0xF0) == 0x30:  # PUBLISH
                    self._handle_publish(data)
                elif pkt_type == 0xD0:  # PINGRESP
                    pass
                elif pkt_type == 0x90:  # SUBACK
                    pass

            except socket.timeout:
                # Stuur PINGREQ bij timeout
                try:
                    self._send_packet(0xC0, b'')
                    last_ping = time.time()
                except Exception:
                    break
            except (ConnectionError, OSError, struct.error):
                break

        self._connected = False

    def disconnect(self):
        """Verbreek verbinding."""
        self._connected = False
        if self._sock:
            try:
                self._send_packet(0xE0, b'')  # DISCONNECT
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def _handle_publish(self, data):
        """Verwerk een PUBLISH packet."""
        if len(data) < 2:
            return
        topic_len = struct.unpack('!H', data[0:2])[0]
        topic = data[2:2 + topic_len].decode('utf-8', errors='replace')
        payload = data[2 + topic_len:]
        if self.on_message:
            self.on_message(topic, payload)

    def _send_packet(self, pkt_type, payload):
        """Stuur een MQTT packet."""
        remaining = len(payload)
        header = bytes([pkt_type])
        # Encode remaining length (MQTT variable-length encoding)
        encoded_len = bytearray()
        while True:
            byte = remaining % 128
            remaining //= 128
            if remaining > 0:
                byte |= 0x80
            encoded_len.append(byte)
            if remaining == 0:
                break
        self._sock.sendall(header + bytes(encoded_len) + payload)

    def _read_packet(self):
        """Lees een MQTT packet. Returns (type, payload) of (None, None)."""
        # Lees fixed header (1 byte type + variable length)
        header = self._recv_exact(1)
        if not header:
            return None, None
        pkt_type = header[0]

        # Decode remaining length
        multiplier = 1
        remaining = 0
        while True:
            b = self._recv_exact(1)
            if not b:
                return None, None
            remaining += (b[0] & 0x7F) * multiplier
            if (b[0] & 0x80) == 0:
                break
            multiplier *= 128

        # Lees payload
        payload = self._recv_exact(remaining) if remaining > 0 else b''
        return pkt_type, payload

    def _recv_exact(self, n):
        """Lees exact n bytes van de socket."""
        data = bytearray()
        while len(data) < n:
            chunk = self._sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("Verbinding verbroken")
            data.extend(chunk)
        return bytes(data)


# ── ROS 2 LED publisher ───────────────────────────────────────────────────
class LedPublisher:
    """Publiceert UInt8 naar /led_set via ROS 2."""

    def __init__(self):
        self._node = None
        self._pub = None

    def init(self):
        import rclpy
        from std_msgs.msg import UInt8
        if not rclpy.ok():
            rclpy.init()
        self._node = rclpy.create_node('led_bridge')
        self._pub = self._node.create_publisher(UInt8, '/led_set', 10)
        log("ROS 2 publisher /led_set aangemaakt")

    def publish(self, value):
        from std_msgs.msg import UInt8
        if self._pub is None:
            log("Publisher niet geinitialiseerd!")
            return
        msg = UInt8()
        msg.data = int(value) & 0xFF
        self._pub.publish(msg)
        log(f"LED → {value} (gepubliceerd naar /led_set)")

    def destroy(self):
        if self._node:
            self._node.destroy_node()
            self._node = None


# ── Hoofdprogramma ─────────────────────────────────────────────────────────
def main():
    log(f"=== Novabot LED Bridge ===")
    log(f"PID={os.getpid()}")

    # SIGTERM handler
    def sigterm_handler(signum, frame):
        log("SIGTERM ontvangen, afsluiten...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, sigterm_handler)

    # Lees configuratie
    sn, mqtt_addr, mqtt_port = read_config()
    topic = f"novabot/cmd/{sn}"
    log(f"SN={sn}, MQTT={mqtt_addr}:{mqtt_port}, Topic={topic}")

    # Init ROS 2 LED publisher
    led = LedPublisher()
    led.init()

    # MQTT message handler
    def on_message(mqtt_topic, payload):
        try:
            data = json.loads(payload.decode('utf-8'))
            if "led_set" in data:
                led.publish(data["led_set"])
        except json.JSONDecodeError:
            log(f"Ongeldig JSON: {payload[:100]}")
        except Exception as e:
            log(f"Fout bij verwerken: {e}")

    # MQTT client met reconnect loop
    client_id = f"led_bridge_{sn}"
    while True:
        try:
            mqtt = MiniMQTT(mqtt_addr, mqtt_port, client_id, on_message=on_message)
            mqtt.connect()
            mqtt.subscribe(topic)
            mqtt.loop_forever()
        except KeyboardInterrupt:
            log("Ctrl+C ontvangen")
            break
        except Exception as e:
            log(f"MQTT fout: {e}")

        log(f"Herverbinden over {MQTT_RECONNECT_INTERVAL}s...")
        time.sleep(MQTT_RECONNECT_INTERVAL)

    led.destroy()
    log("Gestopt")


if __name__ == '__main__':
    main()
