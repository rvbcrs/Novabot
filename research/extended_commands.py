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
from contextlib import contextmanager
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
COVERAGE_PLANNER_RADIUS_MIN_M = 0.20
COVERAGE_PLANNER_RADIUS_MAX_M = 1.20
COVERAGE_PLANNER_PARAMS_YAML_CANDIDATES = [
    "/root/novabot/install/coverage_planner/share/coverage_planner/params/coverage_planner_params.yaml",
    "/userdata/novabot_slam/install/coverage_planner/share/coverage_planner/params/coverage_planner_params.yaml",
    "/userdata/novabot/install/coverage_planner/share/coverage_planner/params/coverage_planner_params.yaml",
    "/opt/novabot/install/coverage_planner/share/coverage_planner/params/coverage_planner_params.yaml",
]

def log(msg):
    print(f"{LOG_PREFIX} {msg}", flush=True)


def _env_bool(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_float(name, default, minimum):
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None else float(default)
    except (TypeError, ValueError):
        value = float(default)
    return max(float(minimum), value)


def enable_blade_telemetry():
    """Enable live /blade_speed_get -> MQTT telemetry.

    Disabled by default because the ROS subscription wakes this Python process
    at chassis publish rate. Manual blade commands still work without it.
    """
    return _env_bool("OPENNOVA_ENABLE_BLADE_TELEMETRY", False)


def enable_rtk_telemetry():
    """Enable the RTK fix-quality indicator relay (/bestpos_parsed_data ->
    rtk_fix_quality / rtk_sat).

    Measured ~5Hz with a light callback, and useful for diagnosing localization,
    so it is ON by default. Set OPENNOVA_ENABLE_RTK_TELEMETRY=0 to drop it for
    maximum thermal headroom. The heavier heading/velocity telemetry is a
    separate opt-in flag (see enable_heading_telemetry).
    """
    return _env_bool("OPENNOVA_ENABLE_RTK_TELEMETRY", True)


def enable_heading_telemetry():
    """Enable the heavier heading + GNSS-velocity telemetry inside the RTK relay
    (/robot_combination_localization/odom -> heading_deg, /bestvel_parsed_data ->
    gnss_track_deg / gnss_speed).

    These add ~10Hz of high-rate ROS subscriptions (measured 5Hz each) and are
    only needed for heading-discovery / re-anchor diagnostics, not for the
    fix-quality indicator or normal mowing — so they are opt-in for thermal
    headroom. Set OPENNOVA_ENABLE_HEADING_TELEMETRY=1 to enable.
    """
    return _env_bool("OPENNOVA_ENABLE_HEADING_TELEMETRY", False)


def blade_idle_hold_seconds():
    """How long to keep publishing blade-off / height pulses before idling."""
    return _env_float("OPENNOVA_BLADE_IDLE_HOLD_SECONDS", 6.0, 2.0)


def charging_station_guard_interval_seconds():
    """How often the charging_station.yaml guard scans map homes."""
    return _env_float("OPENNOVA_CHG_GUARD_INTERVAL_SECONDS", 60.0, 30.0)


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


# ── Map/CSV helpers (gedeeld door de map-handlers) ─────────────────────────
def read_xy_csv(path):
    """Parse a polygon/polyline CSV: one `x y` or `x,y` pair per line.

    Tolerant: skips blank/short lines, takes the first two columns, and returns
    [] for an unreadable file. Shared by the per-map / seam / empty-map handlers.
    """
    pts = []
    try:
        with open(path) as fh:
            for line in fh:
                a = line.strip().replace(",", " ").split()
                if len(a) >= 2:
                    pts.append((float(a[0]), float(a[1])))
    except Exception:
        pass
    return pts


def parse_map_yaml(path):
    """Read resolution + origin x/y from a map.yaml.

    Returns (res, ox, oy, raw_text). Raises ValueError if either field is
    missing so callers can respond with their own error name.
    """
    with open(path) as fh:
        txt = fh.read()
    rm = re.search(r"resolution:\s*([0-9.eE+-]+)", txt)
    om = re.search(r"origin:\s*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)", txt)
    if not rm or not om:
        raise ValueError("map.yaml missing resolution/origin")
    return float(rm.group(1)), float(om.group(1)), float(om.group(2)), txt


def make_to_px(ox, oy, res, height_px):
    """World (x,y) meters -> pixel (col, row) for a map.pgm of the given origin/res."""
    return lambda x, y: (int((x - ox) / res), (height_px - 1) - int((y - oy) / res))


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
        # Serialize ALL socket writes. publish() is called from multiple
        # threads (main command loop + RtkRelay/BladeRelay/charging-guard
        # ROS callbacks), and a large response (e.g. read_map_files ~1.7MB)
        # takes long enough to sendall() that a concurrent ~40B sensor
        # publish splices into the middle of it → corrupted MQTT stream →
        # the server's JSON.parse fails silently → command appears to time
        # out (e.g. mask-overlay 404). One lock per packet keeps each
        # PUBLISH atomic on the wire.
        self._send_lock = threading.Lock()

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
        # Hold the lock for the whole packet so concurrent publishes from
        # other threads can't interleave their bytes into this one (see
        # _send_lock in __init__).
        with self._send_lock:
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


@contextmanager
def stm32_serial(kill_chassis=True):
    """Open /dev/ttyACM0 to the STM32, optionally freeing it first.

    chassis_control_node holds the port, so STM32 commands kill it for exclusive
    access (kill_chassis=True). serial_clear_error is also called in a loop after
    a verify where chassis is already dead, so it passes kill_chassis=False.
    Always closes the port — even on exception (the old inline code leaked the fd).
    """
    import serial as pyserial
    if kill_chassis:
        subprocess.run(["killall", "chassis_control_node"], capture_output=True)
        time.sleep(0.5)
    ser = pyserial.Serial("/dev/ttyACM0", 115200, timeout=0.3)
    try:
        ser.reset_input_buffer()
        yield ser
    finally:
        ser.close()


def serial_clear_error():
    """Send clear error command (CMD 0x23 type=3) to STM32 via serial.

    Clears ALL error state and switches display to home screen.
    Does NOT require PIN verification. Requires patched firmware v3.6.7+.

    Returns:
        dict with result: 0=success, 2=serial error
    """
    try:
        with stm32_serial(kill_chassis=False) as ser:
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
    if len(pin_str) != 4 or not pin_str.isdigit():
        return {"result": 1, "error": "PIN must be 4 digits"}

    # Convert PIN to ASCII bytes (e.g. "3053" → [0x33, 0x30, 0x35, 0x33])
    pin_bytes = pin_str.encode('ascii')

    try:
        with stm32_serial() as ser:  # kills chassis_control_node for exclusive access
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
    try:
        with stm32_serial() as ser:  # kills chassis_control_node for exclusive access
            payload = bytes([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])  # type=0 query
            frame = build_serial_frame(0x23, payload)
            ser.write(frame)

            buf = b""
            t0 = time.time()
            while time.time() - t0 < 1:
                buf += ser.read(512)

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


def handle_soft_restart(params, respond):
    """Soft restart: restart the whole novabot ROS stack via
    `systemctl restart novabot_launch.service`. This is NOT an OS reboot — it
    cycles iox-roudi + all ROS nodes (which RESETS the iceoryx shm pool, the
    fix for the chunk leak that crash-loops novabot_mapping → Error 140), while
    `mqtt_node` keeps running so the mower stays online to the app.

    SAFETY: the "only when idle/charging, NEVER while mowing" gate is enforced
    SERVER-SIDE (the server reads work_status and only sends soft_restart when
    safe). We do not re-check ROS state here because extended_commands has no
    cheap view of it.

    extended_commands.py is itself launched by novabot_launch.service, so the
    restart will kill THIS process. We therefore respond first, then fire the
    restart DETACHED (setsid via start_new_session) with a short delay so the
    response MQTT flush + our teardown don't abort the systemctl call. Same
    detachment pattern as _restart_novabot_mapping.
    """
    import subprocess
    log("soft_restart requested — restarting novabot_launch.service (ROS stack reset)")
    respond("soft_restart_respond", {"result": 0})
    try:
        subprocess.Popen(
            ["bash", "-lc", "sleep 2; systemctl restart novabot_launch.service"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except Exception as e:
        log(f"soft_restart error: {e}")


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


def obstacle_detect_window_seconds():
    """Length of one detection pass (seconds)."""
    return _env_float("OPENNOVA_OBSTACLE_DETECT_WINDOW_S", 0.6, 0.3)


def obstacle_detect_period_occasional_seconds():
    """Seconds between detection passes at level 2 (occasional)."""
    return _env_float("OPENNOVA_OBSTACLE_DETECT_OCCASIONAL_S", 6.0, 2.0)


def obstacle_detect_period_frequent_seconds():
    """Seconds between detection passes at level 3 (frequent)."""
    return _env_float("OPENNOVA_OBSTACLE_DETECT_FREQUENT_S", 3.0, 1.0)


def obstacle_detect_idle_poll_seconds():
    """Poll interval when cadence is off or not mowing."""
    return _env_float("OPENNOVA_OBSTACLE_DETECT_IDLE_POLL_S", 5.0, 2.0)


def obstacle_detect_period(level):
    """Seconds between detection windows for a cadence level. None = off.

    level 1 (or <1) = off (segmentation only); 2 = occasional; 3 (or >3) = frequent.
    """
    if level is None or level <= 1:
        return None
    if level >= 3:
        return obstacle_detect_period_frequent_seconds()
    return obstacle_detect_period_occasional_seconds()


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


# Object-detection cadence level (1 = off, 2 = occasional, 3 = frequent).
# Set by the server via the `set_obstacle_detection` extended command, read by
# the cadence thread (start_obstacle_detection_cadence). Default off until told.
# Persisted to a file so the level survives an extended_commands RESPAWN — the
# server only re-pushes the level on a fresh MQTT (re)connect (onMowerConnected),
# not on a bare process respawn, so without this the cadence silently reset to
# off mid-session. (Reboot still clears /tmp; the server re-push covers that.)
OBSTACLE_DETECTION_LEVEL_FILE = "/tmp/obstacle_detection_level"
_obstacle_detection_level = 1


def _persist_obstacle_detection_level(level):
    try:
        with open(OBSTACLE_DETECTION_LEVEL_FILE, "w") as f:
            f.write(str(int(level)))
    except Exception as ex:
        log(f"[obstacle-detect] could not persist level: {ex}")


def _load_obstacle_detection_level():
    try:
        with open(OBSTACLE_DETECTION_LEVEL_FILE) as f:
            return max(1, min(3, int(f.read().strip())))
    except Exception:
        return 1


def handle_set_obstacle_detection(params, respond):
    """Set the object-detection cadence level driven by the app's
    obstacle_avoidance_sensitivity (1 = off, 2 = occasional, 3 = frequent)."""
    global _obstacle_detection_level
    try:
        level = int(params.get("level", 1))
    except (TypeError, ValueError):
        level = 1
    level = max(1, min(3, level))
    _obstacle_detection_level = level
    _persist_obstacle_detection_level(level)
    log(f"[obstacle-detect] cadence level set to {level}")
    respond("set_obstacle_detection_respond", {"result": 0, "level": level})


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


def _depart_pile(seconds: float = 4.0, linear: float = 0.25):
    """Drive backward to leave the charging dock before starting a task.

    Stock `start_cov_task` performs an automatic ~1m back-off from the
    pile as part of its preamble. The NTCP edge-cut path bypasses
    robot_decision and would otherwise try to plan from the dock, where
    the planner refuses to move (close-to-lethal start pose).

    Sequence:
      1. Cancel any active recharge so auto_charging stops driving.
      2. Publish UInt8(1) to /release_charge_lock — same signal the
         stock mqtt_node binary sends when handling start_navigation
         from the dock (decompile mqtt_node:308974). Without this the
         chassis stays magnet-locked and ignores /cmd_vel commands.
      3. Wait briefly for the chassis to release.
      4. Publish a steady-state Twist on /cmd_vel for `seconds` seconds.
         Default 4s @ 0.25 m/s = ~1.0 m back-off, matching the firmware.
      5. Send a zero Twist to bring the chassis to a stop before the
         coverage planner takes over.

    Blocking — caller decides when to invoke. Only call this when the
    mower is confirmed on the dock; backing up off-pile may bump into an
    obstacle the local costmap hasn't seen.
    """
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0",
        "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }

    log(f"depart_pile: starting {seconds}s reverse @ {linear} m/s")

    # All ros2 CLI calls in one long-running bash so we pay DDS
    # discovery cost ONCE. Previous design did 4 separate subprocess
    # calls — each spent 5-8 s rediscovering the graph and the inner
    # `timeout 2-4` cut them off before they could complete. The full
    # depart sequence now fits comfortably inside a single 30-second
    # outer timeout.
    twist = (
        f"'{{linear: {{x: -{linear}, y: 0.0, z: 0.0}}, "
        f"angular: {{x: 0.0, y: 0.0, z: 0.0}}}}'"
    )
    stop_twist = "'{linear: {x: 0.0, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}'"

    # Each ros2 CLI invocation re-runs DDS discovery (~3-5 s on this
    # hardware). We can't avoid that from the shell, but we CAN make
    # sure the reverse-Twist publisher actually has time to publish
    # something before we kill it. Live capture 2026-04-28 showed
    # `sleep 4` killing the publisher mid-discovery → no cmd_vel
    # messages reached the chassis, mower stayed put.
    #
    # Two changes:
    #   a) Warm the /cmd_vel publisher with a single --once Twist BEFORE
    #      starting the streaming publisher. The first publish triggers
    #      DDS to register the writer; subsequent publishers reuse the
    #      already-discovered topic.
    #   b) Hold the streaming publisher long enough that even after
    #      discovery cost there's still real drive time. Bump the
    #      blocking sleep to 4s + 4s overhead; mower will only DRIVE
    #      while messages arrive at 10 Hz, so a longer hold is
    #      effectively a no-op once messages stop.
    # ros2 topic pub re-runs DDS discovery on every invocation. Live
    # capture 2026-04-28 showed iceoryx init alone consuming 7-8 s
    # before a single message hit the wire. We keep the streaming
    # publisher alive long enough that — even after worst-case
    # discovery — there's still real publish time at 10 Hz. Mower's
    # cmd_vel watchdog brakes within ~0.5 s of message-loss, so a
    # bigger hold doesn't translate to extra drive distance, just a
    # safety margin.
    # The --once warm-up above already paid DDS discovery, so the streaming
    # publisher starts emitting almost immediately. A big "slack" here is NOT
    # a no-op: the mower drives at 0.25 m/s for the WHOLE hold (messages keep
    # flowing at 10 Hz), so seconds+16 gave ~2.5-3m of reverse instead of 1m.
    # Hold just past `seconds` so the drive is ~seconds*0.25 m = ~1m.
    drive_hold = float(seconds) + 2.0
    sequence = (
        "set -x; "
        "source /opt/ros/galactic/setup.bash; "
        "source /root/novabot/install/setup.bash 2>/dev/null; "
        # 1. Best-effort cancel of any active recharge action.
        "ros2 service call /robot_decision/cancel_recharge "
        "std_srvs/srv/Trigger '{}' || true; "
        # 2. Drop the dock magnet (UInt8(1) per stock mqtt_node).
        "ros2 topic pub --once /release_charge_lock std_msgs/msg/UInt8 "
        "'{data: 1}' || true; "
        # 3. Wait for chassis to release (~500 ms).
        "sleep 0.5; "
        # 4a. Warm /cmd_vel topic with a single REVERSE Twist so the
        #     DDS graph already knows about a writer with this exact
        #     QoS by the time the streaming publisher comes up. Using
        #     reverse (not zero) also lets the mower's velocity watchdog
        #     latch on to the signal sooner.
        f"ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist {twist} || true; "
        # 4b. Stream the reverse Twist at 10 Hz.
        f"ros2 topic pub --rate 10 /cmd_vel geometry_msgs/msg/Twist {twist} & "
        "TWIST_PID=$!; "
        f"sleep {drive_hold}; "
        "kill $TWIST_PID 2>/dev/null; "
        "wait $TWIST_PID 2>/dev/null; "
        # 5. Brake — single zero Twist.
        f"ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist {stop_twist} || true"
    )

    bash_cmd = f"({sequence}) >> /tmp/depart_pile.log 2>&1"
    # Outer timeout: every ros2 CLI invocation can eat ~5-8s on DDS
    # discovery. Sequence has 5 ros2 calls plus the drive_hold sleep,
    # so worst-case ~40s of overhead + drive_hold.
    outer_timeout = max(60.0, 40.0 + drive_hold + 10.0)
    try:
        rc = subprocess.run(["bash", "-c", bash_cmd], env=env,
                            timeout=outer_timeout).returncode
        log(f"depart_pile: sequence rc={rc}")
    except Exception as e:
        log(f"depart_pile: sequence failed: {e}")

    log("depart_pile: done")


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


_NAV_NODE = "/nav2_single_node_navigator"


def _ros_env():
    """Shared-mem DDS env so ros2 CLI clients discover the on-mower nodes."""
    return {
        **os.environ,
        "ROS_DOMAIN_ID": "0", "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }


def _ros2_param_get(node, name):
    """Return a float param value from `node`, or None on failure."""
    cmd = ("source /opt/ros/galactic/setup.bash && "
           "source /root/novabot/install/setup.bash 2>/dev/null && "
           f"timeout 8 ros2 param get {node} {name}")
    try:
        out = subprocess.run(["bash", "-c", cmd], env=_ros_env(),
                             capture_output=True, text=True, timeout=14).stdout
    except Exception:
        return None
    m = re.search(r"value is:\s*([-0-9.eE+]+)", out)
    return float(m.group(1)) if m else None


def _ros2_param_set(node, name, value):
    """Set a param on `node` (best-effort)."""
    cmd = ("source /opt/ros/galactic/setup.bash && "
           "source /root/novabot/install/setup.bash 2>/dev/null && "
           f"timeout 8 ros2 param set {node} {name} {value}")
    try:
        subprocess.run(["bash", "-c", cmd], env=_ros_env(),
                       capture_output=True, text=True, timeout=14)
    except Exception:
        pass


def _robot_map_xy(timeout_s=6):
    """Current robot position in the map frame via tf2_echo (map -> base_link).

    Returns (x, y) or None. Doubles as a localization gate: if the TF is not
    being published (mower not localized), returns None and the caller refuses
    to move. Reuses the shared-mem DDS env the ROS nodes use.
    """
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0", "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }
    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        f"timeout {timeout_s} ros2 run tf2_ros tf2_echo map base_link"
    )
    try:
        out = subprocess.run(["bash", "-c", cmd], env=env, capture_output=True,
                             text=True, timeout=timeout_s + 4).stdout
    except Exception:
        return None
    m = re.search(r"Translation:\s*\[\s*([-0-9.eE+]+),\s*([-0-9.eE+]+)", out)
    return (float(m.group(1)), float(m.group(2))) if m else None


MAPS_HOME = "/userdata/lfi/maps/home0"


def _follow_unicom(from_slot, to_slot, dry_run=False):
    """Build + (in non-dry-run mode) drive the recorded inter-zone unicom line
    EXACTLY via nav2 /follow_path. Pure core extracted out of
    handle_follow_unicom so it is unit-testable and reusable by the mow_zone
    orchestrator (Task 4): it does NOT call respond(), it returns a dict.

    Fixes the "cuts a corner into the hedge between zones" class of bug. The
    firmware never follows the unicom itself: zone transit runs through
    coverage_planner_server which free-plans a goal-based path on the pgm (see
    research/documents/unicom-follow-transit-design.md + Novabot-aaj). This
    loads the recorded map<from>tomap<to>_*_unicom.csv, orients it toward the
    `to`-zone end, and drives it with FollowPathPurePursuit so the mower
    traces the real opening. After it finishes the robot sits at the target
    zone entrance and normal coverage can start with no hedge risk.

    Args:
      from_slot: source slot, e.g. "map0"
      to_slot:   target slot, e.g. "map3"
      dry_run:   if true, build + return the path points but DO NOT move (for
                 the pre-flight plot).

    Returns:
      {result:0, from, to, points, oriented, dry_run, path}          dry_run
      {result:0, from, to, points, oriented, dry_run, relaxed_params, join}
                                                                  non-dry-run
      {result:1, error: invalid_map_name|no_unicom_X_Y|empty_unicom|not_localized}

    In non-dry-run mode on success, the dict also carries a "join" callable
    (the dispatched drive-thread's `.join`) so a caller such as the mow_zone
    orchestrator can block until the drive actually finishes before starting
    coverage. NOTE: "join" is a callable, not JSON-serializable - a caller
    that responds with this dict over MQTT must pop it first (see
    handle_follow_unicom below).
    """
    import math
    map_from = from_slot
    map_to = to_slot
    if not re.fullmatch(r"map\d+", map_from) or not re.fullmatch(r"map\d+", map_to):
        return {"result": 1, "error": "invalid_map_name"}

    csv_dir = f"{MAPS_HOME}/x3_csv_file" if os.path.isdir(f"{MAPS_HOME}/x3_csv_file") else f"{MAPS_HOME}/csv_file"
    # Filename is "<from>to<to>_<n>_unicom.csv" and the slot names already carry
    # "map" (map0, map3), so the separator is just "to": map0 + to + map3.
    pat = re.compile(rf"^{map_from}to{map_to}_(\d+)_unicom\.csv$")
    seg_files = sorted((f for f in os.listdir(csv_dir) if pat.match(f)),
                       key=lambda f: int(pat.match(f).group(1)))
    if not seg_files:
        return {"result": 1, "error": f"no_unicom_{map_from}_{map_to}"}
    pts = []
    for f in seg_files:
        for p in read_xy_csv(os.path.join(csv_dir, f)):
            if not pts or (abs(p[0] - pts[-1][0]) + abs(p[1] - pts[-1][1])) > 1e-4:
                pts.append(p)
    if len(pts) < 2:
        return {"result": 1, "error": "empty_unicom"}

    # Localization gate: need a valid pose to move safely.
    robot = _robot_map_xy()
    if robot is None and not dry_run:
        return {"result": 1, "error": "not_localized"}
    # Orient so the LAST point is the `to`-zone end, so the robot always drives
    # toward the destination no matter where along the path it currently sits
    # (it can be mid-transit). Use the `to` work-polygon centroid; fall back to
    # farthest-from-dock if that CSV is missing.
    oriented = "as-recorded"
    to_pts = read_xy_csv(os.path.join(csv_dir, f"{map_to}_work.csv"))
    if to_pts:
        cx = sum(p[0] for p in to_pts) / len(to_pts)
        cy = sum(p[1] for p in to_pts) / len(to_pts)
        d_first = (pts[0][0] - cx) ** 2 + (pts[0][1] - cy) ** 2
        d_last = (pts[-1][0] - cx) ** 2 + (pts[-1][1] - cy) ** 2
        if d_first < d_last:      # pts[0] is nearer the destination -> flip it to the end
            pts = list(reversed(pts))
            oriented = "reversed"
    elif (pts[0][0] ** 2 + pts[0][1] ** 2) > (pts[-1][0] ** 2 + pts[-1][1] ** 2):
        pts = list(reversed(pts))  # no to-polygon: put the farther-from-dock end last
        oriented = "reversed-fallback"

    if dry_run:
        log(f"follow_unicom DRY-RUN {map_from}->{map_to}: {len(pts)} pts, oriented={oriented}")
        return {
            "result": 0, "from": map_from, "to": map_to,
            "points": len(pts), "oriented": oriented, "dry_run": True,
            "path": [[round(x, 3), round(y, 3)] for x, y in pts],
        }

    # Build nav_msgs/Path: per-point yaw = heading toward the next point.
    poses = []
    prev_qz, prev_qw = 0.0, 1.0
    for i, (x, y) in enumerate(pts):
        if i < len(pts) - 1:
            yaw = math.atan2(pts[i + 1][1] - y, pts[i + 1][0] - x)
            prev_qz, prev_qw = math.sin(yaw / 2), math.cos(yaw / 2)
        qz, qw = prev_qz, prev_qw
        poses.append(
            "{header: {frame_id: map}, pose: {position: "
            f"{{x: {x:.4f}, y: {y:.4f}, z: 0.0}}, orientation: "
            f"{{x: 0.0, y: 0.0, z: {qz:.6f}, w: {qw:.6f}}}}}}}"
        )
    # goal_checker_id is REQUIRED - nav2 aborts a FollowPath goal with an empty
    # current_goal_checker. Available on this mower: general_goal_checker,
    # try_closer_goal_checker. controller_id FollowPathPurePursuit matches what
    # coverage_planner_server uses.
    goal_yaml = (
        "'{path: {header: {frame_id: map}, poses: ["
        + ", ".join(poses)
        + "]}, controller_id: \"FollowPathPurePursuit\", "
        "goal_checker_id: \"general_goal_checker\"}'"
    )
    # Relax the controller for the TRUSTED recorded path: faster, more patient,
    # and less collision-sensitive. We recorded this unicom ourselves so it is a
    # known-good line; the stock RegulatedPurePursuit otherwise crawls to a stop
    # in the narrow gap (collision-ahead + patience abort). max_allowed_time_to_
    # collision stays > 0 (0.25s ~ 0.15m ahead) so it still HARD-STOPS for
    # something right in front (a person/pet). Every param is restored after the
    # FollowPath finishes so coverage / other navigation keeps full sensitivity.
    # (relaxed value, default-to-restore). Defaults are the yaml values in
    # novabot_boundary_follow_footprint.yaml; hardcoded so we skip the slow
    # per-param `ros2 param get` (a restart also reloads these yaml defaults).
    # (relaxed, default) per param. The relaxed value applies only during the
    # transit and is ALWAYS restored in the finally block. String bools render
    # as lowercase for `ros2 param set`; numbers render as-is.
    # The dominant crawl cause is curvature scaling (use_regulated_linear_
    # velocity_scaling=True drops the speed toward ~0.17 m/s on the bends in
    # the gap). We drive a self-recorded, known-safe line, so we turn curvature
    # scaling OFF for the transit and let desired_linear_vel govern. Obstacle-
    # cost scaling is already False on this node, so it is not a factor.
    TRANSIT_PARAMS = {
        "progress_checker.movement_time_allowance": (45.0, 12.0),
        "progress_checker.required_movement_radius": (0.08, 0.2),
        "FollowPathPurePursuit.max_allowed_time_to_collision": (0.25, 0.8),
        "FollowPathPurePursuit.use_regulated_linear_velocity_scaling": ("false", "true"),
        "FollowPathPurePursuit.desired_linear_vel": (0.7, 0.5),
    }

    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        "stdbuf -oL timeout 600 ros2 action send_goal --feedback "
        "/follow_path nav2_msgs/action/FollowPath " + goal_yaml
    )

    # Everything below is slow (ros2 CLI param + action, several seconds each),
    # so it runs in a background thread to never block the MQTT command loop.
    # The finally block ALWAYS restores the default controller params, even if
    # the drive raises or times out.
    def _drive():
        for k, (relaxed, _default) in TRANSIT_PARAMS.items():
            _ros2_param_set(_NAV_NODE, k, relaxed)
        try:
            subprocess.run(["bash", "-c", cmd], env=_ros_env(),
                          capture_output=True, text=True, timeout=660)
        except Exception as e:
            log(f"follow_unicom run error: {e}")
        finally:
            for k, (_relaxed, default) in TRANSIT_PARAMS.items():
                _ros2_param_set(_NAV_NODE, k, default)
            log("follow_unicom: restored controller params to defaults")

    drive_thread = threading.Thread(target=_drive, daemon=True, name="follow-unicom")
    drive_thread.start()
    log(f"follow_unicom dispatched {map_from}->{map_to}: {len(pts)} pts "
        f"oriented={oriented} (threaded, relaxed controller)")
    return {
        "result": 0, "from": map_from, "to": map_to,
        "points": len(pts), "oriented": oriented, "dry_run": False,
        "relaxed_params": len(TRANSIT_PARAMS),
        "join": drive_thread.join,
    }


def handle_follow_unicom(params, respond):
    """MQTT-facing thin wrapper around _follow_unicom(). See that function's
    docstring for the full behavior; this only unpacks params and responds.

    Params:
      from:    source slot, default "map0"
      to:      target slot, e.g. "map3" (REQUIRED)
      dry_run: if true, build + return the path points but DO NOT move (for the
               pre-flight plot). Default false.

    Response follow_unicom_respond:
      {result:0, from, to, points, oriented, dry_run}         accepted / dry-run
      {result:1, error: invalid_map_name|no_unicom_X_Y|empty_unicom|not_localized}
    """
    r = _follow_unicom(str(params.get("from", "map0")), str(params.get("to", "")),
                       dry_run=bool(params.get("dry_run", False)))
    # "join" is a thread-join callable, not JSON-serializable; only the direct
    # in-process orchestrator (mow_zone) uses it. Strip it before responding.
    r.pop("join", None)
    respond("follow_unicom_respond", r)


def _point_in_poly(x, y, poly):
    """Ray-casting point-in-polygon test. poly is a list of (x, y) tuples."""
    n = len(poly); inside = False; j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _current_zone_slot(robot_xy):
    """Detect which zone slot the robot currently sits in, for the mow_zone
    orchestrator's transit-needed check (Task 4).

    Returns "mapN" for the first mapN_work.csv polygon (sorted by filename)
    that contains robot_xy, else "dock" when robot_xy is None or within the
    1.2 m dock disc around the origin, else "dock" as the safe default.
    """
    if robot_xy is None:
        return "dock"
    x, y = robot_xy
    if (x * x + y * y) <= 1.2 ** 2:          # dock disc
        return "dock"
    base = f"{MAPS_HOME}/x3_csv_file" if os.path.isdir(f"{MAPS_HOME}/x3_csv_file") else f"{MAPS_HOME}/csv_file"
    for f in sorted(os.listdir(base)):
        m = re.match(r"^(map\d+)_work\.csv$", f)
        if not m:
            continue
        poly = read_xy_csv(os.path.join(base, f))
        if len(poly) >= 3 and _point_in_poly(x, y, poly):
            return m.group(1)
    return "dock"


def _cov_task_yaml(map_ids, cutterhigh, direction):
    """Build the decision_msgs/srv/StartCoverageTask request YAML (pure,
    testable). This mirrors exactly what mqtt_node emits for a normal app mow
    (research/documents/multi-map-area-bitmask-decode.md):
      cov_mode:0 = NORMAL (select map(s) by id, NOT the polygon "draw area"
        mode which is cov_mode:1/SPECIFIED_AREA and needs polygon_area),
      request_type:11 = normal mqtt/app start,
      map_ids = the decimal positional bitmask (sum of 10^slot, e.g. map3
        -> 1000); robot_decision decodes it digit-by-digit into the maps.
    map_names stays EMPTY on purpose: robot_decision only consults map_names
    when map_ids==0, and then it resolves /userdata/lfi/maps/home0/<name> as a
    FILE and fails with Error 118 (the file does not exist under that name).
    blade_heights carries the 0..7 wire enum (user_cm - 2).
    specify_direction/cov_direction (0..180) are only set when a direction is
    given; specify_perception_level stays false to keep the device's setting.
    """
    d = "true" if direction is not None else "false"
    cd = int(direction) if direction is not None else 0
    return ("'{"
            "cov_mode: 0, request_type: 11, "
            f"map_ids: {int(map_ids)}, map_names: [], polygon_area: [], "
            f"blade_heights: [{int(cutterhigh)}], "
            f"specify_direction: {d}, cov_direction: {cd}, light: 0, "
            "specify_perception_level: false, perception_level: 0, "
            "blade_info_level: 0, night_light: false, "
            "enable_loc_weak_mapping: false, enable_loc_weak_working: false"
            "}'")


def _start_cov_task(map_ids, cutterhigh, direction):
    """Start coverage through /robot_decision/start_cov_task (NOT a direct
    NTCP call), so robot_decision keeps the work_status state machine and
    auto-recharge behavior. Returns True on an apparent success reply.
    """
    cmd = ("source /opt/ros/galactic/setup.bash && "
           "source /root/novabot/install/setup.bash 2>/dev/null && "
           "timeout 20 ros2 service call /robot_decision/start_cov_task "
           "decision_msgs/srv/StartCoverageTask " + _cov_task_yaml(map_ids, cutterhigh, direction))
    try:
        out = subprocess.run(["bash", "-c", cmd], env=_ros_env(),
                             capture_output=True, text=True, timeout=30).stdout
    except Exception as e:
        log(f"start_cov_task error: {e}"); return False
    return "result=True" in out or "result: true" in out.lower()


def handle_mow_zone(params, respond):
    """Orchestrate a normal mow: undock -> (follow_unicom if a transit is needed)
    -> coverage via /robot_decision/start_cov_task. Streams phase status so the
    app can show the following_unicom animation. Params: map (e.g. 'map3'),
    cutterhigh (0..7 wire enum), direction (0..180 or null)."""
    to_slot = str(params.get("map", ""))
    if not re.fullmatch(r"map\d+", to_slot):
        respond("mow_zone_status", {"phase": "error", "error": "invalid_map"}); return
    cutterhigh = int(params.get("cutterhigh", 2))
    direction = params.get("direction", None)
    # Zone selection uses map_ids (the decimal positional bitmask), NOT
    # map_names (map_names + map_ids:0 -> robot_decision Error 118). The app
    # already computes the same encoding as `area`; fall back to 10^slot for
    # the single target zone if it is absent.
    try:
        map_ids = int(params.get("area")) if params.get("area") else 10 ** int(re.sub(r"\D", "", to_slot))
    except (ValueError, TypeError):
        map_ids = 10 ** int(re.sub(r"\D", "", to_slot))

    # The whole undock -> follow_unicom -> coverage flow runs in ONE rclpy
    # process (mow_zone_drive.py): one DDS discovery instead of ~15 ros2-CLI
    # invocations (5-8s discovery each, and the `ros2 param set` calls timed
    # out so the speed relaxation never applied). That process streams a
    # "PHASE <name> [msg]" line per stage on stdout; we forward each as a
    # mow_zone_status so the app still gets the following_unicom animation.
    drive_script = "/root/novabot/scripts/mow_zone_drive.py"
    d_arg = str(int(direction)) if direction is not None else "-"
    # to_slot is already allowlisted (re.fullmatch map\d+ above) and the rest
    # are int()-coerced, so there is no injection vector. Still, pass every
    # value as argv (not string-interpolated into the shell) so shell
    # metacharacters could never escape even if validation regressed.
    wrapper = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        # SHM transport (inherited from _ros_env): the FollowPath action only
        # actually drives over shared memory; over the network transport nav2
        # accepts the goal but its control loop misses rate and aborts with
        # "Failed to make progress". mow_zone_drive.py keeps its shm footprint
        # tiny (throwaway tf-probe node, depth-1 pubs) so it no longer exhausts
        # the iceoryx pool.
        'exec stdbuf -oL python3 "$1" mow "$2" "$3" "$4" "$5"'
    )
    argv = ["bash", "-c", wrapper, "mow_zone", drive_script, to_slot,
            str(int(map_ids)), str(int(cutterhigh)), d_arg]

    def _run():
        try:
            proc = subprocess.Popen(argv, env=_ros_env(),
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("PHASE "):
                    parts = line.split(" ", 2)
                    ph = parts[1] if len(parts) > 1 else ""
                    msg = {"phase": ph, "map": to_slot}
                    if ph == "error" and len(parts) > 2:
                        msg["error"] = parts[2]
                    respond("mow_zone_status", msg)
                else:
                    log(f"mow_zone_drive: {line}")
            proc.wait()
        except Exception as e:
            log(f"mow_zone error: {e}")
            respond("mow_zone_status", {"phase": "error", "map": to_slot, "error": str(e)})

    threading.Thread(target=_run, daemon=True, name="mow-zone").start()
    respond("mow_zone_respond", {"result": 0, "map": to_slot})


def handle_return_to_dock(params, respond):
    """Follow the recorded unicom back to the dock, then dock. Mirror of
    mow_zone's outbound transit: the firmware's own auto-return (nav_to_recharge)
    is goal-based and cuts across the hedge, so it fails to bring the mower home
    from a far zone. mow_zone_drive.py return-mode walks the recorded unicom
    segments home, then triggers the visual auto_recharge. Runs in ONE rclpy
    process; streams a PHASE line per stage that we forward as
    return_to_dock_status."""
    drive_script = "/root/novabot/scripts/mow_zone_drive.py"
    wrapper = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        # SHM transport (see handle_mow_zone note); minimal footprint in the
        # script keeps it from exhausting the iceoryx pool.
        'exec stdbuf -oL python3 "$1" return'
    )
    argv = ["bash", "-c", wrapper, "return_to_dock", drive_script]

    def _run():
        try:
            proc = subprocess.Popen(argv, env=_ros_env(),
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("PHASE "):
                    parts = line.split(" ", 2)
                    ph = parts[1] if len(parts) > 1 else ""
                    msg = {"phase": ph}
                    if ph == "error" and len(parts) > 2:
                        msg["error"] = parts[2]
                    respond("return_to_dock_status", msg)
                else:
                    log(f"return_to_dock: {line}")
            proc.wait()
        except Exception as e:
            log(f"return_to_dock error: {e}")
            respond("return_to_dock_status", {"phase": "error", "error": str(e)})

    threading.Thread(target=_run, daemon=True, name="return-to-dock").start()
    respond("return_to_dock_respond", {"result": 0})


def handle_start_edge_cut(params, respond):
    """Start edge-cutting via /navigate_through_coverage_paths action.

    Single dispatch, verified live on LFIN1231000211 2026-04-24:
      `coverage_planner/action/NavigateThroughCoveragePaths` with
      `only_edge_mode:true` + `include_edge:true` +
      `coverage_type:0` (COVERAGE_BY_FILE) + the map yaml.

    coverage_planner internally plans the full cover paths, then the
    `only_edge_mode` branch discards the fill paths and keeps only the
    boundary rings. It logs:
      "Only edge mode, only covering boundary path !!!!"
      "Current work status: BOUNDARY_COVERING"
      "Setting blade height to : <blade_mm>"
    and drives nav2 FollowPath segment-by-segment along the polygon.

    The other paths we tried (all dead ends — see
    research/documents/edge-cut-flow.md):
      - /robot_decision/start_cov_task cov_mode:2 silently falls through
        to normal COVERING.
      - MQTT start_patrol is a JSON-echo stub in mqtt_node, no ROS call.
      - /robot_decision/start_assistant_mapping gates on work_status
        0x82/0x83/0x8d/0x8e, only reachable via the destructive
        start_scan_map flow.
      - Direct /boundary_follow action uses the local costmap, not the
        saved polygon — aborts "No valid boundary need robot!!!" unless
        the robot is already next to lethal cells the planner can latch.

    Params (all optional):
      mapName:      map base name (no extension). Default "map0".
                    Path built as /userdata/lfi/maps/home0/<name>.yaml.
                    Whitelisted to `[A-Za-z0-9_-]+` to avoid shell
                    injection (flows into the action goal YAML).
      bladeHeight:  NTCP goal `blade_height` in mm. Default 40 mm
                    (= 4 cm). Clamped to 20..90 here; coverage_planner
                    itself also clamps anything <20mm.

    Response:
      accepted → {result: 0, map: <name>, blade_mm: <h>}
      bad param → {result: 1, error: "invalid_map_name" | "param type error"}
      dispatch error → {result: 1, error: "dispatch_failed: ..."}

    Notes:
      - The action runs long (up to the 1800 s internal timeout). We
        fire-and-forget via Popen so MQTT responds promptly. Completion
        status and mower motion lands in /tmp/edge_cut.log.
      - `reset_coverage_map:true` drops any prior normal-coverage progress.
        If we ever want edge as a finishing pass, expose a
        `resetCoverage` param to flip it.
      - Stop path stays on `stop_boundary_follow` →
        /coverage_planner_server/cover_task_stop, which cancels NTCP the
        same way it cancels BoundaryFollow.
    """
    # Safe non-blocking cleanup: clear any stale obstacle observations
    # in the nav2 costmaps so the edge planner doesn't inherit false
    # blockers from a prior run. Do NOT call cover_task_stop here — it
    # races with any in-flight task state transitions.
    _clear_costmaps()

    try:
        map_name = str((params or {}).get("mapName", "map0"))
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", map_name):
            respond("start_edge_cut_respond", {"result": 1, "error": "invalid_map_name"})
            return
        blade_mm = int((params or {}).get("bladeHeight", 40))
        if blade_mm < 20: blade_mm = 20
        if blade_mm > 90: blade_mm = 90
        depart_from_dock = bool((params or {}).get("departFromDock", False))
    except (TypeError, ValueError) as e:
        respond("start_edge_cut_respond", {"result": 1, "error": f"param type error: {e}"})
        return

    # Mirror the stock start_cov_task preamble: when launching from the
    # dock, drive ~1m back so NTCP can plan from a free pose. The app
    # only sets departFromDock=true when activity=charging — keeps a
    # mid-lawn re-trigger from blindly reversing into an obstacle.
    if depart_from_dock:
        _depart_pile()

    map_yaml = f"/userdata/lfi/maps/home0/{map_name}.yaml"

    # NTCP goal — single YAML string for ros2 action send_goal CLI.
    # Fields that differ from the "normal mow" goal: only_edge_mode=true
    # and include_edge=true (both required — include_edge enables the
    # edge planner to run, only_edge_mode tells it to drop the fill).
    goal_yaml = (
        "'{"
        f"map_yaml: \"{map_yaml}\", "
        "coverage_type: 0, "
        "reset_coverage_map: true, "
        "return_to_start: false, "
        "ignore_start_for_planning: false, "
        "disable_recover: false, "
        "enable_tf_action_abort_as_stop: false, "
        "include_edge: true, "
        "mixed_edge: false, "
        "setting_blade_height: true, "
        f"blade_height: {blade_mm}, "
        "grass_height: 0, "
        "auto_repeat_num: false, "
        "target_repeat_times: 1, "
        "debug_mode: false, "
        "adaptive_mode: 1, "
        "specify_direction: false, "
        "cov_direction: 0, "
        "only_edge_mode: true, "
        "enable_check_walkable: false, "
        "back_avoid_mode: false, "
        "test_long_length: 0.0, "
        "test_short_length: 0.0"
        "}'"
    )

    # `--feedback` emits Feedback: blocks as they arrive, which we parse in
    # a background thread to relay to the app via extended_response MQTT.
    # stdbuf -oL forces the ros2 CLI to line-buffer its stdout — without it,
    # Python blocks buffers the whole stream and we only see feedback after
    # the action finishes (observed live 2026-04-24 — only 2-3 events during
    # a 4-min session instead of 80+).
    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        "exec stdbuf -oL timeout 1800 ros2 action send_goal --feedback "
        "/navigate_through_coverage_paths "
        "coverage_planner/action/NavigateThroughCoveragePaths " + goal_yaml
    )

    # Match the shared-memory DDS transport the ROS nodes use — without
    # CYCLONEDDS_URI pointing at shm_cyclonedds.xml the CLI client cannot
    # discover /navigate_through_coverage_paths.
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0",
        "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }

    try:
        proc = subprocess.Popen(
            ["bash", "-c", cmd], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
    except Exception as e:
        log(f"start_edge_cut dispatch error: {e}")
        respond("start_edge_cut_respond", {"result": 1, "error": f"dispatch_failed: {e}"})
        return

    log(f"start_edge_cut dispatched: map={map_name} blade={blade_mm}mm pid={proc.pid}")
    respond("start_edge_cut_respond", {
        "result": 0,
        "map": map_name,
        "blade_mm": blade_mm,
    })
    # Start the running-state event so the app can flip activity → edge_cutting
    # immediately (don't wait for first Feedback block, which can lag ~2s).
    respond("edge_cut_status", {
        "active": True,
        "work_status": 150,  # BOUNDARY_COVERING — optimistic
        "covered_ratio": 0.0,
        "task_covered_area": 0.0,
        "task_planned_area": 0.0,
    })

    # Monitor thread: parse ros2 action send_goal output.
    # The CLI emits blocks like:
    #   Feedback:
    #       work_status: 150
    #       covered_ratio: 0.0
    #       ...
    #   Result:
    #       result_status: 100
    #       ...
    def _monitor_edge_cut(p, log_path="/tmp/edge_cut.log"):
        import re as _re
        last_pub = 0.0
        cur_work_status = 150
        cur_ratio = 0.0
        cur_task_covered = 0.0
        cur_task_planned = 0.0
        in_feedback = False
        in_result = False
        result_status = None
        try:
            with open(log_path, "a") as lf:
                assert p.stdout is not None
                for line in p.stdout:
                    lf.write(line)
                    lf.flush()
                    stripped = line.strip()
                    if stripped == "Feedback:":
                        in_feedback, in_result = True, False
                        continue
                    if stripped == "Result:":
                        in_feedback, in_result = False, True
                        continue
                    if not stripped or stripped.startswith("Goal"):
                        continue
                    kv = _re.match(r"([a-zA-Z_]+):\s*(.+)", stripped)
                    if not kv:
                        continue
                    key, val = kv.group(1), kv.group(2).strip()
                    if in_feedback:
                        try:
                            if key == "work_status":
                                cur_work_status = int(val)
                            elif key == "covered_ratio":
                                cur_ratio = float(val)
                            elif key == "task_covered_area":
                                cur_task_covered = float(val)
                            elif key == "task_planned_area":
                                cur_task_planned = float(val)
                        except ValueError:
                            pass
                        # End-of-block trigger: the CLI prints fields in a
                        # fixed order and `finished_times` is the last one
                        # we see. Rate-limit to ~1 Hz; the CLI bursts feedback
                        # every 2-3s anyway.
                        now = time.monotonic()
                        if key == "finished_times" and (now - last_pub) > 1.0:
                            respond("edge_cut_status", {
                                "active": True,
                                "work_status": cur_work_status,
                                "covered_ratio": round(cur_ratio, 3),
                                "task_covered_area": round(cur_task_covered, 2),
                                "task_planned_area": round(cur_task_planned, 2),
                            })
                            last_pub = now
                    elif in_result:
                        if key == "result_status":
                            try:
                                result_status = int(val)
                            except ValueError:
                                pass
                p.wait(timeout=5)
        except Exception as e:
            log(f"edge_cut monitor error: {e}")
        finally:
            respond("edge_cut_status", {
                "active": False,
                "work_status": 0,
                "covered_ratio": round(cur_ratio, 3),
                "task_covered_area": round(cur_task_covered, 2),
                "task_planned_area": round(cur_task_planned, 2),
                "result_status": result_status,
                "exit_code": p.returncode,
            })
            log(f"edge_cut monitor end: result_status={result_status} exit={p.returncode}")

    threading.Thread(
        target=_monitor_edge_cut, args=(proc,),
        daemon=True, name="edge-cut-monitor",
    ).start()


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
    json_targets = [f"{base}/csv_file/map_info.json", f"{base}/x3_csv_file/map_info.json"]
    # auto_recharge_server reads the dock pose from this YAML at startup AND
    # whenever it re-arms after a docking attempt. Without rewriting it the
    # robot keeps driving toward the stale pose even though both map_info.json
    # files already point at the new one — that's the "edit only takes effect
    # after we change another file too" symptom.
    yaml_target = "/userdata/lfi/charging_station_file/charging_station.yaml"

    updated = {}
    try:
        for path in json_targets:
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

        if os.path.exists(yaml_target) or os.path.isdir(os.path.dirname(yaml_target)):
            try:
                os.makedirs(os.path.dirname(yaml_target), exist_ok=True)
                tmp = yaml_target + ".tmp"
                with open(tmp, "w") as f:
                    f.write(f"charging_pose: [{x}, {y}, {theta}]\n")
                os.replace(tmp, yaml_target)
                updated[yaml_target] = {"x": x, "y": y, "orientation": theta}
            except Exception as e:
                log(f"recalibrate_charging_pose: yaml write failed: {e}")

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


def handle_read_map_files(params, respond):
    """Return ALL mower-side files needed for a full state restore.

    Captures the canonical on-disk state so a same-mower verbatim restore is
    deterministic. Without these, the older bundle shape (csv_file/ +
    charging_station.yaml only) couldn't bring back the UTM anchor or the
    Nav2 occupancy grids — and `write_map_files` had to fudge them.

    Captured (response payload):
      csv_files            {filename: text}   from /userdata/lfi/maps/<home>/csv_file/
      charging_station_yaml string             from /userdata/lfi/charging_station_file/
      pos_json             text or null        /userdata/pos.json — UTM origin anchor
      map_files_text       {filename: text}    *.yaml under maps/<home>/ (map.yaml,
                                                mapN.yaml — all per-slot YAMLs)
      map_files_b64        {filename: b64}     *.pgm + *.png under maps/<home>/
                                                (binary, base64 so it fits JSON)

    The map.yaml/pgm/png files are the whole-area occupancy grid; the
    mapN.yaml/pgm/png are per-slot copies (one per work map). Without the
    pgm Nav2 has no costmap → coverage_planner Error 107/118.

    Optional params:
      home: str — home dir under /userdata/lfi/maps. Default "home0".

    Response:
      result:0, home, csv_files, charging_station_yaml, pos_json,
      map_files_text, map_files_b64
    """
    import base64 as _b64
    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    base = f"/userdata/lfi/maps/{home}/csv_file"
    files = {}
    try:
        if not os.path.isdir(base):
            respond("read_map_files_respond", {"result": 1, "error": f"csv_file dir missing: {base}"})
            return
        for fname in sorted(os.listdir(base)):
            full = os.path.join(base, fname)
            if not os.path.isfile(full):
                continue
            with open(full) as f:
                files[fname] = f.read()

        # charging_station.yaml
        yaml_path = "/userdata/lfi/charging_station_file/charging_station.yaml"
        cs_yaml = ""
        if os.path.exists(yaml_path):
            with open(yaml_path) as f:
                cs_yaml = f.read()

        # pos.json — UTM origin anchor. Without this the local frame's
        # world coordinate is undefined. A bundle without pos.json can only
        # be safely restored when the mower's current pos.json already
        # matches the one in effect when the bundle was made.
        pos_json = None
        pj_path = "/userdata/pos.json"
        if os.path.exists(pj_path):
            try:
                with open(pj_path) as f:
                    pos_json = f.read()
            except Exception as e:
                log(f"read_map_files: pos.json read failed (continuing): {e}")

        # map.yaml / mapN.yaml — text. map.pgm / map.png / mapN.pgm /
        # mapN.png — binary, base64. Splitting by extension keeps the
        # response payload directly inspectable on the server side for
        # the text files.
        home_dir = f"/userdata/lfi/maps/{home}"
        map_files_text = {}
        map_files_b64 = {}
        try:
            for fname in sorted(os.listdir(home_dir)):
                full = os.path.join(home_dir, fname)
                if not os.path.isfile(full):
                    continue
                if fname.endswith(".yaml"):
                    with open(full) as f:
                        map_files_text[fname] = f.read()
                elif fname.endswith(".pgm") or fname.endswith(".png"):
                    with open(full, "rb") as f:
                        map_files_b64[fname] = _b64.b64encode(f.read()).decode("ascii")
        except Exception as e:
            log(f"read_map_files: home_dir scan failed (continuing): {e}")

        log(f"read_map_files: {len(files)} csv files, charging_station.yaml={'yes' if cs_yaml else 'no'}, "
            f"pos.json={'yes' if pos_json else 'no'}, map_text={len(map_files_text)}, map_bin={len(map_files_b64)}")
        respond("read_map_files_respond", {
            "result": 0,
            "home": home,
            "csv_files": files,
            "charging_station_yaml": cs_yaml,
            "pos_json": pos_json,
            "map_files_text": map_files_text,
            "map_files_b64": map_files_b64,
        })
    except Exception as e:
        log(f"read_map_files error: {e}")
        respond("read_map_files_respond", {"result": 1, "error": str(e)})


def handle_write_map_files(params, respond):
    """Write provided map files to home0/csv_file + x3_csv_file (+ charging_station.yaml).

    Mirror of read_map_files. The server transforms polygon points (Δ rotation
    + translation) on its side then ships the resulting CSVs verbatim back to
    the mower so what's on disk matches the new local frame exactly. We write
    to BOTH csv_file/ AND x3_csv_file/ because firmware reads from both
    depending on the code path.

    Existing charging_station.yaml is backed up to .bak.<timestamp> before
    overwriting so user can recover if needed.

    Required params:
      csv_files: object {filename: content_string}

    Optional:
      home: str — default "home0"
      charging_station_yaml: string — single-line yaml content. Skipped if absent.

    Response:
      result:0, written: [paths], home
    """
    import base64 as _b64
    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    csv_files = (params or {}).get("csv_files", {})
    cs_yaml = (params or {}).get("charging_station_yaml")
    pos_json = (params or {}).get("pos_json")              # text content or null
    map_files_text = (params or {}).get("map_files_text", {})  # {fname: text}
    map_files_b64 = (params or {}).get("map_files_b64", {})    # {fname: base64}

    if not isinstance(csv_files, dict) or not csv_files:
        respond("write_map_files_respond", {"result": 1, "error": "csv_files object required"})
        return

    base = f"/userdata/lfi/maps/{home}"
    written = []
    try:
        # Whitelist filenames — must match firmware's expected pattern.
        # Allow alphanum + underscore + dot; reject anything path-like to
        # prevent traversal.
        for fname in csv_files.keys():
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", fname):
                respond("write_map_files_respond", {"result": 1, "error": f"invalid filename: {fname}"})
                return
            if ".." in fname or fname.startswith("/"):
                respond("write_map_files_respond", {"result": 1, "error": f"invalid filename: {fname}"})
                return

        # SAFETY: snapshot the whole existing map dir BEFORE we wipe/overwrite
        # anything. The wipe below clears csv_file/ + x3_csv_file/ and the
        # rasters get overwritten — all irreversible. If a restore ships a bad
        # map (server-side validation is the first gate; this is the on-device
        # net), the user's working map is recoverable from home0.bak.<ts>/.
        # Keep the newest few snapshots; prune the rest.
        try:
            import shutil as _shutil_snap
            if os.path.isdir(base) and os.listdir(base):
                snap = f"{base}.bak.{int(time.time())}"
                if not os.path.exists(snap):
                    _shutil_snap.copytree(base, snap)
                    log(f"write_map_files: pre-wipe snapshot -> {snap}")
                parent = os.path.dirname(base)
                prefix = os.path.basename(base) + ".bak."
                snaps = sorted(d for d in os.listdir(parent) if d.startswith(prefix))
                for stale in snaps[:-3]:
                    try:
                        _shutil_snap.rmtree(os.path.join(parent, stale))
                    except Exception:
                        pass
        except Exception as e:
            log(f"write_map_files: pre-wipe snapshot failed (continuing): {e}")

        # Inter-map / dock connectors (`mapXtomapY_..._unicom.csv`,
        # `mapXtocharge_unicom.csv`) record zone CONNECTIVITY. For touching zones
        # they are tiny / metadata-only and are NOT in the server's DB-sourced set,
        # so the bare wipe below silently dropped them on every restore/sync and
        # disconnected the zones — root cause of "the channels keep disappearing"
        # (2026-06-29; the stock firmware / Novabot app never wipe like this). Keep
        # any connector the caller didn't provide AS LONG AS both maps it links
        # still exist after the write (else it's orphaned -> let it go).
        surviving_slots = set()
        for k in csv_files:
            mm = re.match(r"^map(\d+)_work\.csv$", k)
            if mm:
                surviving_slots.add(mm.group(1))

        def _connector_survives(fname):
            m = re.match(r"^map(\d+)to(?:map(\d+)|charge)", fname)
            if not m or m.group(1) not in surviving_slots:
                return False
            return m.group(2) is None or m.group(2) in surviving_slots

        for sub in ("csv_file", "x3_csv_file"):
            d = f"{base}/{sub}"
            os.makedirs(d, exist_ok=True)
            # Capture connectors to preserve BEFORE wiping.
            preserved = {}
            for old in os.listdir(d):
                op = os.path.join(d, old)
                if (os.path.isfile(op) and old.endswith("_unicom.csv")
                        and old not in csv_files and _connector_survives(old)):
                    try:
                        with open(op) as fh:
                            preserved[old] = fh.read()
                    except OSError:
                        pass
            # Wipe existing files in this dir so old polygon data doesn't
            # bleed into new state (e.g. obsolete obstacles staying behind).
            for old in os.listdir(d):
                old_path = os.path.join(d, old)
                if os.path.isfile(old_path):
                    os.remove(old_path)
            for fname, content in csv_files.items():
                full = os.path.join(d, fname)
                with open(full, "w") as f:
                    f.write(content)
                written.append(full)
            # Restore the connectors the caller didn't include.
            for fname, content in preserved.items():
                full = os.path.join(d, fname)
                with open(full, "w") as f:
                    f.write(content)
                written.append(full)
                log(f"write_map_files: preserved connector {sub}/{fname} (not in provided set)")

        if isinstance(cs_yaml, str) and cs_yaml.strip():
            yaml_dir = "/userdata/lfi/charging_station_file"
            os.makedirs(yaml_dir, exist_ok=True)
            yaml_path = os.path.join(yaml_dir, "charging_station.yaml")
            if os.path.exists(yaml_path):
                ts = int(time.time())
                bak = f"{yaml_path}.bak.{ts}"
                try:
                    import shutil as _shutil
                    _shutil.copyfile(yaml_path, bak)
                except Exception as e:
                    log(f"write_map_files: charging_station backup failed (continuing): {e}")
            with open(yaml_path, "w") as f:
                f.write(cs_yaml)
            written.append(yaml_path)

        # pos.json — UTM origin anchor. Critical: this changes the local
        # frame's world coordinate. Only write when explicitly provided AND
        # caller has determined the bundle is from the same physical mower.
        # Always back up existing pos.json before overwriting.
        if isinstance(pos_json, str) and pos_json.strip():
            pj_path = "/userdata/pos.json"
            if os.path.exists(pj_path):
                ts = int(time.time())
                bak = f"{pj_path}.bak.{ts}"
                try:
                    import shutil as _shutil
                    _shutil.copyfile(pj_path, bak)
                    log(f"write_map_files: pos.json backed up to {bak}")
                except Exception as e:
                    log(f"write_map_files: pos.json backup failed (continuing): {e}")
            with open(pj_path, "w") as f:
                f.write(pos_json)
            written.append(pj_path)
            log("write_map_files: pos.json restored (UTM anchor)")

        # Whole-area + per-slot map.yaml/pgm/png — when caller ships these
        # explicitly we skip the auto-mirror fallback below. These files
        # define the Nav2 costmap; without them coverage_planner aborts
        # with Error 107/118.
        explicit_map_files = False
        if (isinstance(map_files_text, dict) and map_files_text) or \
           (isinstance(map_files_b64, dict) and map_files_b64):
            explicit_map_files = True
            for fname, content in (map_files_text or {}).items():
                if not re.fullmatch(r"[A-Za-z0-9_.-]+", fname): continue
                if not fname.endswith(".yaml"): continue
                p = f"{base}/{fname}"
                with open(p, "w") as f:
                    f.write(content)
                written.append(p)
            for fname, b64 in (map_files_b64 or {}).items():
                if not re.fullmatch(r"[A-Za-z0-9_.-]+", fname): continue
                if not (fname.endswith(".pgm") or fname.endswith(".png")): continue
                try:
                    raw = _b64.b64decode(b64)
                except Exception as e:
                    log(f"write_map_files: skip {fname} (bad base64): {e}")
                    continue
                p = f"{base}/{fname}"
                with open(p, "wb") as f:
                    f.write(raw)
                written.append(p)
            log(f"write_map_files: explicit map files: {len(map_files_text or {})} yaml, {len(map_files_b64 or {})} binary")

        # Per-map yaml/pgm/png — firmware looks for `map<N>.yaml` (etc.)
        # when planning navigation per work-area. The mapping-node normally
        # produces these during `save_map type:0` inside an active mapping
        # session; recovery flows (sync_map / write_map_files / DB restore)
        # never go through that path so the per-map artifacts are missing
        # and `start_navigation` returns Error 107 "Loading map failed,
        # please check mapN file exists!!". Mirror the whole-area
        # `map.yaml`/`map.pgm`/`map.png` to every work-map slot present
        # in the freshly-written csv_file/ so every map<N>.yaml resolves
        # to a real file. The image: field is rewritten so each yaml
        # points at its own pgm copy.
        if explicit_map_files:
            log("write_map_files: skipping auto-mirror — explicit map files provided")
        else:
            try:
                import re as _re
                whole_yaml = f"{base}/map.yaml"
                whole_pgm = f"{base}/map.pgm"
                whole_png = f"{base}/map.png"
                if os.path.exists(whole_yaml) and os.path.exists(whole_pgm):
                    # Distinct work-map slots present in the newly-written CSV
                    # set — `map3_work.csv`, `map3.csv`, `map3_0_obstacle.csv`
                    # all collapse to slot "map3".
                    slots = set()
                    for fname in csv_files.keys():
                        m = _re.match(r"^(map\d+)", fname)
                        if m:
                            slots.add(m.group(1))
                    with open(whole_yaml, "r") as f:
                        whole_yaml_content = f.read()
                    for slot in slots:
                        slot_yaml = f"{base}/{slot}.yaml"
                        slot_pgm = f"{base}/{slot}.pgm"
                        slot_png = f"{base}/{slot}.png"
                        rewritten = _re.sub(
                            r"^image:\s*map\.pgm\s*$",
                            f"image: {slot}.pgm",
                            whole_yaml_content,
                            flags=_re.MULTILINE,
                        )
                        with open(slot_yaml, "w") as f:
                            f.write(rewritten)
                        import shutil as _shutil2
                        _shutil2.copyfile(whole_pgm, slot_pgm)
                        if os.path.exists(whole_png):
                            _shutil2.copyfile(whole_png, slot_png)
                        written.extend([slot_yaml, slot_pgm, slot_png])
                    if slots:
                        log(f"write_map_files: mirrored map.yaml/pgm/png to {len(slots)} per-map slots: {sorted(slots)}")
                else:
                    log(f"write_map_files: whole-area map.yaml/pgm missing — skipping per-map mirror (recovery callers should trigger save_map type:1 first)")
            except Exception as e:
                log(f"write_map_files: per-map mirror failed (non-fatal): {e}")

        # Restart novabot_mapping so the freshly-written CSVs are loaded
        # into memory. Without this, coverage_planner reads the previously
        # cached polygon and the new map only takes effect on next mower
        # boot. Same pattern as sync_map's _restart_novabot_mapping.
        restart_ok = None
        if (params or {}).get("restart_mapping", True):
            try:
                restart_ok = _restart_novabot_mapping()
            except Exception as e:
                log(f"write_map_files: novabot_mapping restart failed: {e}")
                restart_ok = False

        log(f"write_map_files: wrote {len(written)} files (home={home}) restart={restart_ok}")
        respond("write_map_files_respond", {
            "result": 0,
            "home": home,
            "written": written,
            "novabot_mapping_restarted": restart_ok,
        })
    except Exception as e:
        log(f"write_map_files error: {e}")
        respond("write_map_files_respond", {"result": 1, "error": str(e)})


SEAM_FIX_CONFIG = "/userdata/lfi/seam_fix.json"   # shared with seam_fix_daemon.py


def _read_seam_fix_config():
    """(enabled, edge_margin_cm) from SEAM_FIX_CONFIG. Absent/garbled -> (False, 0):
    opt-in default, so a mower without the app toggle set keeps the legacy behaviour."""
    try:
        with open(SEAM_FIX_CONFIG) as fh:
            c = json.load(fh)
        return bool(c.get("enabled", False)), float(c.get("edge_margin_cm", 0))
    except Exception:
        return False, 0.0


def handle_set_seam_fix(params, respond):
    """App/server -> persist border seam-fix config to /userdata (survives firmware
    upgrades). The seam_fix_daemon re-reads it live; regenerate reads it too."""
    try:
        enabled = bool(params.get("enabled", False))
        margin = max(0.0, min(30.0, float(params.get("edge_margin_cm", 0))))  # clamp 0..30 cm
        os.makedirs(os.path.dirname(SEAM_FIX_CONFIG), exist_ok=True)
        tmp = SEAM_FIX_CONFIG + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"enabled": enabled, "edge_margin_cm": margin}, fh)
        os.replace(tmp, SEAM_FIX_CONFIG)
        log(f"set_seam_fix: enabled={enabled} edge_margin_cm={margin}")
        respond("set_seam_fix_respond", {"result": 0, "enabled": enabled, "edge_margin_cm": margin})
    except Exception as e:
        log(f"set_seam_fix error: {e}")
        respond("set_seam_fix_respond", {"result": 1, "error": str(e)})


