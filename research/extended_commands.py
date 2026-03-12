#!/usr/bin/env python3
"""
Extended MQTT commands voor Novabot maaier.

Luistert op novabot/extended/<SN> en handelt commando's af die
NIET in mqtt_node zitten. Publiceert responses op novabot/extended_response/<SN>.

Commando's:
  {"set_robot_reboot": {}}              -> systeem reboot (3s delay)
  {"get_system_info": {}}               -> CPU temp, uptime, disk, memory, ROS nodes

Camera snapshots worden afgehandeld door camera_stream.py (/snapshot endpoint).

Draait als achtergrond-service naast mqtt_node.
Gebaseerd op led_bridge.py (MiniMQTT).
Vereist: Python 3.8+
"""

import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

# ── Configuratie ────────────────────────────────────────────────────────────
MQTT_RECONNECT_INTERVAL = 5
MQTT_KEEPALIVE = 60
LOG_PREFIX = "[EXT-CMD]"

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
    """Minimale MQTT 3.1.1 client — CONNECT, SUBSCRIBE, PUBLISH rx/tx."""

    def __init__(self, broker_host, broker_port, client_id, on_message=None):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.client_id = client_id
        self.on_message = on_message
        self._sock = None
        self._connected = False
        self._subscriptions = []
        self._pkt_id = 0

    def connect(self):
        """Verbind met MQTT broker."""
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(MQTT_KEEPALIVE + 10)
        self._sock.connect((self.broker_host, self.broker_port))

        # CONNECT packet
        client_id_bytes = self.client_id.encode('utf-8')
        var_header = (
            b'\x00\x04MQTT'
            b'\x04'
            b'\x02'
            + struct.pack('!H', MQTT_KEEPALIVE)
        )
        payload = struct.pack('!H', len(client_id_bytes)) + client_id_bytes
        packet = var_header + payload
        self._send_packet(0x10, packet)

        pkt_type, data = self._read_packet()
        if pkt_type != 0x20:
            raise ConnectionError(f"Verwacht CONNACK, kreeg 0x{pkt_type:02x}")
        if len(data) >= 2 and data[1] != 0:
            raise ConnectionError(f"CONNACK return code: {data[1]}")

        self._connected = True
        log(f"Verbonden met {self.broker_host}:{self.broker_port}")

        for topic in self._subscriptions:
            self._do_subscribe(topic)

    def subscribe(self, topic):
        if topic not in self._subscriptions:
            self._subscriptions.append(topic)
        if self._connected:
            self._do_subscribe(topic)

    def _do_subscribe(self, topic):
        self._pkt_id += 1
        topic_bytes = topic.encode('utf-8')
        payload = (
            struct.pack('!H', self._pkt_id)
            + struct.pack('!H', len(topic_bytes)) + topic_bytes
            + b'\x00'
        )
        self._send_packet(0x82, payload)
        log(f"Subscribed op: {topic}")

    def publish(self, topic, payload_str):
        """Publiceer een bericht naar een topic (QoS 0)."""
        if not self._connected:
            return
        topic_bytes = topic.encode('utf-8')
        payload_bytes = payload_str.encode('utf-8') if isinstance(payload_str, str) else payload_str
        data = struct.pack('!H', len(topic_bytes)) + topic_bytes + payload_bytes
        self._send_packet(0x30, data)

    def loop_forever(self):
        ping_interval = MQTT_KEEPALIVE * 0.8
        last_ping = time.time()

        while self._connected:
            try:
                if time.time() - last_ping > ping_interval:
                    self._send_packet(0xC0, b'')
                    last_ping = time.time()

                pkt_type, data = self._read_packet()
                if pkt_type is None:
                    continue

                if pkt_type == 0x30 or (pkt_type & 0xF0) == 0x30:
                    self._handle_publish(data)
                elif pkt_type == 0xD0:
                    pass
                elif pkt_type == 0x90:
                    pass

            except socket.timeout:
                try:
                    self._send_packet(0xC0, b'')
                    last_ping = time.time()
                except Exception:
                    break
            except (ConnectionError, OSError, struct.error):
                break

        self._connected = False

    def disconnect(self):
        self._connected = False
        if self._sock:
            try:
                self._send_packet(0xE0, b'')
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def _handle_publish(self, data):
        if len(data) < 2:
            return
        topic_len = struct.unpack('!H', data[0:2])[0]
        topic = data[2:2 + topic_len].decode('utf-8', errors='replace')
        payload = data[2 + topic_len:]
        if self.on_message:
            self.on_message(topic, payload)

    def _send_packet(self, pkt_type, payload):
        remaining = len(payload)
        header = bytes([pkt_type])
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
        header = self._recv_exact(1)
        if not header:
            return None, None
        pkt_type = header[0]

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

        payload = self._recv_exact(remaining) if remaining > 0 else b''
        return pkt_type, payload

    def _recv_exact(self, n):
        data = bytearray()
        while len(data) < n:
            chunk = self._sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("Verbinding verbroken")
            data.extend(chunk)
        return bytes(data)


# ── Serial PIN Verify (CMD 0x23 → STM32) ─────────────────────────────────

