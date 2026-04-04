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


# ── Command dispatch ──────────────────────────────────────────────────────

COMMANDS = {
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