def handle_get_seam_fix(params, respond):
    enabled, margin = _read_seam_fix_config()
    respond("get_seam_fix_respond", {"result": 0, "enabled": enabled, "edge_margin_cm": margin})


def handle_regenerate_per_map_files(params, respond):
    """Generate per-map occupancy grids map<N>.yaml/pgm/png by MASKING the
    whole-area map.pgm to each slot's own mowable region.

    Mapping-node's `save_map type:1` produces only the whole-area triple
    (`map.yaml/pgm/png`). Per-map artifacts (`map0.yaml`, `map1.yaml`, ...) are
    only emitted by `save_map type:0`, which recovery / sync flows never run, so
    they go missing and start_navigation returns Error 107 ("Loading map failed,
    please check mapN file exists"). This handler synthesizes them.

    HISTORY / WHY MASK (not copy): until custom-30 this copied the whole-area
    map.pgm verbatim to every slot, so map0.pgm == map1.pgm == map.pgm. The
    coverage_planner_server plans coverage ON this pgm ("No coverage map, using
    obstacle map to plan") — it is NOT just a Nav2 costmap as the old comment
    assumed. With identical whole-area pgms, a single-zone task (e.g. only the
    voortuin) covered the WHOLE property and the mower drove across the other
    zone into obstacles. Confirmed live on LFIN2230700238: map0 -> 190 m2
    (correct, the dock sits inside map0 so coverage stays bounded) but map1 ->
    321 m2 (= both zones).

    Fix: for each slot keep FREE only that slot's work polygon (slightly
    inflated) plus every unicom corridor and the dock vicinity, and set
    everything else OCCUPIED. Coverage then stays inside the selected zone.
    Navigation is unaffected: nav2's map_server loads the whole map.yaml
    separately; only the coverage planner reads the per-map yaml.

    Optional params:
      home: str — default "home0"

    Response:
      result:0, mirrored:[slot...], skipped_reason:str|null
    """
    import numpy as np
    from PIL import Image, ImageDraw

    OCCUPIED = 0
    INFLATE_M = 0.6      # keep this much extra around each work polygon (the
                         # whole-map free region is the polygon offset ~0.5 m, so
                         # masking by the bare polygon would clip the edge)
    UNICOM_W_M = 1.4     # unicom corridor width kept free (>= unicom inflation,
                         # preserves dock<->zone connectivity for the planner)
    DOCK_R_M = 0.8       # free disc kept around the charging pose
    OBSTACLE_INFLATE_M = 0.10  # min thickness when punching obstacles occupied,
                               # so even a tiny mapped obstacle leaves a mark at
                               # the grid resolution (nav2's costmap adds the
                               # robot-radius clearance on top at runtime)

    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    base = f"/userdata/lfi/maps/{home}"
    csv_dir = f"{base}/csv_file"
    whole_yaml = f"{base}/map.yaml"
    whole_pgm = f"{base}/map.pgm"

    try:
        if not os.path.exists(whole_yaml) or not os.path.exists(whole_pgm):
            respond("regenerate_per_map_files_respond", {
                "result": 1,
                "error": "whole-area map.yaml / map.pgm missing — call save_map type:1 first",
            })
            return
        if not os.path.isdir(csv_dir):
            respond("regenerate_per_map_files_respond", {"result": 1, "error": f"{csv_dir} not found"})
            return

        try:
            res, ox, oy, whole_yaml_content = parse_map_yaml(whole_yaml)
        except ValueError as e:
            respond("regenerate_per_map_files_respond", {"result": 1, "error": str(e)})
            return

        whole = np.array(Image.open(whole_pgm).convert("L"), dtype=np.uint8)  # (H, W)
        H, W = whole.shape
        to_px = make_to_px(ox, oy, res, H)

        # discover work slots + every unicom polyline + every obstacle polygon
        slots = set()
        unicom_files = []
        obstacle_files = []
        for fname in os.listdir(csv_dir):
            m = re.match(r"^(map\d+)_work\.csv$", fname)
            if m:
                slots.add(m.group(1))
            if fname.endswith("_unicom.csv"):
                unicom_files.append(fname)
            if re.match(r"^map\d+_\d+_obstacle\.csv$", fname):
                obstacle_files.append(fname)
        if not slots:
            respond("regenerate_per_map_files_respond", {
                "result": 0, "mirrored": [], "skipped_reason": "no map<N>_work.csv in csv_file/",
            })
            return

        # Seam-fix the in-memory `whole` grid BEFORE masking so every per-slot
        # pgm is born CLEAN even if `whole` on disk still carries the firmware's
        # occupied-inside-lawn stripe. map_generator.cpp re-adds that stripe on
        # every updateMonitorMapData (proven: occupied cells inside covered lawn,
        # in NO csv). The per-slot pgms — what the coverage planner plans on —
        # are written ONLY here, so cleaning `whole` here makes them never
        # striped, closing the race a post-hoc daemon loses at task start (mower
        # mowed up to the stripe and returned). Rule: an occupied cell strictly
        # inside a work polygon and not a mapped obstacle must be free. Talud-
        # safe: raw (un-inflated) work polygons only, nothing outside is touched.
        _lawn = Image.new("L", (W, H), 0)
        _ld = ImageDraw.Draw(_lawn)
        for _sn in sorted(slots):
            _wp = read_xy_csv(f"{csv_dir}/{_sn}_work.csv")
            if len(_wp) >= 3:
                _ld.polygon([to_px(x, y) for (x, y) in _wp], fill=255)
        _lawn_mask = np.array(_lawn) > 0
        _obs_img = Image.new("L", (W, H), 0)
        _od = ImageDraw.Draw(_obs_img)
        _obw = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
        for _of in obstacle_files:
            _op = [to_px(x, y) for (x, y) in read_xy_csv(f"{csv_dir}/{_of}")]
            if len(_op) >= 3:
                _od.polygon(_op, fill=255, outline=255)
                _od.line(_op + [_op[0]], fill=255, width=_obw, joint="curve")
        _obs_mask = np.array(_obs_img) > 0
        _seam = (whole < 128) & _lawn_mask & (~_obs_mask)
        _nseam = int(_seam.sum())
        if _nseam:
            whole[_seam] = np.uint8(254)
            log(f"regenerate_per_map_files: seam-fix freed {_nseam} occupied cell(s) inside lawn before masking")

        # An obstacle must ALWAYS be occupied — including in the NAV map
        # (map.pgm), which nav2 loads as its global costmap. The per-slot loop
        # below force-occupies each slot's OWN obstacles into mapN.pgm, but nav2
        # navigates (recovery, go-to-charge, transit) on map.pgm — so an obstacle
        # the firmware never baked there was driven straight through. Force EVERY
        # mapped obstacle OCCUPIED in `whole` here, then write map.pgm back: it
        # lands in both the nav map AND every per-slot grid (those derive from
        # `whole`). Verified 2026-06-22 on LFIN2231000633: firebowl was free in
        # map.pgm but occupied in mapN.pgm → nav2 drove through it.
        _nobs = int(_obs_mask.sum())
        if _nobs:
            whole[_obs_mask] = np.uint8(OCCUPIED)
            try:
                with open(f"{base}/map.pgm", "wb") as fh:
                    fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
                    fh.write(whole.tobytes())
                Image.fromarray(whole, mode="L").save(f"{base}/map.png")
                log(f"regenerate_per_map_files: baked {_nobs} obstacle cell(s) OCCUPIED into nav map.pgm")
            except Exception as ex:
                log(f"regenerate_per_map_files: map.pgm obstacle-bake write failed: {ex}")

        # Which unicoms connect to a given slot? `map<X>to<Y>_..._unicom`: the two
        # endpoints are map<X> and <Y> (<Y> = "map<M>" or "charge"). A slot owns a
        # unicom when it is either endpoint, so the slot keeps its own corridor(s)
        # free (connectivity) without inheriting other zones' dock strips.
        def unicoms_for(slot):
            out = []
            for uf in unicom_files:
                mm = re.match(r"^(map\d+)to(map\d+|charge)", uf)
                if not mm:
                    continue
                if mm.group(1) == slot or mm.group(2) == slot:
                    up = [to_px(x, y) for (x, y) in read_xy_csv(f"{csv_dir}/{uf}")]
                    if len(up) >= 2:
                        out.append(up)
            return out

        # This slot's mapped obstacles (`map<N>_<M>_obstacle.csv`). They MUST be
        # forced OCCUPIED in the per-map pgm: the coverage planner plans on this
        # grid, and masking only preserves whatever the whole-area map.pgm had.
        # An obstacle drawn/edited after the original mapping (or any map.pgm that
        # never baked it in) would otherwise be invisible and the mower plans
        # straight through it (issue #93).
        def obstacles_for(slot):
            out = []
            for of in obstacle_files:
                if re.match(rf"^{slot}_\d+_obstacle\.csv$", of):
                    op = [to_px(x, y) for (x, y) in read_xy_csv(f"{csv_dir}/{of}")]
                    if len(op) >= 3:
                        out.append(op)
            return out

        # dock vicinity (kept free so the start cell is navigable)
        dock_px = None
        cs = f"{base}/charging_station_file/charging_station.yaml"
        if os.path.exists(cs):
            cm = re.search(r"charging_pose:\s*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)", open(cs).read())
            if cm:
                dock_px = to_px(float(cm.group(1)), float(cm.group(2)))

        infl_px = max(1, int(round(INFLATE_M / res)))
        _sf_enabled, _sf_margin_cm = _read_seam_fix_config()   # app-controlled edge behaviour
        _edge_px = int(round((_sf_margin_cm / 100.0) / res))
        uni_w = max(2, int(round(UNICOM_W_M / res)))
        dock_r = max(2, int(round(DOCK_R_M / res)))

        mirrored = []
        for slot in sorted(slots):
            wpts = read_xy_csv(f"{csv_dir}/{slot}_work.csv")
            if len(wpts) < 3:
                continue
            mask = Image.new("L", (W, H), 0)
            d = ImageDraw.Draw(mask)
            poly = [to_px(x, y) for (x, y) in wpts]
            d.polygon(poly, fill=255)                                  # the zone itself
            # Edge behaviour is app-controlled (set_seam_fix). seam-fix ON -> ERODE
            # inward by edge_margin so the mower BODY stays off tight borders;
            # OFF -> keep the legacy +0.6 m outside halo so non-opted-in mowers are
            # unchanged (that halo made coverage mow over the border on tight edges).
            if _sf_enabled:
                if _edge_px > 0:
                    d.line(poly + [poly[0]], fill=0, width=2 * _edge_px, joint="curve")  # erode inward (edge margin)
            else:
                d.line(poly + [poly[0]], fill=255, width=2 * infl_px, joint="curve")  # legacy outside halo
            for up in unicoms_for(slot):                               # keep this slot's corridor(s) navigable
                d.line(up, fill=255, width=uni_w, joint="curve")
            if dock_px is not None:                                    # keep the dock start cell free
                d.ellipse([dock_px[0] - dock_r, dock_px[1] - dock_r,
                           dock_px[0] + dock_r, dock_px[1] + dock_r], fill=255)
            marr = np.array(mask, dtype=np.uint8)
            out = np.where(marr > 0, whole, np.uint8(OCCUPIED)).astype(np.uint8)

            # Force this slot's mapped obstacles OCCUPIED (the planner plans on
            # this pgm; masking alone can leave an obstacle free if map.pgm never
            # had it). Fill + a min-thickness outline so even tiny obstacles mark.
            obs = obstacles_for(slot)
            if obs:
                omask = Image.new("L", (W, H), 0)
                od = ImageDraw.Draw(omask)
                obs_w = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
                for op in obs:
                    od.polygon(op, fill=255, outline=255)
                    od.line(op + [op[0]], fill=255, width=obs_w, joint="curve")
                out = np.where(np.array(omask, dtype=np.uint8) > 0, np.uint8(OCCUPIED), out).astype(np.uint8)

            with open(f"{base}/{slot}.pgm", "wb") as fh:
                fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
                fh.write(out.tobytes())
            with open(f"{base}/{slot}.yaml", "w") as fh:
                fh.write(re.sub(r"^image:\s*\S+\s*$", f"image: {slot}.pgm",
                                 whole_yaml_content, flags=re.MULTILINE))
            try:
                Image.fromarray(out, mode="L").save(f"{base}/{slot}.png")
            except Exception:
                pass
            mirrored.append(slot)

        # NOTE: map_info.json is intentionally NOT rebuilt here. The server
        # writes a complete + consistent map_info (matching the shipped CSVs)
        # via synthMowerFiles, so a mower-side rebuild is redundant and could
        # resurrect stale on-disk CSVs into the manifest. Per-slot masking above
        # is the actual fix this handler provides.
        log(f"regenerate_per_map_files: per-slot masked grids for {mirrored}")
        respond("regenerate_per_map_files_respond", {"result": 0, "mirrored": mirrored, "home": home})
    except Exception as e:
        log(f"regenerate_per_map_files error: {e}")
        respond("regenerate_per_map_files_respond", {"result": 1, "error": str(e)})