def crc8(data, poly=0x07, init=0x00):
    """CRC-8 checksum over data bytes (poly=0x07, init=0x00)."""
    crc = init
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ poly) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


def build_serial_frame(cmd, payload):
    """Build STM32 serial frame: [02 02] [07 FF] [LEN] [CMD PAYLOAD CRC8] [03 03]"""
    cmd_payload = bytes([cmd]) + payload
    length = len(cmd_payload) + 1  # +1 for CRC-8 byte
    cs = crc8(cmd_payload)
    return b"\x02\x02\x07\xff" + bytes([length]) + cmd_payload + bytes([cs, 0x03, 0x03])


def parse_serial_frames(buf):
    """Parse frames from serial buffer using LEN byte for correct framing."""
    frames = []
    i = 0
    while i < len(buf) - 6:
        if buf[i] == 0x02 and buf[i+1] == 0x02:
            if i + 5 > len(buf):
                break
            length = buf[i+4]
            total = 2 + 2 + 1 + length + 2  # STX + addr + len + data + ETX
            if total > 60 or i + total > len(buf):
                i += 1
                continue
            if buf[i+total-2] == 0x03 and buf[i+total-1] == 0x03:
                frame = buf[i:i+total]
                frames.append(frame)
                i += total
            else:
                i += 1
        else:
            i += 1
    return frames


def serial_pin_verify(pin_str):
    """Send PIN verify command (CMD 0x23 type=2) to STM32 via serial.

    Args:
        pin_str: 4-digit PIN as string (e.g. "3053")

    Returns:
        dict with result: 0=success, 1=wrong PIN, 2=serial error
    """
    import serial as pyserial

    if len(pin_str) != 4 or not pin_str.isdigit():
        return {"result": 1, "error": "PIN must be 4 digits"}

    # Convert PIN to ASCII bytes (e.g. "3053" → [0x33, 0x30, 0x35, 0x33])
    pin_bytes = pin_str.encode('ascii')

    # Kill chassis_control_node to get exclusive serial access
    subprocess.run(["killall", "chassis_control_node"], capture_output=True)
    time.sleep(0.5)

    try:
        ser = pyserial.Serial("/dev/ttyACM0", 115200, timeout=0.3)
        ser.reset_input_buffer()

        # Build CMD 0x23 type=2 verify frame
        payload = bytes([0x02]) + pin_bytes  # type=2 + 4 ASCII digits (NO pad byte)
        frame = build_serial_frame(0x23, payload)
        log("PIN verify TX: " + " ".join("{:02x}".format(b) for b in frame))

        ser.write(frame)

        # Read responses for 2 seconds
        buf = b""
        t0 = time.time()
        while time.time() - t0 < 2:
            chunk = ser.read(512)
            if chunk:
                buf += chunk

        ser.close()

        # Parse response frames, look for CMD 0x23
        for f in parse_serial_frames(buf):
            if len(f) > 5 and f[5] == 0x23:
                status = f[6] if len(f) > 6 else 0xFF
                log("PIN verify response status={}".format(status))
                if status == 2:
                    return {"result": 0, "status": "verified"}
                elif status == 3:
                    return {"result": 1, "status": "wrong_pin"}
                else:
                    return {"result": 1, "status": "unknown_status_{}".format(status)}

        log("PIN verify: no CMD 0x23 response received")
        return {"result": 2, "error": "no_response"}

    except Exception as e:
        log("PIN verify serial error: {}".format(e))
        return {"result": 2, "error": str(e)}


def handle_verify_pin(params, respond):
    """Verify PIN via STM32 serial (CMD 0x23 type=2)."""
    pin = str(params.get("code", "") or params.get("pin", ""))
    if not pin:
        respond("verify_pin_respond", {"result": 1, "error": "missing code/pin parameter"})
        return

    log("PIN verify aangevraagd voor PIN={}".format(pin))
    result = serial_pin_verify(pin)
    respond("verify_pin_respond", result)


def handle_query_pin(params, respond):
    """Query stored PIN from STM32 (CMD 0x23 type=0)."""
    import serial as pyserial

    subprocess.run(["killall", "chassis_control_node"], capture_output=True)
    time.sleep(0.5)

    try:
        ser = pyserial.Serial("/dev/ttyACM0", 115200, timeout=0.3)
        ser.reset_input_buffer()

        payload = bytes([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])  # type=0 query
        frame = build_serial_frame(0x23, payload)
        ser.write(frame)

        buf = b""
        t0 = time.time()
        while time.time() - t0 < 1:
            buf += ser.read(512)

        ser.close()

        for f in parse_serial_frames(buf):
            if len(f) > 5 and f[5] == 0x23:
                # Response: [02 02 00 01 LEN 23 status d0 d1 d2 d3 crc 03 03]
                if len(f) >= 11:
                    pin_bytes = f[7:11]
                    pin_str = pin_bytes.decode('ascii', errors='replace')
                    log("Stored PIN: {}".format(pin_str))
                    respond("query_pin_respond", {"result": 0, "pin": pin_str})
                    return

        respond("query_pin_respond", {"result": 2, "error": "no_response"})

    except Exception as e:
        respond("query_pin_respond", {"result": 2, "error": str(e)})


