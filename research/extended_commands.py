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
import re
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
    """Lees SN en MQTT broker adres uit json_config.json, met DNS fallback."""
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

    # Try to resolve mqtt.lfibot.com — if it resolves to a different IP than the config,
    # use the resolved IP. This handles the ESP32 AP case where DNS resolves mqtt.lfibot.com
    # to 10.0.0.1 but json_config has the home server IP (e.g. 192.168.0.222).
    try:
        resolved = socket.gethostbyname("mqtt.lfibot.com")
        if resolved and resolved != mqtt_addr:
            # Check if resolved IP is reachable (quick connect test)
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2)
            try:
                s.connect((resolved, mqtt_port))
                s.close()
                log(f"DNS mqtt.lfibot.com → {resolved} (using instead of {mqtt_addr})")
                mqtt_addr = resolved
            except:
                s.close()
    except:
        pass

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


def serial_clear_error():
    """Send clear error command (CMD 0x23 type=3) to STM32 via serial.

    Clears ALL error state and switches display to home screen.
    Does NOT require PIN verification. Requires patched firmware v3.6.7+.

    Returns:
        dict with result: 0=success, 2=serial error
    """
    import serial as pyserial

    try:
        ser = pyserial.Serial("/dev/ttyACM0", 115200, timeout=0.3)
        ser.reset_input_buffer()

        # Build CMD 0x23 type=3 clear error frame (PIN digits ignored, use 0x30 padding)
        payload = bytes([0x03, 0x30, 0x30, 0x30, 0x30])  # type=3 + dummy digits
        frame = build_serial_frame(0x23, payload)
        log("Clear error TX: " + " ".join("{:02x}".format(b) for b in frame))

        ser.write(frame)

        # Read response
        buf = b""
        t0 = time.time()
        while time.time() - t0 < 0.5:
            chunk = ser.read(512)
            if chunk:
                buf += chunk

        ser.close()

        for f in parse_serial_frames(buf):
            if len(f) > 5 and f[5] == 0x23:
                status = f[6] if len(f) > 6 else 0xFF
                log("Clear error response status={}".format(status))
                return {"result": 0, "status": "cleared"}

        log("Clear error: no response (may still have worked)")
        return {"result": 0, "status": "no_response"}

    except Exception as e:
        log("Clear error serial error: {}".format(e))
        return {"result": 2, "error": str(e)}