def handle_generate_empty_map(params, respond):
    """Synthesize map.png + map.yaml in home0/ from polygon CSVs.

    Stock firmware writes map.pgm/png/yaml during a real `save_map type:1`
    at the end of a BLE mapping session. Portable import skips that flow —
    we drop the polygon CSVs straight into home0/ — so the nav stack has
    no raster to load and start_navigation fails Error 107 / 125.

    coverage_planner uses the raster's contour to derive the planning
    area (`No coverage map, using obstacle map to plan!!!`) — a fully
    free raster collapses to the raster perimeter, which is then dropped
    as "close to edge" leaving "No valid contour!!!". So we have to
    rasterize the polygon ourselves: pixels INSIDE the work polygon are
    free (254), everything outside is occupied (0). Obstacles inside the
    work polygon are punched back to occupied so the planner avoids them.

    Reads CSVs directly from `<base>/csv_file/`:
      - <map>_work.csv             — outer boundary
      - <map>_*_obstacle.csv       — interior obstacles
      - <map>tocharge_unicom.csv   — kept free (path to dock)

    Required params: none — uses defaults.

    Optional:
      home:        str  — home dir under /userdata/lfi/maps. Default "home0".
      map:         str  — base map name. Default "map0".
      resolution:  float — m/pixel. Default 0.05.
      margin:      float — meters of free space around polygon bbox. Default 5.
      index:       int  — also copy to map<index>.png/yaml. Default 0.
    """
    import glob
    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    map_name = params.get("map", "map0") if isinstance(params, dict) else "map0"
    resolution = float(params.get("resolution", 0.05)) if isinstance(params, dict) else 0.05
    margin = float(params.get("margin", 5.0)) if isinstance(params, dict) else 5.0
    index = int(params.get("index", 0)) if isinstance(params, dict) else 0

    base = f"/userdata/lfi/maps/{home}"
    csv_dir = f"{base}/csv_file"
    work_csv = f"{csv_dir}/{map_name}_work.csv"
    if not os.path.exists(work_csv):
        respond("generate_empty_map_respond", {"result": 1, "error": f"work csv missing: {work_csv}"})
        return

    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as e:
        respond("generate_empty_map_respond", {"result": 1, "error": f"PIL/numpy import failed: {e}"})
        return

    try:
        work_pts = read_xy_csv(work_csv)
        if len(work_pts) < 3:
            respond("generate_empty_map_respond", {"result": 1, "error": f"work csv too small: {len(work_pts)} pts"})
            return

        obstacle_paths = sorted(glob.glob(f"{csv_dir}/{map_name}_*_obstacle.csv"))
        obstacle_polys = [read_xy_csv(p) for p in obstacle_paths]
        obstacle_polys = [p for p in obstacle_polys if len(p) >= 3]

        # Compute bbox over all polygons + margin
        xs = [p[0] for p in work_pts] + [p[0] for poly in obstacle_polys for p in poly]
        ys = [p[1] for p in work_pts] + [p[1] for poly in obstacle_polys for p in poly]
        min_x, max_x = min(xs) - margin, max(xs) + margin
        min_y, max_y = min(ys) - margin, max(ys) + margin

        width_px = int(round((max_x - min_x) / resolution))
        height_px = int(round((max_y - min_y) / resolution))
        if width_px < 10 or height_px < 10 or width_px > 6000 or height_px > 6000:
            respond("generate_empty_map_respond", {"result": 1, "error": f"raster size out of bounds: {width_px}x{height_px}"})
            return

        # PGM/YAML: image y-axis grows downward, map y grows up. So the row
        # corresponding to map_y is flipped: row = (height_px - 1) - (y - min_y)/res.
        def _world_to_pixel(pts):
            return [
                (
                    int(round((x - min_x) / resolution)),
                    int(round(height_px - 1 - (y - min_y) / resolution)),
                )
                for (x, y) in pts
            ]

        # Start with all-occupied (0). Polygon fill marks free (254).
        img = Image.new("L", (width_px, height_px), color=0)
        draw = ImageDraw.Draw(img)
        draw.polygon(_world_to_pixel(work_pts), fill=254, outline=254)
        # Punch obstacles back to occupied
        for poly in obstacle_polys:
            draw.polygon(_world_to_pixel(poly), fill=0, outline=0)

        png_dst = f"{base}/map.png"
        yaml_dst = f"{base}/map.yaml"
        idx_png = f"{base}/map{index}.png"
        idx_yaml = f"{base}/map{index}.yaml"

        img.save(png_dst, format="PNG")
        img.save(idx_png, format="PNG")

        yaml_text = (
            f"image: map.png\n"
            f"mode: trinary\n"
            f"resolution: {resolution}\n"
            f"origin: [{min_x}, {min_y}, 0]\n"
            f"negate: 0\n"
            f"occupied_thresh: 0.65\n"
            f"free_thresh: 0.25\n"
        )
        with open(yaml_dst + ".tmp", "w") as f:
            f.write(yaml_text)
        os.replace(yaml_dst + ".tmp", yaml_dst)

        idx_yaml_text = yaml_text.replace("image: map.png\n", f"image: map{index}.png\n")
        with open(idx_yaml + ".tmp", "w") as f:
            f.write(idx_yaml_text)
        os.replace(idx_yaml + ".tmp", idx_yaml)

        written = [png_dst, yaml_dst, idx_png, idx_yaml]
        log(f"generate_empty_map: rasterized polygon {len(work_pts)} pts + {len(obstacle_polys)} obstacles → {width_px}x{height_px} px origin=({min_x:.2f},{min_y:.2f})")
        respond("generate_empty_map_respond", {
            "result": 0,
            "written": written,
            "origin": [min_x, min_y, 0],
            "width_px": width_px,
            "height_px": height_px,
            "resolution": resolution,
            "polygon_pts": len(work_pts),
            "obstacles": len(obstacle_polys),
        })
    except Exception as e:
        log(f"generate_empty_map error: {e}")
        respond("generate_empty_map_respond", {"result": 1, "error": str(e)})