# ── Command Handlers ──────────────────────────────────────────────────────

def handle_reboot(params, respond):
    """Herstart de maaier na 3 seconden."""
    log("Reboot aangevraagd, herstart over 3s...")
    respond("set_robot_reboot_respond", {"result": 0})
    time.sleep(3)
    os.system('reboot')


def handle_system_info(params, respond):
    """Verzamel systeem diagnostiek."""
    info = {}

    # CPU temperatuur
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            info["cpu_temp_c"] = int(f.read().strip()) / 1000
    except Exception:
        info["cpu_temp_c"] = None

    # Uptime
    try:
        with open("/proc/uptime") as f:
            info["uptime_s"] = float(f.read().split()[0])
    except Exception:
        info["uptime_s"] = None

    # Memory
    try:
        with open("/proc/meminfo") as f:
            lines = f.readlines()
        mem = {}
        for line in lines:
            parts = line.split()
            if len(parts) >= 2:
                mem[parts[0].rstrip(':')] = int(parts[1])
        info["mem_total_mb"] = mem.get("MemTotal", 0) // 1024
        info["mem_free_mb"] = mem.get("MemAvailable", mem.get("MemFree", 0)) // 1024
    except Exception:
        pass

    # Disk
    try:
        st = os.statvfs("/userdata")
        info["disk_total_mb"] = (st.f_blocks * st.f_frsize) // (1024 * 1024)
        info["disk_free_mb"] = (st.f_bavail * st.f_frsize) // (1024 * 1024)
    except Exception:
        pass

    # ROS 2 nodes (via ros2 CLI — may not be available)
    try:
        result = subprocess.run(
            ['ros2', 'node', 'list'],
            capture_output=True, text=True, timeout=5,
            env={**os.environ, 'ROS_DOMAIN_ID': '0'}
        )
        if result.returncode == 0:
            info["ros_nodes"] = [n.strip() for n in result.stdout.strip().split('\n') if n.strip()]
    except Exception:
        info["ros_nodes"] = []

    log(f"System info: CPU {info.get('cpu_temp_c')}°C, mem {info.get('mem_free_mb')}MB free, disk {info.get('disk_free_mb')}MB free")
    respond("get_system_info_respond", info)


# ── Command dispatch ──────────────────────────────────────────────────────

COMMANDS = {
    "set_robot_reboot": handle_reboot,
    "get_system_info": handle_system_info,
    "verify_pin": handle_verify_pin,
    "query_pin": handle_query_pin,
}


# ── Hoofdprogramma ─────────────────────────────────────────────────────────
def main():
    log("=== Novabot Extended Commands ===")
    log(f"PID={os.getpid()}")

    # SIGTERM handler
    def sigterm_handler(signum, frame):
        log("SIGTERM ontvangen, afsluiten...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, sigterm_handler)

    # Lees configuratie
    sn, mqtt_addr, mqtt_port = read_config()
    sub_topic = f"novabot/extended/{sn}"
    resp_topic = f"novabot/extended_response/{sn}"
    log(f"SN={sn}, MQTT={mqtt_addr}:{mqtt_port}")
    log(f"Subscribe: {sub_topic}")
    log(f"Response:  {resp_topic}")

    # Reference to current MQTT client (for publishing responses)
    mqtt_ref = [None]

    def respond(cmd_name, data):
        """Publiceer een response naar de server."""
        if mqtt_ref[0]:
            payload = json.dumps({cmd_name: data})
            mqtt_ref[0].publish(resp_topic, payload)
            log(f"Response: {cmd_name}")

    # MQTT message handler
    def on_message(mqtt_topic, payload):
        try:
            data = json.loads(payload.decode('utf-8'))
            log(f"Commando ontvangen: {list(data.keys())}")

            for cmd_name, handler in COMMANDS.items():
                if cmd_name in data:
                    params = data[cmd_name] or {}
                    # Run in thread to avoid blocking MQTT loop
                    threading.Thread(
                        target=handler,
                        args=(params, respond),
                        daemon=True,
                        name=f"cmd-{cmd_name}"
                    ).start()
                    return

            log(f"Onbekend commando: {list(data.keys())}")

        except json.JSONDecodeError:
            log(f"Ongeldig JSON: {payload[:100]}")
        except Exception as e:
            log(f"Fout bij verwerken: {e}")

    # MQTT client met reconnect loop
    client_id = f"ext_cmd_{sn}"
    while True:
        try:
            mqtt = MiniMQTT(mqtt_addr, mqtt_port, client_id, on_message=on_message)
            mqtt.connect()
            mqtt.subscribe(sub_topic)
            mqtt_ref[0] = mqtt
            mqtt.loop_forever()
        except KeyboardInterrupt:
            log("Ctrl+C ontvangen")
            break
        except Exception as e:
            log(f"MQTT fout: {e}")

        mqtt_ref[0] = None
        log(f"Herverbinden over {MQTT_RECONNECT_INTERVAL}s...")
        time.sleep(MQTT_RECONNECT_INTERVAL)

    log("Gestopt")


if __name__ == '__main__':
    main()