def serial_pin_verify(pin_str):
    """Send PIN verify command (CMD 0x23 type=2) to STM32 via serial.

    After successful verify, sends type=3 clear error commands repeatedly
    to overcome tilt/lift detection re-triggering the error screen.

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
        verify_result = None
        for f in parse_serial_frames(buf):
            if len(f) > 5 and f[5] == 0x23:
                status = f[6] if len(f) > 6 else 0xFF
                log("PIN verify response status={}".format(status))
                if status == 0:
                    verify_result = {"result": 0, "status": "verified"}
                elif status == 2:
                    verify_result = {"result": 0, "status": "verified"}
                elif status == 3:
                    return {"result": 1, "status": "wrong_pin"}
                else:
                    return {"result": 1, "status": "unknown_status_{}".format(status)}

        if verify_result is None:
            log("PIN verify: no CMD 0x23 response received")
            return {"result": 2, "error": "no_response"}

        # PIN verified! Now repeatedly send type=3 clear error to force home screen.
        # Tilt/lift detection may re-trigger the error screen within ~100ms,
        # so we send multiple clears over a few seconds to overcome it.
        log("PIN verified, sending clear error commands...")
        for i in range(5):
            time.sleep(0.5)
            serial_clear_error()

        return verify_result

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

    # Firmware version — from novabot_api.yaml (novabot_version_code field)
    info["firmware_version"] = "unknown"
    try:
        yaml_path = "/root/novabot/install/novabot_api/share/novabot_api/config/novabot_api.yaml"
        with open(yaml_path) as f:
            for line in f:
                if "novabot_version_code" in line:
                    info["firmware_version"] = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass

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

    # ROS 2 nodes (via ros2 CLI — needs setup.bash sourced)
    try:
        result = ros2_run(['ros2', 'node', 'list'], timeout=5)
        if result.returncode == 0:
            info["ros_nodes"] = [n.strip() for n in result.stdout.strip().split('\n') if n.strip()]
    except Exception:
        info["ros_nodes"] = []

    log(f"System info: CPU {info.get('cpu_temp_c')}°C, mem {info.get('mem_free_mb')}MB free, disk {info.get('disk_free_mb')}MB free")
    respond("get_system_info_respond", info)


def handle_clear_error(params, respond):
    """Clear all error state on STM32 and switch to home screen (CMD 0x23 type=3).

    Requires patched firmware v3.6.7+. No PIN verification needed.
    Kills chassis_control_node for serial access.
    """
    subprocess.run(["killall", "chassis_control_node"], capture_output=True)
    time.sleep(0.5)

    log("Clear error aangevraagd")
    result = serial_clear_error()
    respond("clear_error_respond", result)


# ── ROS2 Helper ──────────────────────────────────────────────────────────

def ros2_run(args, timeout=10):
    """Run a ros2 command with proper environment (sources setup.bash).

    ros2 lives at /opt/ros/galactic/bin/ and needs LD_LIBRARY_PATH, PYTHONPATH
    etc. from setup.bash to find message types and service definitions.
    ROS_LOCALHOST_ONLY=1 and rmw_cyclonedds_cpp are required to match the
    running novabot ROS2 nodes.
    """
    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        + " ".join(args)
    )
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0",
        "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
    }
    return subprocess.run(
        ["bash", "-c", cmd],
        capture_output=True, text=True, timeout=timeout,
        env=env
    )


# State file to persist semantic_mode (no ROS2 param available for read-back)
SEMANTIC_MODE_FILE = "/tmp/semantic_mode"


# ── AI Perception Controls (ROS2 service calls) ─────────────────────────


def handle_set_perception_mode(params, respond):
    """Switch AI inference model on perception_node.

    Modes:
      1 = Segmentation (default) — lawn/obstacle/road classification
      2 = Detection — object detection (person, animal, shoes, rock, etc.)
      3 = Segmentation High — high sensitivity segmentation
      4 = Segmentation Low — low sensitivity segmentation
    """
    mode = int(params.get("mode", 1))
    if mode not in (1, 2, 3, 4):
        respond("set_perception_mode_respond", {"result": 1, "error": "mode must be 1-4"})
        return

    mode_names = {1: "segmentation", 2: "detection", 3: "seg_high", 4: "seg_low"}
    log(f"Set perception mode: {mode} ({mode_names.get(mode, '?')})")

    try:
        result = ros2_run(
            ["ros2", "service", "call", "/perception/set_infer_model",
             "general_msgs/srv/SetUint8", f"'{{value: {mode}}}'"],
            timeout=10
        )
        success = result.returncode == 0
        log(f"set_infer_model result: rc={result.returncode} stdout={result.stdout.strip()[:200]}")
        respond("set_perception_mode_respond", {
            "result": 0 if success else 1,
            "mode": mode,
            "mode_name": mode_names.get(mode, "unknown"),
        })
    except subprocess.TimeoutExpired:
        log("set_infer_model timeout")
        respond("set_perception_mode_respond", {"result": 1, "error": "timeout"})
    except Exception as e:
        log(f"set_infer_model error: {e}")
        respond("set_perception_mode_respond", {"result": 1, "error": str(e)})


def handle_set_semantic_mode(params, respond):
    """Set how the navigation costmap uses semantic segmentation data.

    Modes:
      0 = LAWN_COVER — stay on lawn only, non-lawn is obstacle
      1 = FREE_MOVE — free navigation, ignore semantic boundaries
      2 = BOUNDARY_FOLLOW — follow lawn boundary edges
      3 = IGNORE_SEMANTIC — completely ignore semantic classification
    """
    mode = int(params.get("mode", 0))
    if mode not in (0, 1, 2, 3):
        respond("set_semantic_mode_respond", {"result": 1, "error": "mode must be 0-3"})
        return

    mode_names = {0: "lawn_cover", 1: "free_move", 2: "boundary_follow", 3: "ignore_semantic"}
    log(f"Set semantic mode: {mode} ({mode_names.get(mode, '?')})")

    try:
        result = ros2_run(
            ["ros2", "service", "call", "/local_costmap/set_semantic_mode",
             "nav2_msgs/srv/SemanticMode", f"'{{semantic_mode: {mode}}}'"],
            timeout=10
        )
        success = result.returncode == 0
        log(f"set_semantic_mode result: rc={result.returncode} stdout={result.stdout.strip()[:200]}")
        if success:
            try:
                with open(SEMANTIC_MODE_FILE, "w") as f:
                    f.write(str(mode))
            except Exception:
                pass
        respond("set_semantic_mode_respond", {
            "result": 0 if success else 1,
            "mode": mode,
            "mode_name": mode_names.get(mode, "unknown"),
        })
    except subprocess.TimeoutExpired:
        log("set_semantic_mode timeout")
        respond("set_semantic_mode_respond", {"result": 1, "error": "timeout"})
    except Exception as e:
        log(f"set_semantic_mode error: {e}")
        respond("set_semantic_mode_respond", {"result": 1, "error": str(e)})


def handle_get_perception_status(params, respond):
    """Query perception system status: which nodes are running + current modes."""
    info = {}

    # Check running processes directly — much faster than ros2 node list
    # which requires slow DDS discovery
    try:
        result = subprocess.run(
            ["bash", "-c", "ps -eo args 2>/dev/null | grep -E 'perception_node|robot_decision|nav2_single_node' | grep -v grep"],
            capture_output=True, text=True, timeout=3
        )
        procs = result.stdout.strip()
        info["perception_running"] = "perception_node" in procs
        info["decision_running"] = "robot_decision" in procs
        info["navigation_running"] = "nav2_single_node" in procs
    except Exception as e:
        info["perception_running"] = False
        info["error"] = str(e)

    # Query current infer_mode from perception_node ROS2 parameter
    try:
        result = ros2_run(
            ["ros2", "param", "get", "/perception_node", "infer_mode"],
            timeout=10
        )
        # Output: "Integer value is: 1"
        if result.returncode == 0 and "value is:" in result.stdout:
            val = result.stdout.strip().split(":")[-1].strip()
            info["perception_mode"] = int(val)
    except Exception:
        pass

    # Read last-set semantic_mode from state file
    try:
        with open(SEMANTIC_MODE_FILE) as f:
            info["semantic_mode"] = int(f.read().strip())
    except Exception:
        info["semantic_mode"] = 0  # default: lawn_cover

    log(f"Perception status: running={info.get('perception_running')}, infer={info.get('perception_mode')}, semantic={info.get('semantic_mode')}")
    respond("get_perception_status_respond", info)


# ── MQTT/WiFi Config (bypasses mqtt_node whitelist) ──────────────────────

def handle_set_mqtt_config(params, respond):
    """Set custom MQTT broker address directly in json_config.json.

    Bypasses mqtt_node's *.lfibot.com whitelist by writing to the config
    file directly. After writing, restarts mqtt_node so it picks up the
    new address.

    Params:
      addr: MQTT broker hostname or IP (e.g. "192.168.0.177")
      port: MQTT port (default: 1883)

    Used by ESP32 OTA tool step 8 (reprovision) to set the home MQTT
    server address after flashing custom firmware.
    """
    addr = params.get("addr", "")
    port = int(params.get("port", 1883))

    if not addr:
        respond("set_mqtt_config_respond", {"result": 1, "error": "addr is required"})
        return

    cfg_file = "/userdata/lfi/json_config.json"
    log(f"Setting MQTT config: addr={addr} port={port}")

    try:
        # Read current config
        with open(cfg_file) as f:
            cfg = json.load(f)

        # Update mqtt section
        if "mqtt" not in cfg:
            cfg["mqtt"] = {"set": 1, "value": {}}
        elif not isinstance(cfg.get("mqtt", {}).get("value"), dict):
            cfg["mqtt"]["value"] = {}
        cfg["mqtt"]["value"]["addr"] = addr
        cfg["mqtt"]["value"]["port"] = port

        # Atomic write: tmp → rename
        tmp_file = cfg_file + ".tmp"
        with open(tmp_file, "w") as f:
            json.dump(cfg, f)

        # Validate written file
        with open(tmp_file) as f:
            check = json.load(f)
        if check.get("mqtt", {}).get("value", {}).get("addr") != addr:
            raise ValueError("Verification failed")

        os.rename(tmp_file, cfg_file)
        log(f"json_config.json updated: mqtt.addr={addr} port={port}")

        # Restart mqtt_node so it picks up the new address
        # daemon_node will auto-restart it
        subprocess.run(["killall", "mqtt_node"], capture_output=True)
        log("mqtt_node killed (daemon_node will restart it)")

        respond("set_mqtt_config_respond", {"result": 0, "addr": addr, "port": port})

    except Exception as e:
        log(f"set_mqtt_config error: {e}")
        respond("set_mqtt_config_respond", {"result": 1, "error": str(e)})


def handle_set_wifi_config(params, respond):
    """Set WiFi credentials directly in json_config.json.

    Params:
      ssid: WiFi network name
      password: WiFi password

    After writing, restarts mqtt_node which triggers WiFi reconnect.
    """
    ssid = params.get("ssid", "")
    password = params.get("password", "")

    if not ssid:
        respond("set_wifi_config_respond", {"result": 1, "error": "ssid is required"})
        return

    cfg_file = "/userdata/lfi/json_config.json"
    log(f"Setting WiFi config: ssid={ssid}")

    try:
        with open(cfg_file) as f:
            cfg = json.load(f)

        # Update wifi section — mqtt_node stores wifi config FLAT in value
        # (not nested under "ap" like BLE set_wifi_info sends it)
        if "wifi" not in cfg:
            cfg["wifi"] = {"set": 1, "value": {}}
        elif not isinstance(cfg.get("wifi", {}).get("value"), dict):
            cfg["wifi"]["value"] = {}
        cfg["wifi"]["value"]["ssid"] = ssid
        cfg["wifi"]["value"]["passwd"] = password
        cfg["wifi"]["value"]["encrypt"] = 0

        # Atomic write
        tmp_file = cfg_file + ".tmp"
        with open(tmp_file, "w") as f:
            json.dump(cfg, f)
        os.rename(tmp_file, cfg_file)
        log(f"json_config.json updated: wifi.ssid={ssid}")

        # Also configure WiFi via nmcli — mqtt_node uses NetworkManager, not wpa_supplicant directly.
        # Writing json_config.json alone is NOT enough; nmcli must be called to actually switch networks.
        log(f"Configuring WiFi via nmcli: {ssid}")
        subprocess.run(["nmcli", "connection", "delete", ssid], capture_output=True)  # Remove old if exists
        result = subprocess.run(
            ["nmcli", "device", "wifi", "connect", ssid, "password", password],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            log(f"nmcli WiFi connected: {ssid}")
            # Restart mqtt_node so it picks up the new MQTT address from json_config.json
            # (MQTT config was likely changed by set_mqtt_config just before this call)
            time.sleep(2)  # Wait for WiFi to stabilize
            subprocess.run(["killall", "mqtt_node"], capture_output=True)
            log("mqtt_node restarted (daemon_node will respawn with new config)")
        else:
            log(f"nmcli WiFi failed: {result.stderr.strip()}")

        respond("set_wifi_config_respond", {"result": 0, "ssid": ssid})

    except Exception as e:
        log(f"set_wifi_config error: {e}")
        respond("set_wifi_config_respond", {"result": 1, "error": str(e)})


def handle_clean_ota_cache(params, respond):
    """Clean OTA cache and restart ota_client.

    Removes downloaded firmware fragments and resets upgrade flag.
    Required after any failed OTA attempt — without this, ota_client
    retries the cached (broken) download forever.
    """
    log("Cleaning OTA cache...")
    try:
        subprocess.run(["rm", "-rf", "/userdata/ota/upgrade_pkg/"], capture_output=True)
        os.makedirs("/userdata/ota/upgrade_pkg", exist_ok=True)
        with open("/userdata/ota/upgrade.txt", "w") as f:
            f.write("0")

        log("OTA cache cleaned, rebooting in 3s...")
        respond("clean_ota_cache_respond", {"result": 0})
        time.sleep(3)
        os.system('reboot')
    except Exception as e:
        log(f"clean_ota_cache error: {e}")
        respond("clean_ota_cache_respond", {"result": 1, "error": str(e)})


def _clear_costmaps():
    """Clear both nav2 costmaps to drop stale obstacle observations.

    When the mower drove into shrubs, those shrubs land in the local +
    global costmap as persistent obstacles. Any subsequent boundary /
    coverage attempt then finds them in the 0.5m look-ahead window and
    aborts with "Controller patience exceeded". The clear_entirely_* nav2
    services wipe the layers so the next planner run starts with a fresh
    map. Fire-and-forget — non-blocking.
    """
    try:
        cmd = (
            "source /opt/ros/galactic/setup.bash && "
            "source /root/novabot/install/setup.bash 2>/dev/null && "
            "for svc in /global_costmap/clear_entirely_global_costmap /local_costmap/clear_entirely_local_costmap; do "
            "  nohup timeout 5 ros2 service call \"$svc\" nav2_msgs/srv/ClearEntireCostmap '{}' "
            "  >> /tmp/clear_costmap.log 2>&1 & "
            "done"
        )
        env = {
            **os.environ,
            "ROS_DOMAIN_ID": "0",
            "ROS_LOCALHOST_ONLY": "1",
            "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
            "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
        }
        subprocess.Popen(["bash", "-c", cmd], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _kill_ros2_action_clients():
    """Kill any lingering `ros2 action send_goal` client processes.

    When the action CLI is killed externally (timeout, SIGKILL) the
    server-side goal handle can linger in ACCEPTED/EXECUTING state —
    the boundary-follow planner keeps publishing nav2 paths, and a
    physical bump / manual drive-off can wake the planner up and cause
    the mower to drive autonomously. Killing the CLI process alone is
    not enough; we also need to call the service-level stop (below).
    """
    try:
        subprocess.run(
            ["bash", "-c", "pkill -f 'ros2 action send_goal' 2>/dev/null; pkill -f 'ros2 action.*boundary_follow' 2>/dev/null"],
            capture_output=True, timeout=5,
        )
    except Exception:
        pass


def _call_cover_task_stop():
    """Fire cover_task_stop (std_srvs/SetBool) and detach.

    The service call can take ~3-6s to complete (iceoryx warmup + service
    discovery). We don't wait — the important thing is that the call is
    dispatched so the coverage_planner_server drops its active goal. We
    return immediately so the MQTT response to the client isn't blocked.
    """
    try:
        cmd = (
            "source /opt/ros/galactic/setup.bash && "
            "source /root/novabot/install/setup.bash 2>/dev/null && "
            "nohup timeout 10 ros2 service call /coverage_planner_server/cover_task_stop "
            "std_srvs/srv/SetBool '{data: true}' "
            ">> /tmp/cover_task_stop.log 2>&1 &"
        )
        env = {
            **os.environ,
            "ROS_DOMAIN_ID": "0",
            "ROS_LOCALHOST_ONLY": "1",
            "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
            "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
        }
        subprocess.Popen(["bash", "-c", cmd], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "dispatched"
    except Exception as e:
        return f"err: {e}"


def handle_stop_boundary_follow(params, respond):
    """Cancel an in-flight boundary-follow task.

    Two-step cleanup:
      1. Kill any lingering `ros2 action send_goal` CLI processes so no
         retry-loop keeps refreshing the goal.
      2. Call `/coverage_planner_server/cover_task_stop` service so the
         server drops its internal goal handle.

    Safe to call repeatedly — both operations are idempotent.
    """
    _kill_ros2_action_clients()
    svc_out = _call_cover_task_stop()
    log(f"stop_boundary_follow: {svc_out[:200]}")
    respond("stop_boundary_follow_respond", {"result": 0, "svc": svc_out[:200]})


def handle_start_boundary_follow(params, respond):
    """Start real edge-cutting via the `/boundary_follow` ROS2 action.

    The stock `api_start_patrol` MQTT handler is a stub — it only returns
    `result:0` and never triggers any action. The actual edge-cutting path
    goes through the `coverage_planner/action/BoundaryFollow` action which
    lives on `/boundary_follow` (verified live on LFIN1231000211 via
    `ros2 action list`). Calling it from here bypasses the broken stock
    handler.

    Goal schema (coverage_planner/action/BoundaryFollow):
      follow_mode: 0=ASSIST_MAPPING, 1=AUTO_MAPPING, 2=BOUNDARY_CUTTING.
      enable_coverage: bool — true = blade on while following.
      more_close_to_boundary: bool.
      close_loop_stop: bool — stop when the loop closes (full round trip).
      start_follow_wait: bool — wait before starting.
      debug_mode: bool.
      inflation_radius: float32 — extra stand-off.
      blade_height: uint8 — chassis inverted index (9 - userCm).

    Params (optional, with safe defaults for edge-cutting):
      follow_mode:          default 2 (BOUNDARY_CUTTING_MODE).
      enable_coverage:      default True.
      more_close_to_boundary: default False.
      close_loop_stop:      default True.
      start_follow_wait:    default False.
      debug_mode:           default False.
      inflation_radius:     default 0.0.
      blade_height:         default 5 (≈ 40 mm via chassis index).
      max_time:             default 60.0 (seconds), run in background.
    """
    # Defensive: cancel any pre-existing boundary-follow goal before starting
    # a new one. A lingering server-side goal handle can cause the mower to
    # auto-drive when manually moved — live-observed 2026-04-23 on
    # LFIN1231000211 (test goal from 30 min earlier kept recomputing paths).
    _kill_ros2_action_clients()
    _call_cover_task_stop()

    # Clear costmaps so stale obstacle observations (e.g. the shrubs we drove
    # into earlier) don't block the boundary planner. Verified live: without
    # clearing, nav2 reported "Obstacle layer in front 0.5m position cost:
    # 255 → Controller patience exceeded → ABORTED" within seconds of the
    # action start.
    _clear_costmaps()

    try:
        follow_mode = int(params.get("follow_mode", 2))
        enable_coverage = bool(params.get("enable_coverage", True))
        more_close = bool(params.get("more_close_to_boundary", False))
        close_loop = bool(params.get("close_loop_stop", True))
        wait_start = bool(params.get("start_follow_wait", False))
        debug = bool(params.get("debug_mode", False))
        inflation = float(params.get("inflation_radius", 0.0))
        blade = int(params.get("blade_height", 5))
        max_time = float(params.get("max_time", 60.0))
    except (TypeError, ValueError) as e:
        respond("start_boundary_follow_respond", {"result": 1, "error": f"param type error: {e}"})
        return

    # Goal YAML — ros2 action CLI accepts single-quoted YAML on the cmdline.
    # Braces have to stay inside the quotes so bash brace-expansion leaves
    # them alone (same trick as set_lora_info).
    goal_yaml = (
        "'{"
        f"follow_mode: {follow_mode}, "
        f"enable_coverage: {str(enable_coverage).lower()}, "
        f"more_close_to_boundary: {str(more_close).lower()}, "
        f"close_loop_stop: {str(close_loop).lower()}, "
        f"start_follow_wait: {str(wait_start).lower()}, "
        f"debug_mode: {str(debug).lower()}, "
        f"inflation_radius: {inflation}, "
        f"blade_height: {blade}"
        "}'"
    )

    try:
        # Fire-and-forget: kick off the action in the background so we can
        # respond to MQTT without blocking for the full mowing run.
        cmd = (
            "source /opt/ros/galactic/setup.bash && "
            "source /root/novabot/install/setup.bash 2>/dev/null && "
            "nohup timeout " + str(int(max_time)) + " "
            "ros2 action send_goal /boundary_follow "
            "coverage_planner/action/BoundaryFollow "
            + goal_yaml +
            " >> /tmp/boundary_follow.log 2>&1 &"
        )
        # Match the shared-memory DDS config used by the running nodes
        # (mqtt_node, coverage_planner_server, nav2 etc). Without the
        # CYCLONEDDS_URI pointing at shm_cyclonedds.xml the CLI client
        # runs on a different DDS transport and can't discover the
        # /boundary_follow action server.
        env = {
            **os.environ,
            "ROS_DOMAIN_ID": "0",
            "ROS_LOCALHOST_ONLY": "1",
            "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
            "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
        }
        subprocess.Popen(["bash", "-c", cmd], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        log(f"start_boundary_follow dispatched: mode={follow_mode} coverage={enable_coverage} blade={blade}")
        respond("start_boundary_follow_respond", {
            "result": 0,
            "follow_mode": follow_mode,
            "enable_coverage": enable_coverage,
            "blade_height": blade,
        })
    except Exception as e:
        log(f"start_boundary_follow error: {e}")
        respond("start_boundary_follow_respond", {"result": 1, "error": str(e)})


def handle_start_edge_cut(params, respond):
    """Start real edge-cutting via the stock orchestrator.

    Calls `/robot_decision/start_cov_task` (decision_msgs/srv/StartCoverageTask)
    with `cov_mode: 2` (BOUNDARY_COV). robot_decision then:
      1. Loads the work map via `/decision_assistant/load_map "/map.yaml"`.
      2. Validates the robot is inside the polygon ("working zone").
      3. Dispatches the `coverage_planner/action/BoundaryFollow` action with
         a fully populated coverage_planner context.

    This replaces the earlier direct `/boundary_follow` dispatch which failed
    with NO_VALID_BOUNDARY because the coverage_planner_server had no map
    loaded.

    Params (all optional):
      mapName:      default "map0_work"
      bladeHeight:  wire value 0..7 (userCm − 2), default 3 (= 50 mm)
      light:        0..255, default 0

    Response:
      success → {result: 0, cov_mode: 2, map: <name>, blade: <h>}
      failure → {result: 1, error: <class>, detail: <stdout tail>}

    The service call is blocking with a 15 s timeout so the MQTT reply
    reflects service-level success/failure. The BOUNDARY_COVERING loop
    runs inside robot_decision after the service returns, independent of
    the MQTT round-trip.
    """
    # Defensive prelude — same cleanup the direct-action path used.
    _kill_ros2_action_clients()
    _call_cover_task_stop()
    _clear_costmaps()

    try:
        map_name = str((params or {}).get("mapName", "map0_work"))
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", map_name):
            respond("start_edge_cut_respond", {"result": 1, "error": "invalid_map_name"})
            return
        blade = int((params or {}).get("bladeHeight", 3))
        if blade < 0: blade = 0
        if blade > 7: blade = 7
        light = int((params or {}).get("light", 0))
        if light < 0: light = 0
        if light > 255: light = 255
    except (TypeError, ValueError) as e:
        respond("start_edge_cut_respond", {"result": 1, "error": f"param type error: {e}"})
        return

    # YAML goal for decision_msgs/srv/StartCoverageTask. Bash single-quoting
    # keeps the braces and array literals intact on the ros2 CLI.
    req_yaml = (
        "'{"
        "cov_mode: 2, "
        "request_type: 11, "
        f"map_names: [\"{map_name}\"], "
        f"blade_heights: [{blade}], "
        f"light: {light}, "
        "specify_perception_level: false, "
        "perception_level: 0, "
        "blade_info_level: 0, "
        "night_light: false, "
        "enable_loc_weak_mapping: false, "
        "enable_loc_weak_working: false, "
        "specify_direction: false, "
        "cov_direction: 0, "
        "map_ids: 0"
        "}'"
    )

    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        "timeout 15 ros2 service call /robot_decision/start_cov_task "
        "decision_msgs/srv/StartCoverageTask " + req_yaml +
        " 2>&1 | tee -a /tmp/edge_cut.log"
    )

    # Match the DDS transport used by the running ROS nodes — without the
    # shared-memory CYCLONEDDS_URI the CLI client can't discover
    # /robot_decision/start_cov_task.
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0",
        "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }

    try:
        proc = subprocess.run(
            ["bash", "-c", cmd], env=env,
            capture_output=True, text=True, timeout=20,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        log("start_edge_cut: ros2 service call timed out")
        respond("start_edge_cut_respond", {"result": 1, "error": "service_timeout"})
        return
    except Exception as e:
        log(f"start_edge_cut subprocess error: {e}")
        respond("start_edge_cut_respond", {"result": 1, "error": f"subprocess: {e}"})
        return

    tail = out[-400:] if len(out) > 400 else out
    log(f"start_edge_cut out: {tail}")

    # ros2 service call prints either "response:\n  ... result=True" on
    # success or "result=False" on service-level failure. We classify the
    # common failure modes so the app can show a useful toast.
    lowered = out.lower()
    if "result=true" in lowered:
        respond("start_edge_cut_respond", {
            "result": 0,
            "cov_mode": 2,
            "map": map_name,
            "blade": blade,
        })
    elif "result=false" in lowered:
        if "working zone" in lowered or "not in mapping" in lowered:
            err = "robot_outside_zone"
        elif "load map" in lowered or "error_load_map" in lowered:
            err = "map_load_failed"
        else:
            err = "service_rejected"
        respond("start_edge_cut_respond", {"result": 1, "error": err, "detail": tail})
    else:
        # e.g. "Waiting for service..." (service not found)
        respond("start_edge_cut_respond", {"result": 1, "error": "no_service_response", "detail": tail})


def handle_recalibrate_charging_pose(params, respond):
    """Overwrite map_info.json charging_pose with a caller-supplied (x, y, theta).

    Used after a map-frame drift event (e.g. heading-discovery happened at a
    different starting point than the original mapping session). The server
    reads the mower's own `report_state_robot` x/y/theta while the mower is
    verified on its dock and passes them in as params. The handler updates
    `map_info.json` in BOTH `csv_file/` and `x3_csv_file/` so the firmware's
    two read paths stay consistent.

    Required params:
      x:     float — charger x in current map frame (meters)
      y:     float — charger y in current map frame (meters)
      theta: float — charger orientation in current map frame (radians)

    Optional:
      home: str — home dir under /userdata/lfi/maps. Default "home0".
    """
    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    try:
        x = float(params["x"])
        y = float(params["y"])
        theta = float(params["theta"])
    except (KeyError, TypeError, ValueError) as e:
        respond("recalibrate_charging_pose_respond", {
            "result": 1,
            "error": f"require numeric x/y/theta: {e}",
        })
        return

    # Sanity bounds — map frame is meters, typical ~100m box.
    if not all(-500 <= v <= 500 for v in (x, y)) or not -10 <= theta <= 10:
        respond("recalibrate_charging_pose_respond", {
            "result": 1,
            "error": f"pose out of bounds: x={x} y={y} theta={theta}",
        })
        return

    base = f"/userdata/lfi/maps/{home}"
    targets = [f"{base}/csv_file/map_info.json", f"{base}/x3_csv_file/map_info.json"]

    updated = {}
    try:
        for path in targets:
            if not os.path.exists(path):
                # One of the dirs may be missing — skip quietly, continue.
                continue
            with open(path) as f:
                info = json.load(f)
            info["charging_pose"] = {
                "x": x,
                "y": y,
                "orientation": theta,
            }
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(info, f, indent=3)
                f.write("\n")
            os.replace(tmp, path)
            updated[path] = info["charging_pose"]

        if not updated:
            respond("recalibrate_charging_pose_respond", {
                "result": 1,
                "error": f"no map_info.json found under {base}",
            })
            return

        log(f"recalibrate_charging_pose: wrote x={x} y={y} theta={theta} to {list(updated.keys())}")
        respond("recalibrate_charging_pose_respond", {
            "result": 0,
            "updated": updated,
        })
    except Exception as e:
        log(f"recalibrate_charging_pose error: {e}")
        respond("recalibrate_charging_pose_respond", {"result": 1, "error": str(e)})


def handle_finalize_map_files(params, respond):
    """Normalise home0 map filenames after a ZIP-restore or save_map type:1.

    robot_decision (stock C++ binary) hardcodes the path
    `/userdata/lfi/maps/home0/map0.yaml` in its coverage pre-check and
    raises Error_code: 118 when that exact filename is missing — even if
    the firmware's own save_map handler just wrote `map.yaml` / `map.pgm`
    / `map.png`. Running this handler copies the generic names onto the
    indexed variant so coverage finds its input.

    Idempotent: if the generic files already exist we copy them every
    call; if they don't exist we report which ones are missing so the
    caller knows whether save_map type:1 still needs to run first.

    Params (optional):
      index: int  — map index, default 0. Generates map<index>.yaml etc.
      home:  str  — home dir under /userdata/lfi/maps. Default "home0".
    """
    import shutil
    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    idx = params.get("index", 0) if isinstance(params, dict) else 0
    base = f"/userdata/lfi/maps/{home}"

    sources = {"yaml": f"{base}/map.yaml", "pgm": f"{base}/map.pgm", "png": f"{base}/map.png"}
    targets = {
        "yaml": f"{base}/map{idx}.yaml",
        "pgm": f"{base}/map{idx}.pgm",
        "png": f"{base}/map{idx}.png",
    }

    missing = [k for k, p in sources.items() if not os.path.exists(p)]
    if missing:
        respond("finalize_map_files_respond", {
            "result": 1,
            "error": f"generic source files missing: {missing}. Run save_map type:1 first.",
        })
        return

    copied = {}
    try:
        for key, src in sources.items():
            dst = targets[key]
            shutil.copyfile(src, dst)
            copied[key] = dst
        log(f"finalize_map_files: copied {list(copied.values())}")
        respond("finalize_map_files_respond", {"result": 0, "copied": copied})
    except Exception as e:
        log(f"finalize_map_files error: {e}")
        respond("finalize_map_files_respond", {"result": 1, "error": str(e)})


def handle_get_lora_info(params, respond):
    """Read LoRa config from json_config.json."""
    cfg_file = "/userdata/lfi/json_config.json"
    try:
        with open(cfg_file) as f:
            cfg = json.load(f)
        lora = cfg.get("lora", {}).get("value", {})
        respond("get_lora_info_respond", {
            "result": 0,
            "addr": lora.get("addr", None),
            "channel": lora.get("channel", None),
            "hc": lora.get("hc", 20),
            "lc": lora.get("lc", 14),
        })
    except Exception as e:
        log(f"get_lora_info error: {e}")
        respond("get_lora_info_respond", {"result": 1, "error": str(e)})


def handle_set_lora_info(params, respond):
    """Write LoRa config to json_config.json, push to chassis radio, restart mqtt_node.

    Writing the json file alone is not enough: the actual LoRa radio lives on
    the chassis MCU and is only updated via the /chassis_lora_set ROS action.
    Without that call the file reports the new config but the radio keeps
    hopping on the old addr/channel, causing Error 8 (LoRa comm fail) and
    Error 132 (data transmission loss). Observed live 2026-04-23 after an
    in-app set_lora_info: file said 719/14, chassis stayed on old pair until
    an explicit ros2 action send_goal pushed it.
    """
    cfg_file = "/userdata/lfi/json_config.json"
    addr = params.get("addr")
    channel = params.get("channel")
    hc = params.get("hc", 20)
    lc = params.get("lc", 14)

    if addr is None or channel is None:
        respond("set_lora_info_respond", {"result": 1, "error": "addr and channel are required"})
        return

    try:
        with open(cfg_file) as f:
            cfg = json.load(f)

        cfg.setdefault("lora", {}).setdefault("value", {})
        cfg["lora"]["value"]["addr"] = int(addr)
        cfg["lora"]["value"]["channel"] = int(channel)
        cfg["lora"]["value"]["hc"] = int(hc)
        cfg["lora"]["value"]["lc"] = int(lc)

        with open(cfg_file, "w") as f:
            json.dump(cfg, f, indent=2)

        log(f"LoRa config set: addr={addr} channel={channel} hc={hc} lc={lc}")

        # Push to chassis radio so the new config goes live immediately.
        # The YAML goal is wrapped in single quotes inside the bash -c string
        # so the braces don't trigger shell brace-expansion.
        chassis_err = None
        try:
            goal_yaml = f"'{{channel: {int(channel)}, addr: {int(addr)}}}'"
            result = ros2_run([
                'ros2', 'action', 'send_goal', '/chassis_lora_set',
                'novabot_msgs/action/ChassisLoraSet', goal_yaml,
            ], timeout=15)
            if result.returncode != 0 or 'SUCCEEDED' not in (result.stdout or ''):
                chassis_err = f"chassis push failed (rc={result.returncode}): {result.stdout or result.stderr}"
                log(chassis_err)
            else:
                log(f"Chassis LoRa updated: addr={addr} channel={channel}")
        except Exception as e:
            chassis_err = f"chassis push exception: {e}"
            log(chassis_err)

        # Restart mqtt_node so it picks up the new LoRa config on reconnect
        # (daemon_node will auto-restart it).
        os.system("killall mqtt_node 2>/dev/null")

        respond("set_lora_info_respond", {
            "result": 0,
            "addr": int(addr),
            "channel": int(channel),
            "chassis_error": chassis_err,
        })
    except Exception as e:
        log(f"set_lora_info error: {e}")
        respond("set_lora_info_respond", {"result": 1, "error": str(e)})


# ── Preview / plan path readers (workaround voor stock mqtt_node buffer overflow) ──
# Stock mqtt_node crasht bij get_preview_cover_path / get_map_plan_path wanneer
# de betreffende JSON file groter dan ~8KB is (bewezen via glibc FORTIFY abort).
# Deze handlers lezen de file direct en sturen de inhoud via extended channel.

PLANNED_PATH_DIR = "/userdata/lfi/maps/home0/planned_path"


def handle_get_preview_cover_path(params, respond):
    path = f"{PLANNED_PATH_DIR}/preview_planned_path.json"
    try:
        size = os.path.getsize(path)
        with open(path, "r") as f:
            content = json.load(f)
        log(f"get_preview_cover_path: {size}B gelezen")
        respond("get_preview_cover_path_respond", {"result": 0, "value": content})
    except FileNotFoundError:
        log(f"get_preview_cover_path: {path} niet gevonden")
        respond("get_preview_cover_path_respond", {"result": 0, "value": None})
    except Exception as e:
        log(f"get_preview_cover_path: FOUT {e}")
        respond("get_preview_cover_path_respond", {"result": 0, "error": str(e)})


def handle_get_map_plan_path(params, respond):
    path = f"{PLANNED_PATH_DIR}/planned_path.json"
    try:
        size = os.path.getsize(path)
        with open(path, "r") as f:
            content = json.load(f)
        log(f"get_map_plan_path: {size}B gelezen")
        respond("get_map_plan_path_respond", {"result": 0, "value": content})
    except FileNotFoundError:
        log(f"get_map_plan_path: {path} niet gevonden")
        respond("get_map_plan_path_respond", {"result": 0, "value": None})
    except Exception as e:
        log(f"get_map_plan_path: FOUT {e}")
        respond("get_map_plan_path_respond", {"result": 0, "error": str(e)})


# ── Debug helpers (remote diagnosis zonder SSH) ───────────────────────────

def _latest_log_file(pattern):
    """Zoek het meest recente log-bestand dat matcht met <pattern>."""
    import glob
    files = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p), reverse=True)
    return files[0] if files else None


def handle_get_mqtt_log(params, respond):
    """
    Fetch de laatste N regels van de mqtt_error log op de mower.

    params:
      lines: int (default 100, max 2000)
      grep: string — optioneel, filter regels met substring match
      file: "error" | "info" (default "error") — welke log-bron
    """
    try:
        n = min(int(params.get("lines", 100)), 2000)
        pattern = params.get("grep", "") or ""
        kind = params.get("file", "error")

        if kind == "error":
            log_path = _latest_log_file("/root/novabot/data/ros2_log/mqtt_error_*.log")
        else:
            log_path = _latest_log_file("/root/novabot/data/ros2_log/mqtt_node_*.log")

        if not log_path:
            respond("get_mqtt_log_respond", {"result": 0, "value": {"lines": [], "error": "no log file"}})
            return

        # tail -n wordt efficiënter dan volledige read bij grote logs
        import subprocess
        result = subprocess.run(["tail", "-n", str(n), log_path], capture_output=True, text=True, timeout=10)
        lines = result.stdout.splitlines()

        if pattern:
            lines = [ln for ln in lines if pattern in ln]

        log(f"get_mqtt_log: {len(lines)} regels uit {log_path}")
        respond("get_mqtt_log_respond", {
            "result": 0,
            "value": {
                "file": log_path,
                "lines": lines,
                "count": len(lines),
            },
        })
    except Exception as e:
        log(f"get_mqtt_log: FOUT {e}")
        respond("get_mqtt_log_respond", {"result": 1, "error": str(e)})


_ROS_LOG_DIR = "/root/novabot/data/ros2_log"

# Known log sources — prefix of log filename. Extra aliases voor handig gebruik.
_LOG_SOURCES = {
    "mqtt": "mqtt_node",              # mqtt_node info (stdout)
    "mqtt_error": "mqtt_error",       # mqtt_node stderr incl glibc crashes
    "robot_decision": "robot_decision",
    "chassis_control": "chassis_control_node",
    "coverage_planner": "coverage_planner_server",
    "nav2": "nav2_single_node_navigator",
    "timer_record": "timer_record",
    "novabot_mapping": "novabot_mapping",
    "localization": "robot_combination_localization",
}


def handle_list_ros_logs(params, respond):
    """List beschikbare ROS log sources + hun recentste bestand + grootte."""
    import glob, time
    result = {}
    try:
        for alias, prefix in _LOG_SOURCES.items():
            pattern = f"{_ROS_LOG_DIR}/{prefix}_*.log"
            files = glob.glob(pattern)
            if not files:
                continue
            files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
            latest = files[0]
            try:
                st = os.stat(latest)
                result[alias] = {
                    "path": latest,
                    "size": st.st_size,
                    "mtime_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
                    "total_instances": len(files),
                }
            except Exception:
                result[alias] = None
        respond("list_ros_logs_respond", {"result": 0, "value": result})
    except Exception as e:
        log(f"list_ros_logs: FOUT {e}")
        respond("list_ros_logs_respond", {"result": 1, "error": str(e)})


def handle_get_ros_log(params, respond):
    """
    Generieke ROS log fetcher met filter ondersteuning.

    params:
      source: string  — alias uit _LOG_SOURCES (default "mqtt_error")
      lines:  int     — aantal laatste regels (default 200, max 2000)
      grep:   string  — optional substring filter
      level:  string  — optional "INFO" | "WARN" | "ERROR" — filter op log level prefix
      since:  int     — unix timestamp: alleen regels met hogere timestamp (mits log
                        format met [timestamp] prefix)
    """
    try:
        source = params.get("source", "mqtt_error")
        prefix = _LOG_SOURCES.get(source, source)  # fallback: raw prefix

        import glob
        files = sorted(glob.glob(f"{_ROS_LOG_DIR}/{prefix}_*.log"),
                       key=lambda p: os.path.getmtime(p), reverse=True)
        if not files:
            respond("get_ros_log_respond", {"result": 0, "value": {"lines": [], "error": f"no log for source={source}"}})
            return
        log_path = files[0]

        n = min(int(params.get("lines", 200)), 2000)
        import subprocess
        res = subprocess.run(["tail", "-n", str(n), log_path], capture_output=True, text=True, timeout=10)
        lines = res.stdout.splitlines()

        grep = params.get("grep", "") or ""
        level = params.get("level", "") or ""
        since = params.get("since", 0) or 0

        def ts_of(line):
            # Match "[2026-04-20-08:52:58]" or "[1776667978.383...]" formats
            try:
                if line.startswith("[") and line[1:5].isdigit() and line[5] == "-":
                    # [2026-04-20-08:52:58]
                    import time as _t
                    stamp = line[1:20]
                    return int(_t.mktime(_t.strptime(stamp, "%Y-%m-%d-%H:%M:%S")))
            except Exception:
                pass
            return 0

        filtered = []
        for ln in lines:
            if level and f"[{level.upper()}]" not in ln:
                continue
            if grep and grep not in ln:
                continue
            if since and ts_of(ln) < since:
                continue
            filtered.append(ln)

        log(f"get_ros_log[{source}]: {len(filtered)}/{len(lines)} regels na filter")
        respond("get_ros_log_respond", {
            "result": 0,
            "value": {
                "source": source,
                "file": log_path,
                "lines": filtered,
                "count": len(filtered),
                "raw_count": len(lines),
            },
        })
    except Exception as e:
        log(f"get_ros_log: FOUT {e}")
        respond("get_ros_log_respond", {"result": 1, "error": str(e)})


def handle_stat_path_files(params, respond):
    """
    Return sizes + mtimes van path files zodat we overflow-risico kunnen inschatten
    zonder SSH.
    """
    import time
    files = {}
    for name in ["planned_path.json", "preview_planned_path.json", "current_planned_path.json"]:
        path = f"{PLANNED_PATH_DIR}/{name}"
        try:
            st = os.stat(path)
            files[name] = {
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                "mtime_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
            }
        except FileNotFoundError:
            files[name] = None
        except Exception as e:
            files[name] = {"error": str(e)}

    # Ook de zip van de actieve map en aantal obstakels (proxy voor preview complexiteit)
    csv_dir = "/userdata/lfi/maps/home0/csv_file"
    csv_info = None
    try:
        entries = os.listdir(csv_dir)
        csv_info = {
            "total_files": len(entries),
            "obstacles": sum(1 for e in entries if "obstacle" in e),
            "work_csvs": sum(1 for e in entries if "_work.csv" in e),
            "unicom_csvs": sum(1 for e in entries if "unicom" in e),
        }
    except Exception as e:
        csv_info = {"error": str(e)}

    respond("stat_path_files_respond", {
        "result": 0,
        "value": {
            "planned_path_dir": PLANNED_PATH_DIR,
            "files": files,
            "csv_file_summary": csv_info,
        },
    })


# ── Command dispatch ──────────────────────────────────────────────────────

def handle_is_opennova(params, respond):
    """Report that this mower runs OpenNova firmware."""
    respond("is_opennova_respond", {"result": True, "version": "1.0"})


# ── Manual mowing — blade motor control (off-path from coverage tasks) ────
#
# The mower's standard MQTT API has no way to turn the blade motor on/off
# outside a coverage task — start_navigation implicitly enables it, and
# stop_navigation disables it. For manual / spot mowing while driving with
# the joystick we publish directly to the chassis's blade_speed_set topic
# (std_msgs/Int16, sub_setBladeSpeed_cb in chassis_serial_protocol.md).
#
# Safety: the OpenNova app includes auto-off on joystick disconnect,
# screen leave, mower error, and has a confirmation dialog before enabling.
# Firmware-level safety (tilt sensor, blade overcurrent) still applies on
# the STM32 side and will kill the motor on any fault.

def _publish_topic_bg(topic: str, type_name: str, payload_yaml: str) -> str:
    """Fire-and-forget ROS 2 topic publish via a background subprocess.

    DON'T wait for ros2 topic pub --once to finish — DDS participant init
    + subscriber discovery on this Horizon X3 routinely takes 6-10s. If we
    block the paho-mqtt on_message callback for that long, subsequent
    extended commands queue up and eventually time out (observed live when
    the user rapid-toggled the blade button).

    ROS_LOCALHOST_ONLY=1 is mandatory — the Novabot ROS nodes all run with
    it and DDS discovery only works when participants match.

    Returns '' on success (= subprocess spawned), error string on launch
    failure. The firmware receives the actual message ~1-10s later.
    """
    # RMW_IMPLEMENTATION=rmw_cyclonedds_cpp is CRITICAL — the Novabot nodes
    # all run on cyclonedds (chassis_control, robot_decision, etc.). Default
    # ros2 uses fastrtps which can't see cyclonedds participants at all.
    # Observed live 2026-04-21: ros2 topic pub printed "publishing #1" fine
    # but chassis_control_node's log showed NO blade messages received.
    cmd = (
        "export ROS_LOCALHOST_ONLY=1; "
        "export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; "
        "source /opt/ros/galactic/setup.bash 2>/dev/null; "
        "source /root/novabot/install/setup.bash 2>/dev/null; "
        f"ros2 topic pub --once {topic} {type_name} '{payload_yaml}' "
        f">>/tmp/extcmd_pub.log 2>&1"
    )
    try:
        # start_new_session detaches from our process group; stdio fully
        # closed so Popen doesn't hold pipes open. Process lives until
        # ros2 topic pub exits on its own.
        subprocess.Popen(
            ["bash", "-c", cmd],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return ""
    except Exception as e:
        return str(e)[:200]


def _publish_blade_speed(speed: int) -> str:
    return _publish_topic_bg(
        "/blade_speed_set",
        "std_msgs/msg/Int16",
        f"{{data: {int(speed)}}}",
    )


def _publish_blade_height(level: int) -> str:
    """Level 0-7 where 0 = blades retracted (stored, not cutting) and
    1-7 = cutting heights. Index maps to physical mm: mm = 90 − level*10,
    so level 5 = 40mm (default mowing height)."""
    return _publish_topic_bg(
        "/blade_height_set",
        "std_msgs/msg/UInt8",
        f"{{data: {int(level)}}}",
    )


def handle_blade_on(params, respond):
    """Turn the blade motor ON. Optional {speed: int} sets RPM (default 3000),
    {height: int} sets blade height level 0-7 (default 5 = 40mm). Height is
    pushed BEFORE speed so the blades are in cutting position before the
    motor spins up."""
    speed = int((params or {}).get("speed", 3000))
    height = (params or {}).get("height")
    # Clamp to something sensible — the chassis firmware has its own max.
    if speed < 500: speed = 500
    if speed > 3600: speed = 3600
    err_h = ""
    if height is not None:
        h = int(height)
        if h < 0: h = 0
        if h > 7: h = 7
        err_h = _publish_blade_height(h)
    err_s = _publish_blade_speed(speed)
    err = err_h or err_s
    respond("blade_on_respond", {
        "result": 0 if not err else 1,
        "speed": speed,
        "height": height,
        "error": err,
    })


def handle_blade_off(params, respond):
    """Turn the blade motor OFF (speed 0) AND retract blades (height 0).
    Retracting is important safety: blades UP = physically safer when
    mower is picked up, moved, or stuck."""
    err1 = _publish_blade_speed(0)
    err2 = _publish_blade_height(0)
    err = err1 or err2
    respond("blade_off_respond", {"result": 0 if not err else 1, "error": err})


def handle_blade_speed(params, respond):
    """Set arbitrary blade speed 0-3600. 0 = off."""
    speed = int((params or {}).get("speed", 0))
    if speed < 0: speed = 0
    if speed > 3600: speed = 3600
    err = _publish_blade_speed(speed)
    respond("blade_speed_respond", {"result": 0 if not err else 1, "speed": speed, "error": err})


def handle_blade_height(params, respond):
    """Set blade height level 0-7. 0 = retracted / not cutting, 1-7 = cutting
    heights (level = (90 − mm)/10). App typically sends level 2-7 for mowing
    and 0 when stopping."""
    level = int((params or {}).get("level", 0))
    if level < 0: level = 0
    if level > 7: level = 7
    err = _publish_blade_height(level)
    respond("blade_height_respond", {"result": 0 if not err else 1, "level": level, "error": err})


COMMANDS = {
    "is_opennova": handle_is_opennova,
    "set_robot_reboot": handle_reboot,
    "get_system_info": handle_system_info,
    "verify_pin": handle_verify_pin,
    "query_pin": handle_query_pin,
    "clear_error": handle_clear_error,
    "set_perception_mode": handle_set_perception_mode,
    "set_semantic_mode": handle_set_semantic_mode,
    "get_perception_status": handle_get_perception_status,
    "set_mqtt_config": handle_set_mqtt_config,
    "set_wifi_config": handle_set_wifi_config,
    "clean_ota_cache": handle_clean_ota_cache,
    "finalize_map_files": handle_finalize_map_files,
    "recalibrate_charging_pose": handle_recalibrate_charging_pose,
    "start_boundary_follow": handle_start_boundary_follow,
    "stop_boundary_follow": handle_stop_boundary_follow,
    "get_lora_info": handle_get_lora_info,
    "set_lora_info": handle_set_lora_info,
    "get_preview_cover_path": handle_get_preview_cover_path,
    "get_map_plan_path": handle_get_map_plan_path,
    "get_mqtt_log": handle_get_mqtt_log,
    "get_ros_log": handle_get_ros_log,
    "list_ros_logs": handle_list_ros_logs,
    "stat_path_files": handle_stat_path_files,
    "blade_on": handle_blade_on,
    "blade_off": handle_blade_off,
    "blade_speed": handle_blade_speed,
    "blade_height": handle_blade_height,
    "sync_map": lambda p, r: handle_sync_map(p, r),
}


def handle_sync_map(params, respond):
    """
    SSH-free map sync: pull latest ZIP from the OpenNova server, install into
    `/userdata/lfi/maps/home0/` and restart `novabot_mapping` so coverage_planner
    picks up the new polygon. Triggered by the server whenever a map is edited,
    or can be invoked on-demand from any MQTT client.

    Flow:
      1. GET /api/dashboard/maps/<SN>/sync-info  → { md5, posJson, zipUrl }
      2. If local MD5 matches → no-op, report unchanged
      3. GET /api/dashboard/maps/<SN>/sync-zip (with If-None-Match) → bytes
      4. Atomically replace home0/csv_file + x3_csv_file
      5. Write pos.json from charger GPS
      6. Restart novabot_mapping via ros2 launch

    Skip-during-mowing guard: refuses to run while coverage is active to avoid
    yanking the map out from under an in-flight task.
    """
    import hashlib
    import shutil
    import subprocess
    import urllib.request
    import urllib.error

    sn = params.get("sn") or _sn_from_config()
    server = params.get("server") or _server_from_config()
    force = bool(params.get("force"))

    if not sn or not server:
        respond("sync_map_respond", {"result": 1, "error": "sn or server unknown"})
        return

    # Refuse during active coverage to keep a running task's map intact.
    if not force and _coverage_is_active():
        respond("sync_map_respond", {"result": 2, "error": "coverage active, try again on dock"})
        return

    base = f"http://{server}/api/dashboard/maps/{sn}"
    local_md5 = _local_zip_md5("/userdata/lfi/maps/home0/LFIN1231000211.zip")

    # 1. Cheap HEAD-ish probe
    try:
        with urllib.request.urlopen(f"{base}/sync-info", timeout=10) as r:
            info = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        respond("sync_map_respond", {"result": 1, "error": f"sync-info: {e}"})
        return

    remote_md5 = info.get("md5")
    if remote_md5 and local_md5 and remote_md5 == local_md5 and not force:
        respond("sync_map_respond", {"result": 0, "unchanged": True, "md5": remote_md5})
        return

    # 2. Pull actual bytes with ETag so repeat calls are cheap server-side.
    try:
        req = urllib.request.Request(f"{base}/sync-zip")
        if local_md5:
            req.add_header("If-None-Match", f'"{local_md5}"')
        with urllib.request.urlopen(req, timeout=30) as r:
            zip_bytes = r.read()
            got_md5 = hashlib.md5(zip_bytes).hexdigest()
    except urllib.error.HTTPError as e:
        if e.code == 304:
            respond("sync_map_respond", {"result": 0, "unchanged": True, "md5": local_md5})
            return
        respond("sync_map_respond", {"result": 1, "error": f"sync-zip HTTP {e.code}"})
        return
    except Exception as e:
        respond("sync_map_respond", {"result": 1, "error": f"sync-zip: {e}"})
        return

    # Note: we don't cross-check remote_md5 from sync-info against got_md5 here,
    # because `generateMapZipFromDb` embeds fresh file timestamps in each ZIP build,
    # so two back-to-back calls yield different binary hashes. We trust the
    # downloaded bytes directly — the ETag on sync-zip already handles the
    # "unchanged since local_md5" case with a 304.

    # 3. Write ZIP to /tmp then unzip into home0/, atomically replacing csv_file/x3_csv_file.
    tmp_zip = "/tmp/novabot_sync_map.zip"
    home0 = "/userdata/lfi/maps/home0"
    try:
        with open(tmp_zip, "wb") as f:
            f.write(zip_bytes)
        # Clean existing dirs (firmware expects fresh extract, not merge)
        for sub in ("csv_file", "x3_csv_file"):
            p = f"{home0}/{sub}"
            if os.path.isdir(p):
                shutil.rmtree(p)
        os.makedirs(home0, exist_ok=True)
        rc = subprocess.run(
            ["unzip", "-o", "-q", tmp_zip, "-d", home0],
            capture_output=True, text=True, timeout=30,
        )
        if rc.returncode != 0:
            respond("sync_map_respond", {"result": 1, "error": f"unzip rc={rc.returncode}: {rc.stderr[-200:]}"})
            return
        # x3_csv_file is just a copy of csv_file for the internal coverage_planner reader.
        src = f"{home0}/csv_file"
        dst = f"{home0}/x3_csv_file"
        if os.path.isdir(src):
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        # Write the canonical mower-visible ZIP so get_map_list_respond sees the
        # new md5 (firmware expects a single LFIN*.zip in home0/).
        try:
            shutil.copy(tmp_zip, f"{home0}/{sn}.zip")
        except Exception:
            pass
        # pos.json so localization can map GPS → local meters
        pos_json = info.get("posJson")
        if pos_json:
            with open("/userdata/pos.json", "w") as f:
                json.dump(pos_json, f)
    except Exception as e:
        respond("sync_map_respond", {"result": 1, "error": f"install: {e}"})
        return
    finally:
        try: os.remove(tmp_zip)
        except Exception: pass

    # 4. Restart novabot_mapping so coverage_planner reloads from new CSVs.
    restart_ok = _restart_novabot_mapping()
    respond("sync_map_respond", {
        "result": 0,
        "md5": got_md5,
        "sizeBytes": len(zip_bytes),
        "restart": restart_ok,
    })


def _sn_from_config():
    try:
        with open("/userdata/lfi/json_config.json") as f:
            cfg = json.load(f)
        return cfg.get("sn", {}).get("value", {}).get("code")
    except Exception:
        return None


def _server_from_config():
    try:
        with open("/userdata/lfi/json_config.json") as f:
            cfg = json.load(f)
        addr = cfg.get("mqtt", {}).get("value", {}).get("addr")
        # MQTT broker = server; HTTP is on same host, port 3000 (Docker) or 80.
        # Prefer port 80 since the mower's uploadEquipmentMap already uses it.
        return f"{addr}:80" if addr else None
    except Exception:
        return None


def _local_zip_md5(path):
    import hashlib
    try:
        with open(path, "rb") as f:
            return hashlib.md5(f.read()).hexdigest()
    except Exception:
        return None


def _coverage_is_active():
    """Read /tmp/mower_work_status or ask mqtt_node — cheap heuristic: check the
    task_mode published by report_state_robot in the last 10s. Falls back to
    'not active' on error so sync always proceeds when we can't tell."""
    try:
        rc = subprocess.run(
            ["bash", "-lc", "pgrep -f coverage_planner_server >/dev/null && echo yes || echo no"],
            capture_output=True, text=True, timeout=5,
        )
        if rc.stdout.strip() != "yes":
            return False  # planner not even running
        # Heuristic: if chassis motors pull current > 200 mA we're mowing.
        tail = subprocess.run(
            ["bash", "-lc", "tail -20 $(ls -t /root/novabot/data/ros2_log/chassis_control_node_*.log 2>/dev/null | head -1)"],
            capture_output=True, text=True, timeout=5,
        )
        for line in tail.stdout.splitlines()[::-1]:
            if "cut_motor_current_ma" in line:
                try:
                    val = float(line.split("cut_motor_current_ma = ")[1].split(",")[0])
                    return val > 200.0
                except Exception:
                    pass
        return False
    except Exception:
        return False


def _restart_novabot_mapping():
    import subprocess
    try:
        cmd = (
            '(pkill -f "novabot_mapping_launch.py" || true) && '
            "sleep 1 && "
            "(killall -9 novabot_mapping 2>/dev/null || true) && "
            "sleep 1 && "
            ". /opt/ros/galactic/setup.bash && "
            ". /root/novabot/install/setup.bash && "
            "export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:$LD_LIBRARY_PATH && "
            "export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH && "
            "export ROS_LOG_DIR=/root/novabot/data/ros2_log && "
            "export ROS_LOCALHOST_ONLY=1 && "
            "nohup ros2 launch novabot_mapping novabot_mapping_launch.py "
            ">> $ROS_LOG_DIR/novabot_mapping_restart.log 2>&1 </dev/null &"
        )
        rc = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=20)
        return rc.returncode == 0
    except Exception:
        return False


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