def handle_fix_lawn_seams(params, respond):
    """Remove firmware grid-construction seams INSIDE the mowable area.

    The stock occupancy-grid writer (`map_generator.cpp` in novabot_mapping)
    can leave a thin OCCUPIED stripe inside the work area when it rebuilds
    the grid from CSVs (e.g. after a portable restore) rather than building
    it live from scan data. Such a stripe is in NO csv, sits inside covered
    lawn, is a perfectly straight artefact, and blocks nav2 return-home
    (proven on LFIN2231000633: ~0.6 m vertical stripe inside map0/map1).

    Rule: a cell strictly INSIDE a work polygon that is not a mapped
    obstacle must be free -> flip such occupied cells to free (254).
    Talud-safe by construction: only cells inside the raw (un-inflated)
    work polygons are touched; everything outside (boundary / embankment)
    stays occupied. Obstacles (map<N>_<M>_obstacle.csv) are preserved.

    Run BEFORE regenerate_per_map_files so the per-slot masks inherit the
    cleaned global grid. Idempotent.

    Optional params: home (default "home0"), thresh (occupied if pixel <
    thresh, default 128), obstacle_inflate_m (default 0.10).
    """
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as e:
        respond("fix_lawn_seams_respond", {"result": 1, "error": f"PIL/numpy import failed: {e}"})
        return

    home = params.get("home", "home0") if isinstance(params, dict) else "home0"
    thresh = int(params.get("thresh", 128)) if isinstance(params, dict) else 128
    obs_inf = float(params.get("obstacle_inflate_m", 0.10)) if isinstance(params, dict) else 0.10
    base = f"/userdata/lfi/maps/{home}"
    csv_dir = f"{base}/csv_file"
    whole_pgm = f"{base}/map.pgm"
    whole_yaml = f"{base}/map.yaml"

    try:
        if not os.path.exists(whole_pgm) or not os.path.exists(whole_yaml):
            respond("fix_lawn_seams_respond", {"result": 1, "error": "map.pgm / map.yaml missing"})
            return
        try:
            res, ox, oy, _ = parse_map_yaml(whole_yaml)
        except ValueError as e:
            respond("fix_lawn_seams_respond", {"result": 1, "error": str(e)})
            return
        arr = np.array(Image.open(whole_pgm).convert("L"), dtype=np.uint8)
        H, W = arr.shape
        to_px = make_to_px(ox, oy, res, H)

        if not os.path.isdir(csv_dir):
            respond("fix_lawn_seams_respond", {"result": 1, "error": f"{csv_dir} not found"})
            return

        # lawn mask = union of RAW work polygons (no inflate -> strictly interior, talud-safe)
        lawn_img = Image.new("L", (W, H), 0)
        ld = ImageDraw.Draw(lawn_img)
        n_work = 0
        for fname in sorted(os.listdir(csv_dir)):
            if re.match(r"^map\d+_work\.csv$", fname):
                pts = read_xy_csv(f"{csv_dir}/{fname}")
                if len(pts) >= 3:
                    ld.polygon([to_px(x, y) for (x, y) in pts], fill=255)
                    n_work += 1
        if n_work == 0:
            respond("fix_lawn_seams_respond", {"result": 0, "freed": 0, "skipped_reason": "no map<N>_work.csv"})
            return
        lawn = np.array(lawn_img) > 0

        # obstacle mask = mapped obstacles + min thickness (MUST stay occupied)
        obst_img = Image.new("L", (W, H), 0)
        od = ImageDraw.Draw(obst_img)
        ow = max(1, 2 * int(round(obs_inf / res)))
        for fname in os.listdir(csv_dir):
            if re.match(r"^map\d+_\d+_obstacle\.csv$", fname):
                op = [to_px(x, y) for (x, y) in read_xy_csv(f"{csv_dir}/{fname}")]
                if len(op) >= 3:
                    od.polygon(op, fill=255, outline=255)
                    od.line(op + [op[0]], fill=255, width=ow, joint="curve")
        obst = np.array(obst_img) > 0

        fix = (arr < thresh) & lawn & (~obst)
        freed = int(fix.sum())
        if freed:
            arr[fix] = np.uint8(254)
            with open(whole_pgm + ".tmp", "wb") as fh:
                fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
                fh.write(arr.tobytes())
            os.replace(whole_pgm + ".tmp", whole_pgm)
            try:
                Image.fromarray(arr, mode="L").save(f"{base}/map.png")
            except Exception:
                pass
        log(f"fix_lawn_seams: freed {freed} occupied cell(s) inside {n_work} work polygon(s) (home={home})")
        respond("fix_lawn_seams_respond", {"result": 0, "freed": freed, "work_polygons": n_work, "home": home})
    except Exception as e:
        log(f"fix_lawn_seams error: {e}")
        respond("fix_lawn_seams_respond", {"result": 1, "error": str(e)})


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
    # Use a rate-based publish kept alive for 8s instead of `--once`. On the
    # Horizon X3 DDS stack subscriber discovery often takes 6-10s; `--once`
    # exits before the chassis_control_node's late-joining subscriber has
    # registered and the message is dropped (live capture 2026-05-11). With
    # `-r 1` the publisher re-broadcasts every second so the subscription
    # latches in and chassis_control_node receives the value within the
    # window. timeout 8 hard-bounds the subprocess lifetime.
    cmd = (
        "export ROS_LOCALHOST_ONLY=1; "
        "export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; "
        "source /opt/ros/galactic/setup.bash 2>/dev/null; "
        "source /root/novabot/install/setup.bash 2>/dev/null; "
        f"timeout 8 ros2 topic pub -r 1 {topic} {type_name} '{payload_yaml}' "
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
    """Set the sustained blade-speed target. BladeRelay's 10Hz timer keeps
    republishing the value via its long-lived rclpy publisher; subprocess
    publishes were flaky because sourcing setup.bash can block on
    register-python-argcomplete3 long enough that `timeout 8 ros2 topic
    pub` exits without ever broadcasting the value (live observation
    2026-05-11)."""
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return "ros node not ready"
    setter = getattr(node, "set_blade_speed_target", None)
    if callable(setter):
        setter(int(speed))
    else:
        node.target_blade_speed = int(speed)
    return ""


def _start_robot_status_override():
    """Activate the BladeRelay timer that republishes a modified copy of
    robot_decision's RobotStatus at 50Hz. Modifies only task_mode=1,
    work_status=10, merged_work_status=COVER — all other fields (battery,
    error_status, msg, location, etc.) come from the real status so the
    cloud / app keep seeing accurate values. The v8 subprocess spammer
    zeroed every field which made the app show "battery 0% — heading back
    to dock" (live observation 2026-05-11)."""
    node = _ROS_BLADE_NODE[0]
    if node is None:
        log("[robot-status] override request but ROS node not ready")
        return
    if not node.override_active:
        node._arm_status_override()


def _stop_robot_status_override():
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return
    if node.override_active:
        node._disarm_status_override()


def _publish_motor_driver_reset() -> str:
    """Publish empty String on /motor_driver_reset.

    Triggers chassis_control_node's sub_MotorDriverReset_cb which sends UART
    cmd 0xF0 to the STM32. This re-arms the motor drivers and clears any
    latched stall/overcurrent flags from a previous failed blade-spin
    attempt. Factory test and (probably) the OEM coverage workflow publish
    this before driving blade speed; without it the STM32 latches its stall
    flag from the previous cold-start inrush spike and refuses subsequent
    speed commands (observed live on .244 2026-05-11: piep + abort with no
    motor activity)."""
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return "ros node not ready"
    try:
        from std_msgs.msg import String  # type: ignore
        msg = String()
        msg.data = "reset"
        node.reset_pub.publish(msg)
        return ""
    except Exception as ex:
        return str(ex)[:200]


def _publish_blade_height(level: int) -> str:
    """Convert wire-level 0..7 to mm and publish on /blade_height_set.

    chassis_control_node's `set_blade_height_cb` (Ghidra decompile @
    0x162ddc) accepts ONLY discrete mm values 20/30/40/50/60/70/80/90 as
    UInt8 and silently no-ops on anything else. The MQTT/app side speaks
    the cutterhigh enum 0..7 where `mm = (level + 2) * 10` (verified
    live in cutting-height-mapping.md). Publishing the raw level
    bypassed the firmware's accepted-input set so the cutting deck never
    actuated and the blade motor never engaged — even though the speed
    publish succeeded — leaving manual-control "Blade is spinning"
    showing while nothing physical happened (issue #55).
    """
    mm = (int(level) + 2) * 10
    if mm < 20 or mm > 90:
        return f"invalid level {level} (mm {mm} out of range 20..90)"
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return "ros node not ready"
    setter = getattr(node, "set_blade_height_target", None)
    if callable(setter):
        setter(int(mm))
    else:
        node.target_blade_height = int(mm)
    return ""


def handle_blade_on(params, respond):
    """Turn the blade motor ON.

    Stock OEM `coverage_planner_params.yaml` publishes `blade_speed: -2750`
    to /blade_speed_set when starting a mowing task — NEGATIVE value.
    Positive values are silently rejected by chassis_control_node / STM32
    (live capture on .244 2026-05-11: +3000 → height moves + 2 beeps +
    headlight blink + then motor never engaged). The sign encodes blade
    rotation direction; OEM only ever uses negative for the cutting
    direction. We mirror that: negate the magnitude here.

    Sequence:
      1. publish blade_height (lift motor moves cutting deck into position)
      2. sleep blade_startup_time (matches the OEM 4.5s param)
      3. publish blade_speed = -|magnitude| on /blade_speed_set

    Params: {speed: int (magnitude, default 2750), height: int (0-7,
    default 5 = 60mm)}.
    """
    raw_speed = int((params or {}).get("speed", 2750))
    # Force negative — OEM convention. Accept either sign on the wire.
    magnitude = abs(raw_speed)
    if magnitude < 500: magnitude = 500
    # OEM coverage_planner_params.yaml uses -2750 as the cutting speed.
    # Sending |speed| > 2750 silently fails on STM32 v3.6.0 (live test
    # 2026-05-11: speed=3000 reached chassis, STM32 logged nothing further,
    # motor never engaged; speed=-2750 from the same sequence spun the
    # motor to 1725 mA). Treat 2750 as the hard ceiling.
    if magnitude > 2750: magnitude = 2750
    signed_speed = -magnitude

    height = (params or {}).get("height")
    err_h = ""
    if height is not None:
        h = int(height)
        if h < 0: h = 0
        if h > 7: h = 7
        err_h = _publish_blade_height(h)

    # Override RobotStatus so chassis_control_node forwards work_status=10
    # (COVERING) to STM32. STM32 v3.6.0 stock keeps the blade motor disabled
    # unless it sees this state on the periodic UART status packet. The
    # override stays active until blade_off.
    _start_robot_status_override()

    # Re-arm motor drivers so a previous stall-trip flag doesn't latch the
    # blade off (UART cmd 0xF0 → STM32). OEM factory test publishes this
    # before every blade test; without it the STM32 silently refuses the
    # next /blade_speed_set.
    err_r = _publish_motor_driver_reset()
    if err_r:
        log(f"[blade_on] motor_driver_reset publish error: {err_r}")

    def _delayed_speed():
        # Match the OEM blade_startup_time of 4.5s before driving speed.
        time.sleep(4.5)
        err = _publish_blade_speed(signed_speed)
        if err:
            log(f"[blade_on] delayed speed publish error: {err}")
        else:
            log(f"[blade_on] delayed speed {signed_speed} rpm published (OEM sign convention)")

    threading.Thread(target=_delayed_speed, daemon=True, name='blade-speed-delayed').start()
    respond("blade_on_respond", {
        "result": 0 if not err_h else 1,
        "speed": signed_speed,
        "height": height,
        "error": err_h,
        "note": "speed publishes 4.5s after height; negative sign matches OEM coverage_planner_params.yaml",
    })


def handle_blade_off(params, respond):
    """Turn the blade motor OFF (speed 0) AND retract blades (height 0).
    Retracting is important safety: blades UP = physically safer when
    mower is picked up, moved, or stuck. Also stops the RobotStatus
    override so robot_decision's real status reaches chassis again."""
    err1 = _publish_blade_speed(0)
    err2 = _publish_blade_height(0)
    _stop_robot_status_override()
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


def handle_set_pos_origin(params, respond):
    """Overwrite /userdata/pos.json wgs84_origin (lat/lng) and chmod 0444 so
    the next reboot's GPS-fix-derived write cannot stomp on it. Also restart
    robot_combination_localization so the new origin takes effect without a
    full mower reboot.

    Payload: {"lat": float, "lng": float}
    """
    import json as _json
    import os as _os
    import math as _math
    import subprocess as _sp

    lat = params.get("lat")
    lng = params.get("lng")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        respond("set_pos_origin_respond", {"result": 1, "error": "lat/lng required"})
        return

    # WGS84 -> UTM zone 32 (Europe). Hard-code matches local dev mowers; if
    # you deploy elsewhere, derive the zone from longitude.
    zone = int((lng + 180) / 6) + 1
    # Keep the existing time_stamp if pos.json already exists, else 0.
    ts = 0
    try:
        with open("/userdata/pos.json") as f:
            ts = float(_json.load(f).get("time_stamp", 0))
    except Exception:
        pass

    # Approximate UTM x/y via simple cylindrical projection — robot_combination
    # _localization recomputes from the lat/lng on first GPS fix, so this only
    # needs to be a coarse seed.
    METERS_PER_DEG = 111320.0
    cos_lat = _math.cos(_math.radians(lat))
    # central meridian for zone N is (-180 + 6N - 3)
    central_meridian = -180 + 6 * zone - 3
    x = 500000.0 + (lng - central_meridian) * cos_lat * METERS_PER_DEG
    y = lat * METERS_PER_DEG

    payload = {
        "time_stamp": ts,
        "utm_origin": {"utm_zone": zone, "x": x, "y": y, "z": 0},
        "wgs84_origin": {"latitude": lat, "longitude": lng},
    }

    try:
        _os.chmod("/userdata/pos.json", 0o644)
    except Exception:
        pass
    try:
        with open("/userdata/pos.json", "w") as f:
            _json.dump(payload, f)
        _os.chmod("/userdata/pos.json", 0o444)
    except Exception as e:
        respond("set_pos_origin_respond", {"result": 1, "error": f"write failed: {e}"})
        return

    # Restart robot_combination_localization so it re-reads pos.json. The
    # node has no respawn=True flag in novabot_system.launch.py — kill +
    # detached relaunch via setsid (same pattern as _restart_novabot_mapping
    # post-2026-05-06 fix).
    try:
        _sp.Popen(
            ["bash", "-lc",
             "(killall -9 robot_combination_localization 2>/dev/null || true); "
             "sleep 1; "
             ". /opt/ros/galactic/setup.bash; "
             ". /root/novabot/install/setup.bash; "
             "export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; "
             "export ROS_LOCALHOST_ONLY=1; "
             "export ROS_LOG_DIR=/root/novabot/data/ros2_log; "
             "export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH; "
             "setsid nohup ros2 run robot_combination_localization robot_combination_localization "
             "--ros-args --params-file /root/novabot/install/robot_combination_localization/share/robot_combination_localization/params/combination_localization.yaml "
             ">> $ROS_LOG_DIR/loc_restart.log 2>&1 </dev/null &"],
            stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, stdin=_sp.DEVNULL,
            start_new_session=True, close_fds=True,
        )
    except Exception as e:
        respond("set_pos_origin_respond", {"result": 1, "error": f"relaunch failed: {e}"})
        return

    respond("set_pos_origin_respond", {"result": 0, "lat": lat, "lng": lng, "utm_zone": zone})


def handle_calibration_drive(params, respond):
    """Drive forward `distance_m` at `max_speed` m/s, return start + end RTK
    poses. Pre-checks: loc_quality=100, battery > 30%, no latched error_status,
    not in mowing/recharging task. Aborts with reason if any fail.

    Payload: {"distance_m": 1.0, "max_speed": 0.2}
    Response (on success): {
      "result": 0,
      "start": {"lat": ..., "lng": ..., "map_x": ..., "map_y": ...},
      "end":   {"lat": ..., "lng": ..., "map_x": ..., "map_y": ...},
      "duration_s": 5.1
    }
    Response (abort): {"result": 1, "error": "..."}
    """
    import time as _time
    import threading as _th

    distance_m = float(params.get("distance_m", 1.0))
    max_speed = float(params.get("max_speed", 0.2))
    if distance_m <= 0 or distance_m > 5 or max_speed <= 0 or max_speed > 0.5:
        respond("calibration_drive_respond", {"result": 1, "error": "distance/speed out of range"})
        return

    try:
        import rclpy  # type: ignore
        from rclpy.node import Node  # type: ignore
        from geometry_msgs.msg import Twist  # type: ignore
    except ImportError as ex:
        respond("calibration_drive_respond", {"result": 1, "error": f"rclpy unavailable: {ex}"})
        return

    # Pre-check via NavSatFix + map_position from sensor cache (if present).
    # We do not have direct access to the server's deviceCache here, so we
    # subscribe to the sensor topic ourselves for one frame.
    pre_state = {"lat": None, "lng": None, "loc_quality": None, "map_x": None, "map_y": None}
    end_state = {"lat": None, "lng": None, "map_x": None, "map_y": None}
    drive_done = _th.Event()

    def _spin():
        try:
            try:
                rclpy.init()
            except RuntimeError:
                pass

            class _Driver(Node):
                def __init__(self):
                    super().__init__('calibration_drive_helper')
                    self._cmd_pub = self.create_publisher(Twist, '/cmd_vel', 10)
                    self._timer = None

                def drive_backward(self, secs):
                    # Drive BACKWARD because the mower starts on the dock with
                    # its front pressed against the charger plate; positive
                    # linear.x would push into the charger and not move (the
                    # contacts physically block forward motion). Server's
                    # deriveHeading() returns the GPS direction of the backward
                    # travel; the start-drive route adds pi to convert that
                    # into the mower-forward heading.
                    end_at = _time.monotonic() + secs
                    msg = Twist()
                    msg.linear.x = -max_speed
                    while _time.monotonic() < end_at and not drive_done.is_set():
                        self._cmd_pub.publish(msg)
                        _time.sleep(0.05)
                    msg.linear.x = 0.0
                    for _ in range(5):
                        self._cmd_pub.publish(msg)
                        _time.sleep(0.05)

            node = _Driver()

            # NOTE: The server's snapshot logic captures pose via /api/dashboard/
            # devices/<sn> which reads sensor cache. We rely on the server to
            # snapshot start_pose BEFORE invoking us and end_pose AFTER. So this
            # handler only DRIVES — the pose readback is server-side.
            duration_s = distance_m / max_speed + 0.5  # +0.5s decel buffer
            node.drive_backward(duration_s)

            respond("calibration_drive_respond", {
                "result": 0,
                "duration_s": duration_s,
            })
        except Exception as ex:
            respond("calibration_drive_respond", {"result": 1, "error": f"drive failed: {ex}"})
        finally:
            drive_done.set()

    t = _th.Thread(target=_spin, daemon=True, name='calibration-drive')
    t.start()


def handle_reanchor_pos(params, respond):
    """Re-anchor the localization UTM origin to a given GPS — NO lock, NO restart.

    Writes /userdata/pos.json (utm_origin + wgs84_origin) = the supplied GPS
    (the charger/dock location, captured while docked on RTK Fixed) and then
    calls /load_utm_origin_info so the RUNNING localization re-reads it live.
    Unlike the older set_pos_origin this does NOT chmod 0444 (no lock — the
    stock firmware never locks pos.json, and with a reliable RTK the GPS-fix
    derive is correct anyway) and does NOT restart the node.

    pos.json's utm_origin is used by loadUtmOriginInfoCallback verbatim (it sets
    the in-memory origin x/y directly), so we write a PRECISE UTM here, not a
    coarse seed.

    The origin is shifted by the DOCK ANCHOR (first point of
    map0tocharge_unicom.csv = the charger's position in the polygon/map frame) so
    a docked mower lands on that anchor, NOT on (0,0). Writing the raw GPS as
    origin put the charger at (0,0) while the polygons expect it at the anchor,
    shifting the whole map ~2m (mis-anchor bug, LIVE-fixed 2026-07-01 on .244:
    docked 2.14 -> 0.06m from anchor). Same approach as the server's
    generatePosJson (dashboard.ts ~1780: xCharger - anchor.x). ~10cm residual
    from the antenna lever-arm is corrected by the visual docker.

    After this the localization goes "Not initialized"; drive ~1m on a CLEAN RTK
    Fixed to re-lock, then the docked position lands on the dock anchor.
    Full analysis: research/documents/reanchor-polygon-charging-pose-diagnosis.md

    Payload: {"lat": float, "lng": float, "anchor_x"?: float, "anchor_y"?: float}
    """
    import json as _json, math as _math, os as _os
    lat = params.get("lat")
    lng = params.get("lng")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        respond("reanchor_pos_respond", {"result": 1, "error": "lat/lng required"})
        return

    # WGS84 -> UTM (Karney/Snyder, precise; validated to ~2mm vs stored origins)
    def _g2u(lat_d, lon_d):
        a = 6378137.0; f = 1 / 298.257223563; k0 = 0.9996
        e2 = f * (2 - f); ep2 = e2 / (1 - e2)
        zone = int((lon_d + 180) / 6) + 1
        lon0 = _math.radians(6 * zone - 183)
        latr = _math.radians(lat_d); lonr = _math.radians(lon_d)
        N = a / _math.sqrt(1 - e2 * _math.sin(latr) ** 2)
        T = _math.tan(latr) ** 2; C = ep2 * _math.cos(latr) ** 2
        A = _math.cos(latr) * (lonr - lon0)
        M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latr
                 - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * _math.sin(2 * latr)
                 + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * _math.sin(4 * latr)
                 - (35 * e2 ** 3 / 3072) * _math.sin(6 * latr))
        x = k0 * N * (A + (1 - T + C) * A ** 3 / 6
                      + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000.0
        y = k0 * (M + N * _math.tan(latr) * (A ** 2 / 2
                  + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
                  + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720))
        return zone, x, y

    # UTM -> WGS84 inverse (Snyder), so wgs84_origin stays consistent with the
    # anchor-shifted utm_origin below.
    def _u2g(xx, yy, zn):
        a = 6378137.0; f = 1 / 298.257223563; k0 = 0.9996
        e2 = f * (2 - f); e1 = (1 - _math.sqrt(1 - e2)) / (1 + _math.sqrt(1 - e2))
        xx -= 500000.0; M = yy / k0
        mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
        phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * _math.sin(2 * mu)
                + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * _math.sin(4 * mu)
                + (151 * e1 ** 3 / 96) * _math.sin(6 * mu))
        ep2 = e2 / (1 - e2); C1 = ep2 * _math.cos(phi1) ** 2; T1 = _math.tan(phi1) ** 2
        N1 = a / _math.sqrt(1 - e2 * _math.sin(phi1) ** 2)
        R1 = a * (1 - e2) / (1 - e2 * _math.sin(phi1) ** 2) ** 1.5
        D = xx / (N1 * k0)
        lat_o = phi1 - (N1 * _math.tan(phi1) / R1) * (D ** 2 / 2
                - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
                + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720)
        lon0 = _math.radians(6 * zn - 183)
        lon_o = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
                + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / _math.cos(phi1)
        return _math.degrees(lat_o), _math.degrees(lon_o)

    # Dock anchor = first point of map0tocharge_unicom.csv (charger position in the
    # polygon/map frame). The polygons are drawn around THIS point, so the origin
    # must be shifted so a docked mower reads this anchor, not (0,0).
    # ponytail: read map0 unicom; falls back to (0,0) if absent (pre-2026-07 behaviour)
    def _dock_anchor():
        ax = params.get("anchor_x"); ay = params.get("anchor_y")
        if isinstance(ax, (int, float)) and isinstance(ay, (int, float)):
            return float(ax), float(ay)
        for p in ("/userdata/lfi/maps/home0/csv_file/map0tocharge_unicom.csv",
                  "/userdata/lfi/maps/home0/x3_csv_file/map0tocharge_unicom.csv"):
            try:
                with open(p) as f:
                    parts = f.readline().strip().split(",")
                return float(parts[0]), float(parts[1])
            except Exception:
                continue
        return 0.0, 0.0

    zone, x, y = _g2u(float(lat), float(lng))
    anchor_x, anchor_y = _dock_anchor()
    x -= anchor_x
    y -= anchor_y
    olat, olon = _u2g(x, y, zone)
    ts = 0
    try:
        with open("/userdata/pos.json") as f:
            ts = float(_json.load(f).get("time_stamp", 0))
    except Exception:
        pass
    payload = {
        "time_stamp": ts,
        "utm_origin": {"utm_zone": zone, "x": x, "y": y, "z": 0},
        "wgs84_origin": {"latitude": olat, "longitude": olon},
    }
    try:
        try:
            _os.chmod("/userdata/pos.json", 0o644)  # unlock if a prior set_pos_origin locked it
        except Exception:
            pass
        with open("/userdata/pos.json", "w") as f:
            _json.dump(payload, f, indent=3)
            f.write("\n")
        # deliberately leave 0644 — no lock
    except Exception as e:
        respond("reanchor_pos_respond", {"result": 1, "error": f"write failed: {e}"})
        return

    # Retry the localization reload. pos.json is already written; only this ROS
    # service call is flaky (it times out when the localization node is busy right
    # after docking). Retry a few times so a transient timeout does not fail the
    # whole re-anchor. Succeeds and returns as soon as any attempt loads.
    last_err = "load_utm_origin_info timeout"
    for attempt in range(1, 4):
        try:
            r = ros2_run(
                ["ros2", "service", "call", "/load_utm_origin_info",
                 "localization_msgs/srv/LoadUtmOriginInfo", "'{utm_info_path: /userdata/pos.json}'"],
                timeout=15,
            )
            ok = r.returncode == 0 and ("result=True" in r.stdout or "Load success" in r.stdout)
            log(f"reanchor_pos: utm=({x:.2f},{y:.2f}) anchor=({anchor_x:.2f},{anchor_y:.2f}) zone={zone} attempt={attempt} load rc={r.returncode} out={r.stdout.strip()[:150]}")
            if ok:
                respond("reanchor_pos_respond", {
                    "result": 0,
                    "utm_origin": {"x": x, "y": y, "utm_zone": zone},
                    "wgs84_origin": {"latitude": olat, "longitude": olon},
                    "anchor": {"x": anchor_x, "y": anchor_y},
                    "load_stdout": r.stdout.strip()[:250],
                    "attempts": attempt,
                })
                return
            last_err = f"load rc={r.returncode}: {r.stdout.strip()[:120]}"
        except subprocess.TimeoutExpired:
            last_err = "load_utm_origin_info timeout"
            log(f"reanchor_pos: attempt={attempt} load timeout")
        except Exception as e:
            last_err = f"load failed: {e}"
            log(f"reanchor_pos load error (attempt {attempt}): {e}")
        if attempt < 3:
            time.sleep(2)
    respond("reanchor_pos_respond", {"result": 1, "error": last_err, "attempts": 3})


def _coverage_planner_params_yaml_path():
    env_path = os.environ.get("OPENNOVA_COVERAGE_PLANNER_PARAMS_YAML")
    candidates = ([env_path] if env_path else []) + COVERAGE_PLANNER_PARAMS_YAML_CANDIDATES
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return env_path if env_path else None


def _parse_coverage_radius(params):
    raw = None
    for key in ("radius", "radius_m", "coverage_radius", "inflation_radius"):
        if key in params:
            raw = params.get(key)
            break
    try:
        radius = float(raw)
    except (TypeError, ValueError):
        return None
    if radius < COVERAGE_PLANNER_RADIUS_MIN_M or radius > COVERAGE_PLANNER_RADIUS_MAX_M:
        return None
    return round(radius, 3)


def _format_coverage_radius(radius):
    return f"{radius:.3f}".rstrip("0").rstrip(".")


def _write_coverage_planner_radius_yaml(path, radius):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    pattern = re.compile(
        r"^(\s*inflation_radius\s*:\s*)([-+]?\d+(?:\.\d+)?)(\s*(?:#.*)?)$",
        re.MULTILINE,
    )
    match = pattern.search(text)
    if not match:
        raise ValueError("inflation_radius not found")

    previous = float(match.group(2))
    radius_text = _format_coverage_radius(radius)
    if abs(previous - radius) < 0.0005:
        return {"changed": False, "previous_radius": previous, "backup": None}

    new_text = pattern.sub(
        lambda m: f"{m.group(1)}{radius_text}{m.group(3)}",
        text,
        count=1,
    )
    backup_path = f"{path}.bak.{int(time.time())}"
    tmp_path = f"{path}.tmp.{os.getpid()}"
    with open(backup_path, "w", encoding="utf-8") as f:
        f.write(text)
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(new_text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)
    return {"changed": True, "previous_radius": previous, "backup": backup_path}


def handle_set_coverage_planner_radius(params, respond):
    radius = _parse_coverage_radius(params)
    if radius is None:
        respond("set_coverage_planner_radius_respond", {
            "result": 1,
            "error": f"radius must be {COVERAGE_PLANNER_RADIUS_MIN_M:.2f}-{COVERAGE_PLANNER_RADIUS_MAX_M:.2f}m",
        })
        return

    force = bool(params.get("force"))
    if not force and _coverage_is_active():
        respond("set_coverage_planner_radius_respond", {
            "result": 2,
            "error": "coverage active, try again on dock",
            "radius": radius,
        })
        return

    path = _coverage_planner_params_yaml_path()
    if not path:
        respond("set_coverage_planner_radius_respond", {
            "result": 1,
            "error": "coverage_planner_params.yaml not found",
            "radius": radius,
        })
        return

    try:
        write_result = _write_coverage_planner_radius_yaml(path, radius)
        restarted = False
        if write_result["changed"]:
            restarted = _restart_novabot_mapping()
        respond("set_coverage_planner_radius_respond", {
            "result": 0,
            "radius": radius,
            "previous_radius": write_result["previous_radius"],
            "changed": write_result["changed"],
            "restarted": restarted,
            "path": path,
            "backup": write_result["backup"],
        })
    except Exception as e:
        log(f"coverage planner radius update failed: {e}")
        respond("set_coverage_planner_radius_respond", {
            "result": 1,
            "error": str(e),
            "radius": radius,
            "path": path,
        })


# ── Mapping preflight (read-only health gate before map actions) ─────────────
# Each _check_* returns {"status": ok|warn|block|na, "detail": str, ...}. The
# checks are grounded in failures seen live on LFIN1231000241 (2026-06-22):
# missing charging_station.yaml -> Error 140, crashed mapping node -> Error 120,
# memory/shm pressure -> iceoryx chunk-leak crash-loop. NOTE: deliberately NO
# localization check — a docked mower is "not aligned" until it drives off, so
# that would false-warn on every healthy mower (see localization-not-initialized).

# The STOCK firmware (save_map type:1 / auto_recharge_server) reads the dock pose
# ONLY from this TOP-LEVEL path — NOT from maps/home<N>/charging_station_file/.
# A stock map-delete transiently empties it, and that is the file that actually
# crashes the firmware with Error 120 -> 140. Both the preflight check below and
# the chg-guard MUST therefore guard THIS file, not just the per-home copies
# (the original code only looked at maps/home<N>/..., so it false-OK'd while the
# firmware crashed on the empty top-level file — root-caused 2026-06-29).
_FW_CS_YAML = "/userdata/lfi/charging_station_file/charging_station.yaml"
_FW_CS_BAK = _FW_CS_YAML + ".guardbak"


def _check_charging_station():
    """charging_station.yaml present+valid for the TOP-LEVEL firmware file (the one
    stock save_map type:1 actually reads) AND for every existing map home. For a
    first-ever map (no homes yet) there is no charge pose to validate -> na."""
    maps_root = "/userdata/lfi/maps"
    try:
        homes = [d for d in os.listdir(maps_root) if d.startswith("home") and "." not in d]
    except OSError:
        homes = []
    if not homes:
        return {"status": "na", "detail": "no map home yet (first map)"}
    # The file the firmware actually crashes on — check it FIRST.
    if not _charging_pose_yaml_ok(_FW_CS_YAML):
        return {"status": "block",
                "detail": "firmware charging_station.yaml missing/empty (%s) -> "
                          "stock save_map type:1 Error 120/140" % _FW_CS_YAML}
    missing = [h for h in homes
               if not _charging_pose_yaml_ok(os.path.join(
                   maps_root, h, "charging_station_file", "charging_station.yaml"))]
    if missing:
        return {"status": "block",
                "detail": "charging_station.yaml missing/invalid for %s "
                          "(stock save_map type:1 -> Error 140)" % ",".join(missing)}
    return {"status": "ok", "detail": "valid (firmware + %s)" % ",".join(homes)}


def _check_mapping_node():
    """novabot_mapping alive and not freshly (re)started — a restart in the last
    60s signals the iceoryx chunk-leak crash-loop (Error 120/140)."""
    try:
        pids = subprocess.run(
            ["pgrep", "-f", "lib/novabot_mapping/novabot_mapping"],
            capture_output=True, text=True, timeout=5).stdout.split()
    except Exception as ex:
        return {"status": "warn", "detail": "pgrep failed: %s" % ex}
    if not pids:
        return {"status": "block", "detail": "novabot_mapping not running (Error 120/140 likely; soft_restart)"}
    try:
        with open("/proc/uptime") as f:
            up = float(f.read().split()[0])
        hz = os.sysconf("SC_CLK_TCK")
        youngest = min(up - float(open("/proc/%s/stat" % p).read().split()[21]) / hz
                       for p in pids)
        if youngest < 60:
            return {"status": "warn",
                    "detail": "novabot_mapping (re)started %ds ago (crash-loop?)" % int(youngest)}
    except Exception:
        pass
    return {"status": "ok", "detail": "running"}


def _check_memory():
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    mem[parts[0].rstrip(":")] = int(parts[1])
        avail = mem.get("MemAvailable", mem.get("MemFree", 0)) // 1024
    except Exception as ex:
        return {"status": "warn", "detail": "meminfo failed: %s" % ex}
    if avail < 400:
        return {"status": "warn", "detail": "low memory: %dMB available" % avail, "mb": avail}
    return {"status": "ok", "detail": "%dMB available" % avail, "mb": avail}


def _check_shm():
    """iceoryx maps its segments under /dev/shm; near-full is a proxy for the
    chunk-pool leak that crash-loops novabot_mapping (Error 140).
    ponytail: /dev/shm fill% is a coarse proxy, not real iceoryx mempool stats —
    upgrade to `iox-introspection-client --mempool` if this proves too blunt."""
    try:
        st = os.statvfs("/dev/shm")
        total = st.f_blocks * st.f_frsize
        used_pct = round(100 * (total - st.f_bavail * st.f_frsize) / total) if total else 0
    except Exception as ex:
        return {"status": "warn", "detail": "statvfs /dev/shm failed: %s" % ex}
    if used_pct >= 80:
        return {"status": "warn",
                "detail": "/dev/shm %d%% full (chunk-leak? soft_restart resets it)" % used_pct,
                "pct": used_pct}
    return {"status": "ok", "detail": "/dev/shm %d%% full" % used_pct, "pct": used_pct}


def _check_disk():
    try:
        st = os.statvfs("/userdata")
        free = (st.f_bavail * st.f_frsize) // (1024 * 1024)
    except Exception as ex:
        return {"status": "warn", "detail": "statvfs /userdata failed: %s" % ex}
    if free < 500:
        return {"status": "warn", "detail": "low disk: %dMB free on /userdata" % free, "mb": free}
    return {"status": "ok", "detail": "%dMB free" % free, "mb": free}


def handle_mapping_preflight(params, respond):
    """Read-only health gate to run BEFORE map actions (create/edit/edge-cut).
    Returns per-check status + one overall verdict:
      block = a known mapping blocker present (Error 120/140 / dock failure)
      warn  = degraded but the user may proceed
      ok    = clear
    `na` checks (e.g. first-ever map) do not affect the verdict."""
    checks = {
        "charging_station_yaml": _check_charging_station(),
        "mapping_node": _check_mapping_node(),
        "memory": _check_memory(),
        "shm_pool": _check_shm(),
        "disk": _check_disk(),
    }
    statuses = [c.get("status") for c in checks.values()]
    verdict = "block" if "block" in statuses else "warn" if "warn" in statuses else "ok"
    reasons = [c["detail"] for c in checks.values() if c.get("status") in ("block", "warn")]
    log("mapping_preflight: verdict=%s (%s)" % (verdict, "; ".join(reasons) or "all ok"))
    respond("mapping_preflight_respond",
            {"result": 0, "verdict": verdict, "checks": checks, "reasons": reasons})


COMMANDS = {
    "is_opennova": handle_is_opennova,
    "mapping_preflight": handle_mapping_preflight,
    "reanchor_pos": handle_reanchor_pos,
    "set_robot_reboot": handle_reboot,
    "soft_restart": handle_soft_restart,
    "get_system_info": handle_system_info,
    "verify_pin": handle_verify_pin,
    "query_pin": handle_query_pin,
    "clear_error": handle_clear_error,
    "set_perception_mode": handle_set_perception_mode,
    "set_obstacle_detection": handle_set_obstacle_detection,
    "set_semantic_mode": handle_set_semantic_mode,
    "get_perception_status": handle_get_perception_status,
    "set_mqtt_config": handle_set_mqtt_config,
    "set_wifi_config": handle_set_wifi_config,
    "clean_ota_cache": handle_clean_ota_cache,
    "finalize_map_files": handle_finalize_map_files,
    "generate_empty_map": handle_generate_empty_map,
    "read_map_files": handle_read_map_files,
    "write_map_files": handle_write_map_files,
    "regenerate_per_map_files": handle_regenerate_per_map_files,
    "fix_lawn_seams": handle_fix_lawn_seams,
    "set_seam_fix": handle_set_seam_fix,
    "get_seam_fix": handle_get_seam_fix,
    "recalibrate_charging_pose": handle_recalibrate_charging_pose,
    "start_edge_cut": handle_start_edge_cut,
    "follow_unicom": handle_follow_unicom,
    "mow_zone": handle_mow_zone,
    "return_to_dock": handle_return_to_dock,
    "stop_boundary_follow": handle_stop_boundary_follow,
    "get_lora_info": handle_get_lora_info,
    "set_lora_info": handle_set_lora_info,
    "set_coverage_planner_radius": handle_set_coverage_planner_radius,
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
    "set_pos_origin": lambda p, r: handle_set_pos_origin(p, r),
    "calibration_drive": lambda p, r: handle_calibration_drive(p, r),
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

        # NEW (Novabot-53y): full anchor restore extension for the
        # /restore-and-realign one-click recovery flow. The server's enriched
        # /sync-info now also returns `charging_pose` (canonical anchor from
        # polygon's mapNtocharge_unicom first point). When present, write the
        # three additional state files the manual runbook used to write by hand:
        #   - /userdata/lfi/charging_station_file/charging_station.yaml
        #   - /root/novabot/data/maps/home0/csv_file/   (mirror)
        #   - /root/novabot/data/maps/home0/x3_csv_file/ (mirror)
        # Then restart auto_recharge_server so it re-reads charging_station.yaml
        # (it caches at boot — without restart the new pose is ignored until
        # the next mower reboot).
        #
        # Backwards compat: old server (no charging_pose in sync-info payload)
        # → block is skipped, behaviour unchanged.
        cp = info.get("charging_pose")
        if isinstance(cp, dict):
            try:
                cx = float(cp.get("x"))
                cy = float(cp.get("y"))
                cth = float(cp.get("orientation"))
                # 1. charging_station.yaml — auto_recharge_server's canonical
                #    source-of-truth at boot.
                yaml_path = "/userdata/lfi/charging_station_file/charging_station.yaml"
                os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
                with open(yaml_path, "w") as f:
                    f.write(f"charging_pose: [{cx}, {cy}, {cth}]\n")
            except Exception as ex:
                # Don't fail the whole sync_map for a yaml write — log and continue.
                print(f"[sync_map] charging_station.yaml write failed: {ex}")

        # 2. Mirror csv_file + x3_csv_file to /root/novabot/data/maps/home0/.
        #    Some firmware paths read from this duplicate location.
        try:
            data_home0 = "/root/novabot/data/maps/home0"
            os.makedirs(data_home0, exist_ok=True)
            for sub in ("csv_file", "x3_csv_file"):
                src_dir = f"{home0}/{sub}"
                dst_dir = f"{data_home0}/{sub}"
                if os.path.isdir(src_dir):
                    if os.path.isdir(dst_dir):
                        shutil.rmtree(dst_dir)
                    shutil.copytree(src_dir, dst_dir)
        except Exception as ex:
            print(f"[sync_map] /root mirror copy failed: {ex}")
    except Exception as e:
        respond("sync_map_respond", {"result": 1, "error": f"install: {e}"})
        return
    finally:
        try: os.remove(tmp_zip)
        except Exception: pass

    # 4. Restart novabot_mapping so coverage_planner reloads from new CSVs.
    restart_ok = _restart_novabot_mapping()

    # 5. Restart auto_recharge_server so it re-reads charging_station.yaml.
    #    It caches the dock pose at boot/respawn only — without this restart
    #    the realign would require a full mower reboot.
    auto_recharge_restart_ok = _restart_auto_recharge_server()

    # 6. Re-run set_server_urls.sh as a defensive recovery step.
    #    When the OpenNova server (Docker container) restarts, mqtt_node's
    #    ESP-IDF MQTT layer can land in a stuck state where TCP retries loop
    #    on MQTT_EVENT_INIT_NET_ERROR forever — daemon_node respawn does NOT
    #    clear it, only re-running set_server_urls.sh does. Verified live on
    #    LFIN1231000211 2026-05-03. By tagging this onto every sync_map we
    #    ensure that any apply-polygon-offset / restore-and-realign call also
    #    self-heals a stuck mqtt_node along the way.
    server_urls_ok = _rerun_set_server_urls()

    respond("sync_map_respond", {
        "result": 0,
        "md5": got_md5,
        "sizeBytes": len(zip_bytes),
        "restart": restart_ok,
        "auto_recharge_restart": auto_recharge_restart_ok,
        "server_urls_refresh": server_urls_ok,
    })


def _sn_from_config():
    try:
        with open("/userdata/lfi/json_config.json") as f:
            cfg = json.load(f)
        return cfg.get("sn", {}).get("value", {}).get("code")
    except Exception:
        return None


def _server_from_config():
    """Resolve `<host>:<port>` for the OpenNova HTTP server.

    Source of truth = `/userdata/lfi/http_address.txt` (written by
    set_server_urls.sh at every boot — already contains the user-chosen
    HTTP port from their docker compose. Don't hard-code 8080 here:
    different operators run the container on different ports (80 if free,
    8080 if Caddy/NPM owns 80, etc.).

    Fallback: when http_address.txt is missing or empty, derive the host
    from json_config.json's MQTT addr and assume port 8080 — the most
    common production default. Logged so the operator can spot the
    fallback if a download fails.
    """
    try:
        with open("/userdata/lfi/http_address.txt") as f:
            line = f.read().strip()
        if line:
            # Tolerate optional http:// prefix (firmware prepends it itself)
            if line.startswith("http://"):
                line = line[len("http://"):]
            elif line.startswith("https://"):
                line = line[len("https://"):]
            return line.rstrip("/")
    except Exception:
        pass

    try:
        with open("/userdata/lfi/json_config.json") as f:
            cfg = json.load(f)
        addr = cfg.get("mqtt", {}).get("value", {}).get("addr")
        return f"{addr}:8080" if addr else None
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
    # Both novabot_mapping AND coverage_planner_server cache the polygon CSV
    # in RAM at startup. Without restarting coverage_planner the mower keeps
    # using the pre-shift polygon for path generation even after sync_map
    # rewrote the on-disk CSVs (verified live 2026-05-05 op LFIN1231000211 —
    # coverage_planner uptime was 2d16h while disk-CSVs were freshly shifted).
    #
    # subprocess.run + nohup-in-string LOOKS detached but isn't: when the
    # bash parent exits, the kernel can deliver SIGHUP to the entire process
    # group and the just-started ros2 launch dies silently. Verified live
    # 2026-05-06: novabot_mapping died ~1h after sync_map, restart-log mtime
    # was the previous day, robot_decision then raised Error 140.
    #
    # Fix: detach via setsid + Popen(start_new_session=True) so the spawned
    # ros2 launch lives in its own session and survives Python's exit.
    import os
    import subprocess
    try:
        cmd = (
            '(pkill -f "novabot_mapping_launch.py" || true); '
            '(pkill -f "coverage_planner_server.launch.py" || true); '
            "sleep 1; "
            "(killall -9 novabot_mapping 2>/dev/null || true); "
            "(killall -9 coverage_planner_server 2>/dev/null || true); "
            "sleep 1; "
            ". /opt/ros/galactic/setup.bash; "
            ". /root/novabot/install/setup.bash; "
            "export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH; "
            "export ROS_LOG_DIR=/root/novabot/data/ros2_log; "
            "export ROS_LOCALHOST_ONLY=1; "
            # CRITICAL: cyclonedds shm transport — without these envs the
            # novabot_mapping binary inits its DDS layer with default RMW
            # which can't reach the existing peer set, segfaults silently a
            # second after launch. Restart appears to "succeed" (pgrep
            # matches the bash wrapper) but the binary was already gone.
            # Verified live LFIN1231000211 2026-05-08 — adding these envs
            # makes the launched binary survive long-term.
            "export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp; "
            "export CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml; "
            "setsid nohup ros2 launch novabot_mapping novabot_mapping_launch.py "
            ">> $ROS_LOG_DIR/novabot_mapping_restart.log 2>&1 </dev/null & "
            "setsid nohup ros2 launch coverage_planner coverage_planner_server.launch.py "
            ">> $ROS_LOG_DIR/coverage_planner_restart.log 2>&1 </dev/null & "
            "disown -a; "
            "exit 0"
        )
        subprocess.Popen(
            ["bash", "-lc", cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        # Give the kills + setsid'd launches time to settle before returning,
        # but don't wait for the launches themselves (they keep running).
        import time
        time.sleep(3)
        # Verify at least the novabot_mapping binary respawned. coverage_planner
        # is checked by sync_map's downstream verification.
        rc = subprocess.run(
            ["pgrep", "-f", "novabot_mapping/novabot_mapping"],
            capture_output=True, text=True, timeout=5,
        )
        return rc.returncode == 0
    except Exception:
        return False


def _restart_auto_recharge_server():
    """Kill auto_recharge_server so it respawns and re-reads charging_station.yaml.

    Used by handle_sync_map after the realign restore writes a new charger pose.
    auto_recharge_server caches the dock pose at boot/respawn, so without this
    restart the new yaml value is ignored until the next full mower reboot.

    The launch file uses respawn=True (per
    install/automatic_recharge/share/automatic_recharge/launch/automatic_recharge_launch.py),
    so a single pkill is sufficient — the launch supervisor brings it back
    within a few seconds.

    Returns True when pkill succeeded; False on subprocess error.
    """
    import subprocess
    try:
        # `pkill -f` matches the full command line. The exact binary path is
        # /root/novabot/install/automatic_recharge/lib/automatic_recharge/auto_recharge_server,
        # but matching the suffix is enough and survives reorganisation.
        rc = subprocess.run(
            ["pkill", "-f", "auto_recharge_server"],
            capture_output=True, text=True, timeout=5,
        )
        # pkill returns 1 when no processes matched — treat as success
        # (auto_recharge_server may not be running yet, e.g. mid-boot).
        return rc.returncode in (0, 1)
    except Exception:
        return False


def _rerun_set_server_urls():
    """Defensive recovery — re-run set_server_urls.sh to unstick mqtt_node.

    After a Docker container restart on the OpenNova server, mqtt_node's
    ESP-IDF MQTT layer can lock into an MQTT_EVENT_INIT_NET_ERROR loop that
    daemon_node respawn cannot clear. Re-running the URL bootstrap script
    forces a clean reinit (DNS lookup + http_address.txt rewrite + mqtt_node
    kill so daemon_node respawns it with a fresh socket).

    Idempotent — safe to call after every sync_map. Verified live on
    LFIN1231000211 2026-05-03: stuck mqtt_node recovered within 30 s.

    Returns True when the script executed cleanly, False on any failure
    (does NOT block the sync_map response).
    """
    import subprocess
    script = "/root/novabot/scripts/set_server_urls.sh"
    if not os.path.exists(script):
        return False
    try:
        rc = subprocess.run(
            ["bash", script],
            capture_output=True, text=True, timeout=60,
        )
        return rc.returncode == 0
    except Exception:
        return False


# ── Blade-speed telemetry relay (issue #17 follow-up) ─────────────────────
#
# The mower's chassis publishes the live blade RPM on the ROS topic
# `/blade_speed_get` (std_msgs/Int16). Stock mqtt_node never forwards this
# to the cloud, so the OpenNova app cannot tell whether the mower is
# physically cutting (blades spinning) or just driving — the difference
# matters because Mode:COVERAGE / Work:COVERING is reported even when the
# blades have been auto-stopped (e.g. mid-avoid backup, or low-battery).
#
# Bridge it through the existing extended_commands process so we don't
# need a second daemon: subscribe to /blade_speed_get in a background
# thread, publish a small JSON message to MQTT topic
# `novabot/sensor/<SN>` whenever the value CHANGES (no per-tick spam).
# The OpenNova server's broker subscribes to `novabot/sensor/+` and
# merges the field into deviceCache like any other sensor, so the app
# reads it through the standard /api/dashboard/devices/:sn endpoint.

_ROS_BLADE_NODE = [None]  # holds the live BladeRelay instance, populated once rclpy.init succeeds
_ROS_EXECUTOR = [None]               # shared SingleThreadedExecutor (blade thread owns+spins it)
_ROS_EXECUTOR_READY = threading.Event()  # set once the executor exists, so other relays can add nodes


def start_blade_telemetry_relay(sn, mqtt_ref):
    """Spin up a daemon thread that bridges /blade_speed_get → MQTT AND owns
    long-lived ROS pubs/subs for blade and RobotStatus manipulation.

    Subprocess `ros2 topic pub --once` is unreliable on Horizon X3 (DDS
    discovery takes 6-10s, `--once` exits before chassis subscribes).
    Long-lived publishers held by this daemon stay discovered across the
    session, so the next publish is delivered immediately.

    For the RobotStatus override we subscribe to robot_decision's status,
    cache the latest message, and at 50Hz republish a clone with only
    task_mode/work_status/merged_work_status modified — preserving battery,
    error_status, msg, and all the other fields so the app doesn't get a
    zeroed status (which the v8 spam-publisher caused: battery=0% notif).
    """
    try:
        import rclpy  # type: ignore
        from rclpy.node import Node  # type: ignore
        from std_msgs.msg import Int16, UInt8, String  # type: ignore
        from decision_msgs.msg import RobotStatus  # type: ignore
    except ImportError as ex:
        log(f"[BladeRelay] rclpy import failed, telemetry disabled: {ex}")
        return

    def _spin():
        try:
            try:
                rclpy.init()
            except RuntimeError:
                pass  # already initialised

            class _BladeRelay(Node):
                def __init__(self):
                    super().__init__('blade_telemetry_relay')
                    self._topic = f'novabot/sensor/{sn}'
                    self._last_value = None
                    if enable_blade_telemetry():
                        self.create_subscription(
                            Int16, '/blade_speed_get', self._on_msg, 10,
                        )
                        log(f"[BladeRelay] subscribed /blade_speed_get -> MQTT {self._topic}")
                    else:
                        log("[BladeRelay] blade telemetry disabled (set OPENNOVA_ENABLE_BLADE_TELEMETRY=1 to enable)")
                    self.speed_pub = self.create_publisher(Int16, '/blade_speed_set', 10)
                    self.height_pub = self.create_publisher(UInt8, '/blade_height_set', 10)
                    self.reset_pub = self.create_publisher(String, '/motor_driver_reset', 10)
                    # Sustained blade target: a lazy 10Hz timer publishes the
                    # current target speed/height only while manual blade control
                    # is active. Keeping that timer alive forever cost measurable
                    # CPU on hot mowers even when targets were None.
                    self.target_blade_speed = None
                    self.target_blade_height = None
                    self._blade_timer = None
                    self._blade_idle_until = None
                    # Keep one very low-frequency waitable so rclpy's executor
                    # can sleep cleanly even when telemetry and blade targets are
                    # both idle. Publishers alone are not executor waitables.
                    self.create_timer(60.0, lambda: None)
                    # RobotStatus passthrough: cache real status from
                    # robot_decision; republish a modified clone at 50Hz when
                    # override_active is True. Subscription + 50Hz timer are
                    # LAZILY created via _arm_status_override() so the heavy
                    # callback path does not burn CPU while blade-override is
                    # idle (>99% of mower lifetime — see issue #60). The
                    # publisher stays up because creation is cheap and it
                    # lets us publish-without-arm in the future if needed.
                    self._status_last = None
                    self.status_pub = self.create_publisher(
                        RobotStatus, '/robot_decision/robot_status', 10,
                    )
                    self._status_sub = None
                    self._status_timer = None
                    self.override_active = False
                    log("[BladeRelay] publishers ready: blade ops + RobotStatus override (lazy)")

                def _arm_blade_timer(self):
                    if self._blade_timer is None:
                        self._blade_timer = self.create_timer(0.1, self._tick_blade)
                        log("[BladeRelay] blade target timer armed")

                def _schedule_idle_disarm(self):
                    self._blade_idle_until = time.monotonic() + blade_idle_hold_seconds()

                def set_blade_speed_target(self, speed):
                    self.target_blade_speed = int(speed)
                    if int(speed) == 0:
                        self._schedule_idle_disarm()
                    else:
                        self._blade_idle_until = None
                    self._arm_blade_timer()

                def set_blade_height_target(self, mm):
                    self.target_blade_height = int(mm)
                    if self.target_blade_speed in (None, 0):
                        self._schedule_idle_disarm()
                    self._arm_blade_timer()

                def _arm_status_override(self):
                    """Create subscription + 50Hz republish timer. Idempotent.

                    Called when manual blade-on activates. Without lazy arm
                    the 50Hz timer + RobotStatus callback fired constantly
                    (issue #60: ~30% CPU per worker thread on ARM, even idle).
                    """
                    if self._status_sub is None:
                        self._status_sub = self.create_subscription(
                            RobotStatus, '/robot_decision/robot_status',
                            self._on_status, 10,
                        )
                    if self._status_timer is None:
                        self._status_timer = self.create_timer(
                            0.02, self._republish_status,
                        )  # 50Hz
                    self.override_active = True
                    log("[BladeRelay] override armed (subscription + 50Hz timer up)")

                def _disarm_status_override(self):
                    """Destroy subscription + timer. Idempotent."""
                    self.override_active = False
                    if self._status_timer is not None:
                        try:
                            self.destroy_timer(self._status_timer)
                        except Exception as ex:
                            log(f"[BladeRelay] destroy timer failed: {ex}")
                        self._status_timer = None
                    if self._status_sub is not None:
                        try:
                            self.destroy_subscription(self._status_sub)
                        except Exception as ex:
                            log(f"[BladeRelay] destroy sub failed: {ex}")
                        self._status_sub = None
                    self._status_last = None
                    log("[BladeRelay] override disarmed (subscription + timer down)")

                def _on_msg(self, msg):
                    value = int(msg.data)
                    if value == self._last_value:
                        return  # debounce — only publish on change
                    self._last_value = value
                    if mqtt_ref[0] is None:
                        return  # MQTT not yet connected
                    try:
                        mqtt_ref[0].publish(
                            self._topic,
                            json.dumps({'blade_speed': value}),
                        )
                    except Exception as ex:
                        log(f"[BladeRelay] publish failed: {ex}")

                def _tick_blade(self):
                    if self.target_blade_height is not None:
                        try:
                            m = UInt8()
                            m.data = int(self.target_blade_height)
                            self.height_pub.publish(m)
                        except Exception as ex:
                            log(f"[BladeRelay] height tick failed: {ex}")
                    if self.target_blade_speed is not None:
                        try:
                            m = Int16()
                            m.data = int(self.target_blade_speed)
                            self.speed_pub.publish(m)
                        except Exception as ex:
                            log(f"[BladeRelay] speed tick failed: {ex}")
                    if self._blade_idle_until is not None and time.monotonic() >= self._blade_idle_until:
                        self.target_blade_height = None
                        self.target_blade_speed = None
                        self._blade_idle_until = None
                        if self._blade_timer is not None:
                            try:
                                self.destroy_timer(self._blade_timer)
                            except Exception as ex:
                                log(f"[BladeRelay] destroy blade timer failed: {ex}")
                            self._blade_timer = None
                            log("[BladeRelay] blade target timer idle")

                def _on_status(self, msg):
                    # Only cache messages NOT produced by ourselves. rclpy's
                    # RMW already filters intraprocess loopback, but if it
                    # didn't we'd snap onto our own modified value and never
                    # get the real battery/error fields. Identify our own
                    # clones by the override-marker work_status=10 + COVER —
                    # robot_decision never sets that combo in manual control.
                    if (self.override_active
                            and int(msg.work_status) == 10
                            and int(msg.merged_work_status) == 1):
                        return
                    self._status_last = msg

                def _republish_status(self):
                    if not self.override_active or self._status_last is None:
                        return
                    out = RobotStatus()
                    src = self._status_last
                    for slot in src.__slots__:
                        try:
                            setattr(out, slot, getattr(src, slot))
                        except Exception:
                            pass
                    # Override the 3 fields the STM32 blade-enable gate
                    # checks (chassis_control_node forwards UART cmd 0x50
                    # with mode-byte derived from merged_work_status; STM32
                    # only enables the cutting motor when this resolves to
                    # the COVERING state).
                    out.task_mode = 1
                    out.work_status = 10
                    out.merged_work_status = 1  # RobotStatus.COVER
                    try:
                        self.status_pub.publish(out)
                    except Exception as ex:
                        log(f"[BladeRelay] status republish failed: {ex}")

            from rclpy.executors import SingleThreadedExecutor  # type: ignore
            node = _BladeRelay()
            _ROS_BLADE_NODE[0] = node
            ex = SingleThreadedExecutor()
            ex.add_node(node)
            _ROS_EXECUTOR[0] = ex
            _ROS_EXECUTOR_READY.set()
            ex.spin()
        except Exception as ex:
            log(f"[BladeRelay] crashed: {ex}")

    t = threading.Thread(target=_spin, daemon=True, name='blade-relay')
    t.start()


# ── charging_station.yaml guard ───────────────────────────────────────────────
# Stock novabot_mapping's MapGenerator::saveMap(type:1) reads
#   <mapdir>/charging_station_file/charging_station.yaml
# via an UNGUARDED  YAML::LoadFile(...)["charging_pose"].as<std::vector<double>>()
# (Ghidra @0x4275). If that file is missing/malformed, yaml-cpp throws
# YAML::InvalidNode and the whole node terminates -> the app sees Error 140 (then
# 120) right after an obstacle / multi-map save. The sibling writeCharingPose
# guards the IDENTICAL read with access() first; saveMap does not. So just keeping
# the file present with a valid charging_pose makes the read succeed and the crash
# disappears -- no binary patch. Corroborated by dont-wipe-charging-station-yaml.
_CHG_POSE_RE = re.compile(r"charging_pose\s*:\s*\[([^\]]+)\]")


def _charging_pose_yaml_ok(path):
    """True if `path` holds charging_pose as a list of >= 2 numbers."""
    try:
        with open(path) as f:
            m = _CHG_POSE_RE.search(f.read())
    except OSError:
        return False
    if not m:
        return False
    try:
        return len([float(x) for x in m.group(1).split(",")]) >= 2
    except ValueError:
        return False


def _charging_pose_source(base):
    """YAML content for charging_station.yaml, sourced from the recalibrate-written
    <base>/charging_station.yaml (verbatim) or map_info.json's charging_pose. None
    if no usable source exists yet."""
    src = os.path.join(base, "charging_station.yaml")
    if _charging_pose_yaml_ok(src):
        try:
            with open(src) as f:
                return f.read()
        except OSError:
            pass
    for sub in ("csv_file", "x3_csv_file"):
        try:
            with open(os.path.join(base, sub, "map_info.json")) as f:
                cp = (json.load(f) or {}).get("charging_pose")
            if isinstance(cp, dict) and "x" in cp and "y" in cp:
                return "charging_pose: [%s, %s, %s]\n" % (
                    cp["x"], cp["y"], cp.get("orientation", 0.0))
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return None


def _guard_firmware_charging_station():
    """Keep the TOP-LEVEL /userdata/lfi/charging_station_file/charging_station.yaml
    valid — the file the stock firmware (save_map type:1 / auto_recharge) reads and
    transiently empties on a map-delete (Error 120/140). Snapshot it while valid and
    restore the EXACT pose when it goes empty/missing. We restore from a last-known-
    good backup of THIS file, never from a per-home [0,0] copy, so we can't dock the
    robot at the wrong spot."""
    try:
        if _charging_pose_yaml_ok(_FW_CS_YAML):
            with open(_FW_CS_YAML) as f:
                cur = f.read()
            try:
                with open(_FW_CS_BAK) as f:
                    if f.read() == cur:
                        return
            except OSError:
                pass
            tmp = _FW_CS_BAK + ".tmp"
            with open(tmp, "w") as f:
                f.write(cur)
            os.replace(tmp, _FW_CS_BAK)
        elif _charging_pose_yaml_ok(_FW_CS_BAK):
            os.makedirs(os.path.dirname(_FW_CS_YAML), exist_ok=True)
            with open(_FW_CS_BAK) as f:
                body = f.read()
            tmp = _FW_CS_YAML + ".tmp"
            with open(tmp, "w") as f:
                f.write(body)
            os.replace(tmp, _FW_CS_YAML)
            log("[chg-guard] restored firmware charging_station.yaml from last-known-good backup")
    except OSError as ex:
        log("[chg-guard] firmware-yaml guard error: %s" % ex)


def _ensure_charging_station_yaml():
    _guard_firmware_charging_station()   # the top-level file the firmware actually reads
    maps_root = "/userdata/lfi/maps"
    try:
        # active map homes only (home0, home1, ...) — skip home0.bak.<ts> backups
        homes = [d for d in os.listdir(maps_root) if d.startswith("home") and "." not in d]
    except OSError:
        return
    for home in homes:
        base = os.path.join(maps_root, home)
        target = os.path.join(base, "charging_station_file", "charging_station.yaml")
        if _charging_pose_yaml_ok(target):
            continue
        content = _charging_pose_source(base)
        if content is None:
            continue
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            tmp = target + ".tmp"
            with open(tmp, "w") as f:
                f.write(content)
            os.replace(tmp, target)
            log("[chg-guard] (re)created %s" % target)
        except OSError as ex:
            log("[chg-guard] write failed %s: %s" % (target, ex))


def start_charging_station_guard():
    """Background guard: keep charging_station_file/charging_station.yaml present so
    stock save_map type:1 can never crash on a missing file (Error 140).
    Set OPENNOVA_DISABLE_CHG_GUARD=1 to suppress it (diagnostics / preflight
    testing — lets a deliberately-removed charging_station.yaml stay removed)."""
    if os.environ.get("OPENNOVA_DISABLE_CHG_GUARD") == "1":
        log("[chg-guard] disabled via OPENNOVA_DISABLE_CHG_GUARD=1")
        return
    def _loop():
        while True:
            try:
                _ensure_charging_station_yaml()
            except Exception as ex:
                log("[chg-guard] loop error: %s" % ex)
            time.sleep(charging_station_guard_interval_seconds())
    threading.Thread(target=_loop, daemon=True, name="charging-station-guard").start()
    log("[chg-guard] started — ensures charging_station.yaml for save_map type:1 "
        f"(interval={charging_station_guard_interval_seconds()}s)")


# Active-coverage work states in robot_decision's status msg. Mirrors the
# dashboard's coverageSessionActive: PAUSED/USER_STOP and FINISHED/CANCELLED are
# NOT active. "COVERING" also matches "BOUNDARY_COVERING" (re \w+ keeps the token).
_CADENCE_ACTIVE_WORK = (
    "RUNNING", "COVERING", "NAVIGATING", "BOUNDARY_COVERING", "AVOIDING", "MOVING",
)


def _newest_robot_decision_log():
    """Path of the most recently modified robot_decision_*.log, or None."""
    d = "/root/novabot/data/ros2_log"
    try:
        fs = [os.path.join(d, f) for f in os.listdir(d)
              if f.startswith("robot_decision_") and f.endswith(".log")]
    except OSError:
        return None
    return max(fs, key=os.path.getmtime) if fs else None


def _cadence_coverage_active():
    """Whether robot_decision is in an active coverage state RIGHT NOW.

    Reads the latest `Mode:... Work:<state> ...` line straight from the TAIL of
    robot_decision's log (the same string the server sees over MQTT) and applies
    the same predicate. Requires a FRESH line (<60s) so a stale 'COVERING' left
    after a crash/idle does not keep the cadence running. Returns (active, reason).

    NOTE: reads the file tail directly in Python — NOT via `bash -lc grep ...`.
    That subprocess took ~5s here (the login shell sources the ROS env, slow under
    mow-time CPU load) and blew the 5s timeout EVERY poll, so the cadence never
    armed while mowing (the log only showed `idle (… err: … timed out …)`). A
    direct tail read is ~10ms. Do NOT reintroduce a shell subprocess here.
    """
    try:
        path = _newest_robot_decision_log()
        if not path:
            return False, "no-log"
        # The Work: line we need is near the end; read only the last ~200 KB.
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > 200_000:
                fh.seek(-200_000, os.SEEK_END)
            text = fh.read().decode("utf-8", "replace")
        line = None
        for ln in text.splitlines():
            if "Work:" in ln:
                line = ln
        if not line:
            return False, "no-work-line"
        stamp = re.search(r"\[(\d{10}\.\d+)\]", line)
        if stamp and (time.time() - float(stamp.group(1))) > 60.0:
            return False, "stale"
        # A return-to-charge runs its OWN perception + nav (auto_recharge_server
        # drives to the guide pose, then visually docks on the ArUco marker). The
        # cadence must NOT touch /perception/set_infer_model during that: flipping
        # the model mid-dock starves the nav costmap of terrain segmentation, the
        # dock approach gets seen as occupied, and the recharge aborts (error 126).
        # robot_decision reports the recharge phase on the SAME line; anything
        # other than an idle/terminal phase means a dock attempt is in progress,
        # so we hard-gate the cadence off regardless of Work: (which is WAIT, or a
        # transient MOVING, during the return drive).
        rm = re.search(r"Recharge:\s*(\w+)", line)
        if rm and rm.group(1) not in ("IDLE", "FINISHED", "CANCELLED", "FAILED", "WAIT", "NONE"):
            return False, f"recharge={rm.group(1)}"
        wm = re.search(r"Work:(\w+)", line)
        work = wm.group(1) if wm else "?"
        if work in ("FINISHED", "CANCELLED"):
            return False, f"work={work}"
        return (work in _CADENCE_ACTIVE_WORK), f"work={work}"
    except Exception as ex:
        return False, f"err:{ex}"


# ── Persistent perception model-switch client ─────────────────────────────────
# The cadence flips /perception/set_infer_model on every detection window. Doing
# that with `ros2 service call` (a subprocess that sources the ROS env + starts
# the ros2 CLI) measured ~13s/call here (env-source 5s + CLI discovery ~8s) under
# mow-time CPU load and blew the 10s timeout EVERY time — the cadence armed but
# never actually switched models. A persistent rclpy client on the shared executor
# makes each switch a normal async call (ms). Do NOT go back to a per-flip subprocess.
# (node, set_infer_model[SetUint8], set_detection_mode[SetBool], set_semantic_mode[SemanticMode])
_PERCEPTION_CLI = [None]


def start_perception_model_client():
    """Long-lived clients for the perception + costmap services that the stock
    `RobotDecision::setPerceptionLevel(3)` (= obstacle-avoidance HIGH) drives, added
    to the shared executor (owned by the blade relay). Verified by disassembly:
    HIGH = set_infer_model(1) + set_detection_mode(false) + set_semantic_mode(FREE_MOVE).
    The cadence uses these to do a detection pass and then restore the FULL HIGH
    costmap config — flipping only the model (the old behaviour) left the costmap in
    a non-HIGH state, so low (~0.3m) height cells read as obstacles and the
    return-to-charge nav wedged on `goal occupied` (error 126).
      /perception/set_infer_model        general_msgs/SetUint8
      /local_costmap/set_detection_mode  std_srvs/SetBool
      /local_costmap/set_semantic_mode   nav2_msgs/SemanticMode (FREE_MOVE=1)
    """
    try:
        import rclpy  # type: ignore  # noqa: F401
        from rclpy.node import Node  # type: ignore
        from general_msgs.srv import SetUint8  # type: ignore
        from std_srvs.srv import SetBool  # type: ignore
    except ImportError as ex:
        log(f"[perception-cli] core import failed — cadence falls back to subprocess: {ex}")
        return

    def _setup():
        try:
            # The blade relay owns rclpy.init() + the shared executor; wait for it.
            if not _ROS_EXECUTOR_READY.wait(timeout=120):
                log("[perception-cli] shared executor never became ready; giving up")
                return
            node = Node("perception_model_client")
            infer = node.create_client(SetUint8, "/perception/set_infer_model")
            det = node.create_client(SetBool, "/local_costmap/set_detection_mode")
            sem = None
            try:
                from nav2_msgs.srv import SemanticMode  # type: ignore
                sem = node.create_client(SemanticMode, "/local_costmap/set_semantic_mode")
            except ImportError as ex:
                log(f"[perception-cli] nav2_msgs SemanticMode unavailable — semantic-mode restore disabled: {ex}")
            _ROS_EXECUTOR[0].add_node(node)
            _PERCEPTION_CLI[0] = (node, infer, det, sem)
            ri = infer.wait_for_service(timeout_sec=15.0)
            log(f"[perception-cli] clients ready (infer={ri}, detection_mode+semantic_mode added)")
        except Exception as ex:
            log(f"[perception-cli] setup failed: {ex}")

    threading.Thread(target=_setup, daemon=True, name="perception-cli-setup").start()


def _await_future(future, timeout):
    """Poll a future the shared executor (blade thread) is completing for us."""
    deadline = time.time() + timeout
    while not future.done() and time.time() < deadline:
        time.sleep(0.02)
    return bool(future.done()) and future.result() is not None


def _set_infer_model_fast(model_id, timeout=4.0):
    """Switch the perception model via the persistent rclpy client. Returns True on
    success, False on any failure/timeout (caller falls back to the subprocess)."""
    entry = _PERCEPTION_CLI[0]
    if entry is None:
        return False
    _node, cli, _det, _sem = entry
    try:
        from general_msgs.srv import SetUint8  # type: ignore
        if not cli.service_is_ready() and not cli.wait_for_service(timeout_sec=1.0):
            return False
        req = SetUint8.Request()
        req.value = int(model_id)
        return _await_future(cli.call_async(req), timeout)
    except Exception:
        return False


def _set_detection_mode_fast(on, timeout=4.0):
    """/local_costmap/set_detection_mode (SetBool). HIGH wants False."""
    entry = _PERCEPTION_CLI[0]
    if entry is None:
        return False
    _node, _cli, det, _sem = entry
    if det is None:
        return False
    try:
        from std_srvs.srv import SetBool  # type: ignore
        if not det.service_is_ready() and not det.wait_for_service(timeout_sec=1.0):
            return False
        req = SetBool.Request()
        req.data = bool(on)
        return _await_future(det.call_async(req), timeout)
    except Exception:
        return False


def _set_semantic_mode_fast(mode, timeout=4.0):
    """/local_costmap/set_semantic_mode (nav2_msgs/SemanticMode). HIGH wants FREE_MOVE=1."""
    entry = _PERCEPTION_CLI[0]
    if entry is None:
        return False
    _node, _cli, _det, sem = entry
    if sem is None:
        return False
    try:
        from nav2_msgs.srv import SemanticMode  # type: ignore
        if not sem.service_is_ready() and not sem.wait_for_service(timeout_sec=1.0):
            return False
        req = SemanticMode.Request()
        req.semantic_mode = int(mode)
        return _await_future(sem.call_async(req), timeout)
    except Exception:
        return False


def start_obstacle_detection_cadence():
    """Background cadence: while actively COVERING and level>1, periodically flip the
    perception model to DETECTION (id 2) for a short window then back to
    SEGMENTATION (id 1), so a sensitivity=3 (segmentation/stay-on-lawn) mow ALSO
    detects loose objects. Single BPU: never two inferences in one frame.

    Observable by design: logs every gate transition and every set_infer_model
    flip — the prior version was silent, so a non-firing cadence was invisible.
    Level is loaded from the persisted file so it survives an extended_commands
    respawn (the server only re-pushes it on a fresh MQTT (re)connect).
    """
    global _obstacle_detection_level
    _obstacle_detection_level = _load_obstacle_detection_level()

    def _set_model(model_id):
        name = "detection" if model_id == 2 else "segmentation"
        # Fast path: persistent rclpy client (ms). The subprocess path is ~13s under
        # mow load and blows its timeout, so it is only a last-resort fallback for
        # when the client never came up (e.g. the service was absent at startup).
        if _set_infer_model_fast(model_id):
            log(f"[obstacle-detect] set_infer_model({model_id}) ok ({name}) [rclpy]")
            return True
        try:
            ros2_run(
                ["ros2", "service", "call", "/perception/set_infer_model",
                 "general_msgs/srv/SetUint8", f"'{{value: {model_id}}}'"],
                timeout=10,
            )
            log(f"[obstacle-detect] set_infer_model({model_id}) ok ({name}) [subprocess]")
            return True
        except Exception as ex:
            log(f"[obstacle-detect] set_infer_model({model_id}) FAILED ({name}): {ex}")
            return False

    # nav2_msgs/SemanticMode: LAWN_COVER=0, FREE_MOVE=1, BOUNDARY_FOLLOW=2, IGNORE_SEMANTIC=3
    _FREE_MOVE = 1

    def _apply_high():
        """Restore stock obstacle-avoidance HIGH on the perception + costmap, exactly
        as RobotDecision::setPerceptionLevel(3) does (proven by disassembly):
        segmentation model + costmap detection OFF + semantic FREE_MOVE. This is the
        config nav / auto-recharge need so low (~0.3m) height cells read as
        traversable lawn, not obstacles. Flipping only the model is NOT enough."""
        _set_model(1)
        _set_detection_mode_fast(False)
        _set_semantic_mode_fast(_FREE_MOVE)

    def _apply_detection():
        """Detection pass (≈ stock MED): detection model + costmap detection ON, so
        the costmap actually consumes the object detections during the window."""
        _set_model(2)
        _set_detection_mode_fast(True)

    def _loop():
        last_state = None  # (running, level) — log only on change to avoid spam
        while True:
            try:
                level = _obstacle_detection_level
                period = obstacle_detect_period(level)
                active, reason = _cadence_coverage_active()
                running = active and period is not None
                if (running, level) != last_state:
                    log(f"[obstacle-detect] {'ACTIVE cadence' if running else 'idle'} "
                        f"(level={level}, {reason})")
                    # On the active->idle edge, force perception back to SEGMENTATION
                    # so nav / auto-recharge always inherit terrain data. A cycle
                    # interrupted mid-detection-window (e.g. coverage finished right
                    # after _set_model(2)) would otherwise strand the model on
                    # DETECTION exactly when the return-to-charge needs the costmap.
                    if last_state is not None and last_state[0] and not running:
                        _apply_high()
                        log("[obstacle-detect] coverage ended -> restored HIGH (seg + detection-off + FREE_MOVE)")
                    last_state = (running, level)
                if not running:
                    time.sleep(obstacle_detect_idle_poll_seconds())
                    continue
                window = obstacle_detect_window_seconds()
                _apply_detection()       # detection pass: model 2 + costmap detection ON
                time.sleep(window)
                _apply_high()            # back to HIGH: model 1 + detection OFF + FREE_MOVE
                time.sleep(max(0.0, period - window))
            except Exception as ex:
                log(f"[obstacle-detect] loop error: {ex}")
                time.sleep(obstacle_detect_idle_poll_seconds())

    threading.Thread(target=_loop, daemon=True, name="obstacle-detect-cadence").start()
    log(f"[obstacle-detect] cadence thread started (level={_obstacle_detection_level})")


def start_rtk_telemetry_relay(sn, mqtt_ref):
    """Spin up a daemon node that bridges GNSS + localization state -> MQTT.

    Publishes to novabot/sensor/<SN> (broker auto-merges into deviceCache):
      - rtk_fix_quality / rtk_sat : from novabot_msgs/BestPos (.qual / .svs).
      - heading_deg               : the localization map-frame yaw, derived from
                                    /robot_combination_localization/odom
                                    (nav_msgs/Odometry) orientation quaternion.
      - gnss_track_deg / gnss_speed : the GNSS course-over-ground and horizontal
                                    speed, from novabot_msgs/BestVel
                                    (.trk_gnd / .hor_spd). Only meaningful while
                                    the mower is moving.
    Publish on change plus a 2s heartbeat so late-joining subscribers see the
    current values. The "is the heading good" conclusion is left to the client
    (compare heading_deg with gnss_track_deg while driving straight).
    """
    try:
        import math  # type: ignore
        import rclpy  # type: ignore
        from rclpy.node import Node  # type: ignore
        from novabot_msgs.msg import BestPos, BestVel  # type: ignore
        from nav_msgs.msg import Odometry  # type: ignore
    except ImportError as ex:
        log(f"[RtkRelay] import failed, RTK telemetry disabled: {ex}")
        return

    def _yaw_deg(q):
        # quaternion -> yaw (Z) in degrees
        siny = 2.0 * (q.w * q.z + q.x * q.y)
        cosy = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
        return round(math.degrees(math.atan2(siny, cosy)), 1)

    def _spin():
        try:
            # The blade relay owns rclpy.init() and the shared executor.
            # Wait for it to come up, then add our node to the SAME executor
            # (two rclpy.spin() calls on the default context race and crash:
            # "generator already executing"). Do NOT spin here.
            if not _ROS_EXECUTOR_READY.wait(timeout=30.0):
                log("[RtkRelay] shared ROS executor not ready after 30s, RTK telemetry disabled")
                return

            class _RtkRelay(Node):
                def __init__(self):
                    super().__init__('rtk_telemetry_relay')
                    self._topic = f'novabot/sensor/{sn}'
                    self._last_qual = None
                    self._last_sat = None
                    self._last_heading = None
                    self._last_track = None
                    self._last_speed = None
                    # Always: the cheap fix-quality indicator (~5Hz light callback).
                    self.create_subscription(
                        BestPos, '/bestpos_parsed_data', self._on_bestpos, 10,
                    )
                    # Opt-in: heavier heading + GNSS-velocity telemetry (~10Hz of
                    # high-rate subs). Only for heading-discovery / re-anchor
                    # diagnostics — off by default for thermal headroom (#85).
                    if enable_heading_telemetry():
                        self.create_subscription(
                            Odometry, '/robot_combination_localization/odom', self._on_odom, 10,
                        )
                        self.create_subscription(
                            BestVel, '/bestvel_parsed_data', self._on_bestvel, 10,
                        )
                        log(f"[RtkRelay] subscribed bestpos + heading/bestvel -> MQTT {self._topic}")
                    else:
                        log(f"[RtkRelay] subscribed bestpos (fix-quality only) -> MQTT {self._topic} "
                            "(set OPENNOVA_ENABLE_HEADING_TELEMETRY=1 for heading_deg/gnss_track)")
                    self.create_timer(2.0, self._heartbeat)

                def _pub(self, payload):
                    if mqtt_ref[0] is None:
                        return
                    try:
                        mqtt_ref[0].publish(self._topic, json.dumps(payload))
                    except Exception as ex:
                        log(f"[RtkRelay] publish failed: {ex}")

                def _on_bestpos(self, msg):
                    q = int(msg.qual)
                    sat = int(msg.svs)
                    if q == self._last_qual and sat == self._last_sat:
                        return
                    self._last_qual = q
                    self._last_sat = sat
                    self._pub({'rtk_fix_quality': q, 'rtk_sat': sat})

                def _on_odom(self, msg):
                    yaw = _yaw_deg(msg.pose.pose.orientation)
                    if yaw == self._last_heading:
                        return
                    self._last_heading = yaw
                    self._pub({'heading_deg': yaw})

                def _on_bestvel(self, msg):
                    track = round(float(msg.trk_gnd), 1)
                    speed = round(float(msg.hor_spd), 2)
                    if track == self._last_track and speed == self._last_speed:
                        return
                    self._last_track = track
                    self._last_speed = speed
                    self._pub({'gnss_track_deg': track, 'gnss_speed': speed})

                def _heartbeat(self):
                    payload = {}
                    if self._last_qual is not None:
                        payload['rtk_fix_quality'] = self._last_qual
                        payload['rtk_sat'] = self._last_sat
                    if self._last_heading is not None:
                        payload['heading_deg'] = self._last_heading
                    if self._last_track is not None:
                        payload['gnss_track_deg'] = self._last_track
                        payload['gnss_speed'] = self._last_speed
                    if payload:
                        self._pub(payload)

            node = _RtkRelay()
            _ROS_EXECUTOR[0].add_node(node)
            log("[RtkRelay] node added to shared executor")
            # No spin: the blade-relay thread's executor services this node.
        except Exception as ex:
            log(f"[RtkRelay] crashed: {ex}")

    t = threading.Thread(target=_spin, daemon=True, name='rtk-relay')
    t.start()


def _ros_publish_blade_speed_native(speed: int) -> bool:
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return False
    try:
        from std_msgs.msg import Int16  # type: ignore
        msg = Int16()
        msg.data = int(speed)
        node.speed_pub.publish(msg)
        return True
    except Exception as ex:
        log(f"[blade-pub] speed native publish failed: {ex}")
        return False


def _ros_publish_blade_height_native(mm: int) -> bool:
    node = _ROS_BLADE_NODE[0]
    if node is None:
        return False
    try:
        from std_msgs.msg import UInt8  # type: ignore
        msg = UInt8()
        msg.data = int(mm)
        node.height_pub.publish(msg)
        return True
    except Exception as ex:
        log(f"[blade-pub] height native publish failed: {ex}")
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

    # Auto-reap fire-and-forget child processes. Many helpers spawn
    # subprocess.Popen(...) for "send command and forget" RPC (e.g. ros2
    # action send_goal wrappers, set_server_urls.sh dispatch). Without an
    # explicit wait() or SIGCHLD-IGN, exited children pile up as zombies
    # ([bash] <defunct> in ps) — issue #60 caught one with PID 94309 PPID
    # = extended_commands. SIG_IGN tells the kernel to auto-reap exited
    # children so they never become zombies.
    try:
        signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    except (AttributeError, ValueError) as ex:
        log(f"SIGCHLD ignore not supported on this platform: {ex}")

    # Lees configuratie
    sn, mqtt_addr, mqtt_port = read_config()
    sub_topic = f"novabot/extended/{sn}"
    resp_topic = f"novabot/extended_response/{sn}"
    log(f"SN={sn}, MQTT={mqtt_addr}:{mqtt_port}")
    log(f"Subscribe: {sub_topic}")
    log(f"Response:  {resp_topic}")

    # Reference to current MQTT client (for publishing responses)
    mqtt_ref = [None]

    # Spin up the ROS -> MQTT blade-RPM relay in a background thread. It uses
    # mqtt_ref so it auto-picks-up the most recent connected client across
    # reconnects without needing its own MQTT loop.
    start_blade_telemetry_relay(sn, mqtt_ref)

    # Optional ROS -> MQTT RTK/heading relay. Keep it opt-in because it
    # subscribes to high-rate localization topics and can cost noticeable CPU
    # on hot mowers.
    if enable_rtk_telemetry():
        start_rtk_telemetry_relay(sn, mqtt_ref)
    else:
        log("[RtkRelay] disabled (set OPENNOVA_ENABLE_RTK_TELEMETRY=1 to enable)")

    # Keep charging_station.yaml present so stock save_map type:1 never crashes
    # (Error 140) on a missing file — see start_charging_station_guard().
    # (Test 2026-06-02 confirmed the guard does NOT block the re-anchor write —
    # save_recharge_pos writes nothing whether the file is present or absent.)
    start_charging_station_guard()
    start_perception_model_client()
    # Object-detection cadence DISABLED. OpenNova now drives the mower's STOCK
    # perception directly from obstacle_avoidance_sensitivity (0..3) via
    # set_para_info (server mapSync forces the cadence republish to level 1).
    # The cadence's detection windows also flipped semantic mode to FREE_MOVE
    # (_apply_high), which makes nav ignore the lawn boundary -> the mower drove
    # over the border mid-cover. Not starting the thread keeps semantic at the
    # stock LAWN_COVER and the perception model under stock control.
    # start_obstacle_detection_cadence()  # intentionally disabled

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
