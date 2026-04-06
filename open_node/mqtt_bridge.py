#!/usr/bin/env python3
"""
open_node/mqtt_bridge.py — Open source vervanging van de proprietary mqtt_node binary.

MQTT <-> ROS2 bridge voor de Novabot maaier:
- Subscribe op Dart/Send_mqtt/<SN> (app->maaier commando's)
- Vertaal JSON commando's naar ROS2 service calls
- Publiceer robot_status + sensor data als versleuteld MQTT
- Forward OTA commando's naar ota_client_node

Vervangt: /userdata/novabot/bin/mqtt_node (6.3MB ARM64 closed-source)
Draait naast: robot_decision.py, extended_commands.py (deprecated door dit script)

Geen externe dependencies buiten Python stdlib + ROS2 + pycryptodome (al op maaier).
"""

import json
import math
import os
import signal
import socket
import struct
import sys
import threading
import time

# ── Logging ──────────────────────────────────────────────────────────────────

LOG_PREFIX = "[MQTT-BRIDGE]"

def log(msg):
    print(f"{LOG_PREFIX} {msg}", flush=True)

def log_warn(msg):
    print(f"{LOG_PREFIX} WARN: {msg}", flush=True)

def log_err(msg):
    print(f"{LOG_PREFIX} ERROR: {msg}", flush=True)


# ── Configuration ────────────────────────────────────────────────────────────

MQTT_RECONNECT_INTERVAL = 5
MQTT_KEEPALIVE = 60
STATUS_PUBLISH_INTERVAL = 2.0   # Publish robot status every 2s
NET_CHECK_INTERVAL = 27         # HTTP health check interval (matches stock mqtt_node)

CONFIG_FILE = "/userdata/lfi/json_config.json"
HTTP_ADDR_FILE = "/userdata/lfi/http_address.txt"
VERSION_FILE = "/userdata/lfi/system_version.txt"


def read_config():
    """Read SN, MQTT broker address, and other config from json_config.json."""
    sn = None
    mqtt_addr = "127.0.0.1"
    mqtt_port = 1883

    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
        sn = cfg.get("sn", {}).get("value", {}).get("code")
        mqtt_addr = cfg.get("mqtt", {}).get("value", {}).get("addr", mqtt_addr)
        mqtt_port = int(cfg.get("mqtt", {}).get("value", {}).get("port", mqtt_port))
    except Exception as e:
        log_err(f"Config read failed: {e}")

    if not sn or sn == "LFIN_ERROR_ERROR":
        log_warn("No valid SN found in config")
        sn = None

    return sn, mqtt_addr, mqtt_port


def read_firmware_version():
    """Read firmware version from novabot_api.yaml."""
    try:
        api_file = "/userdata/lfi/novabot_api.yaml"
        with open(api_file) as f:
            for line in f:
                if "novabot_version_code" in line:
                    return line.split(":", 1)[1].strip().strip("'\"")
    except Exception:
        pass
    try:
        with open(VERSION_FILE) as f:
            return f.read().strip()
    except Exception:
        return "unknown"


# ── AES-128-CBC Encryption/Decryption ────────────────────────────────────────

AES_KEY_PREFIX = b'abcdabcd1234'
AES_IV = b'abcd1234abcd1234'

def _aes_key(sn):
    """Derive AES key from SN: 'abcdabcd1234' + last 4 chars of SN."""
    return AES_KEY_PREFIX + sn[-4:].encode('utf-8')

def aes_encrypt(plaintext_str, sn):
    """Encrypt JSON string with AES-128-CBC, null-byte padding."""
    from Crypto.Cipher import AES as AES_Cipher
    key = _aes_key(sn)
    plaintext = plaintext_str.encode('utf-8')
    # Pad to 16-byte boundary with null bytes
    padded_len = math.ceil(len(plaintext) / 16) * 16
    padded = bytearray(padded_len)
    padded[:len(plaintext)] = plaintext
    cipher = AES_Cipher.new(key, AES_Cipher.MODE_CBC, AES_IV)
    return cipher.encrypt(bytes(padded))

def aes_decrypt(ciphertext, sn):
    """Decrypt AES-128-CBC payload, strip null-byte padding, return JSON string."""
    from Crypto.Cipher import AES as AES_Cipher
    if len(ciphertext) < 16 or len(ciphertext) % 16 != 0:
        return None
    key = _aes_key(sn)
    cipher = AES_Cipher.new(key, AES_Cipher.MODE_CBC, AES_IV)
    decrypted = cipher.decrypt(ciphertext)
    # Strip null-byte padding
    end = len(decrypted)
    while end > 0 and decrypted[end - 1] == 0:
        end -= 1
    if end == 0:
        return None
    try:
        text = decrypted[:end].decode('utf-8')
        if text[0] not in '{[':
            return None
        return text
    except (UnicodeDecodeError, IndexError):
        return None


# ── Minimale MQTT 3.1.1 client ──────────────────────────────────────────────
# Copied from led_bridge.py — zero external dependencies.

class MiniMQTT:
    """Minimal MQTT 3.1.1 client with subscribe + publish support."""

    def __init__(self, broker_host, broker_port, client_id, on_message=None):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.client_id = client_id
        self.on_message = on_message
        self._sock = None
        self._connected = False
        self._subscriptions = []
        self._lock = threading.Lock()

    def connect(self):
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(MQTT_KEEPALIVE + 10)
        self._sock.connect((self.broker_host, self.broker_port))
        client_id_bytes = self.client_id.encode('utf-8')
        var_header = (
            b'\x00\x04MQTT'
            b'\x04'             # Protocol Level 3.1.1
            b'\x02'             # Clean Session
            + struct.pack('!H', MQTT_KEEPALIVE)
        )
        payload = struct.pack('!H', len(client_id_bytes)) + client_id_bytes
        self._send_packet(0x10, var_header + payload)
        pkt_type, data = self._read_packet()
        if pkt_type != 0x20:
            raise ConnectionError(f"Expected CONNACK, got 0x{pkt_type:02x}")
        if len(data) >= 2 and data[1] != 0:
            raise ConnectionError(f"CONNACK return code: {data[1]}")
        self._connected = True
        for topic in self._subscriptions:
            self._do_subscribe(topic)

    def subscribe(self, topic):
        if topic not in self._subscriptions:
            self._subscriptions.append(topic)
        if self._connected:
            self._do_subscribe(topic)

    def publish(self, topic, payload):
        """Publish payload (bytes or str) to topic."""
        with self._lock:
            topic_bytes = topic.encode('utf-8')
            if isinstance(payload, str):
                payload = payload.encode('utf-8')
            pkt = struct.pack('!H', len(topic_bytes)) + topic_bytes + payload
            self._send_packet(0x30, pkt)  # PUBLISH QoS 0

    def _do_subscribe(self, topic):
        topic_bytes = topic.encode('utf-8')
        payload = (
            b'\x00\x01'
            + struct.pack('!H', len(topic_bytes)) + topic_bytes
            + b'\x00'
        )
        self._send_packet(0x82, payload)

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
                raise ConnectionError("Connection closed")
            data.extend(chunk)
        return bytes(data)


# ── ROS2 Bridge Node ─────────────────────────────────────────────────────────

class MqttRos2Bridge:
    """
    MQTT <-> ROS2 bridge.

    - Receives MQTT commands on Dart/Send_mqtt/<SN> -> calls ROS2 services
    - Subscribes to ROS2 robot_status topic -> publishes encrypted MQTT status
    - Forwards OTA commands to ota_client_node
    """

    def __init__(self, sn, mqtt_client):
        self.sn = sn
        self.mqtt = mqtt_client
        self._node = None
        self._status_sub = None
        self._battery_sub = None
        self._ota_status_sub = None
        self._last_status = None
        self._last_battery = None
        self._service_clients = {}

    def init_ros2(self):
        """Initialize ROS2 node with service clients and topic subscribers."""
        import rclpy
        from rclpy.callback_groups import ReentrantCallbackGroup

        if not rclpy.ok():
            rclpy.init()

        self._node = rclpy.create_node('mqtt_bridge')
        self._cb_group = ReentrantCallbackGroup()

        # ── Service clients (mqtt_node calls these on robot_decision) ────
        from decision_msgs.srv import (
            StartMap, StartCoverageTask, SaveMap,
            Charging, GenerateCoveragePath, DeleteMap,
        )
        from std_srvs.srv import SetBool, Trigger, Empty
        from mapping_msgs.srv import SetChargingPose
        from novabot_msgs.srv import Common as NovabotCommon

        self._service_clients = {
            # StartMap services
            'start_mapping':       self._node.create_client(StartMap, '/robot_decision/start_mapping', callback_group=self._cb_group),
            'add_area':            self._node.create_client(StartMap, '/robot_decision/add_area', callback_group=self._cb_group),
            'reset_mapping':       self._node.create_client(StartMap, '/robot_decision/reset_mapping', callback_group=self._cb_group),
            # SetBool services
            'start_assistant':     self._node.create_client(SetBool, '/robot_decision/start_assistant_mapping', callback_group=self._cb_group),
            'start_erase':         self._node.create_client(SetBool, '/robot_decision/start_erase', callback_group=self._cb_group),
            'stop_task':           self._node.create_client(SetBool, '/robot_decision/stop_task', callback_group=self._cb_group),
            'map_stop_record':     self._node.create_client(SetBool, '/robot_decision/map_stop_record', callback_group=self._cb_group),
            # Trigger services
            'auto_recharge':       self._node.create_client(Trigger, '/robot_decision/auto_recharge', callback_group=self._cb_group),
            'cancel_task':         self._node.create_client(Trigger, '/robot_decision/cancel_task', callback_group=self._cb_group),
            'cancel_recharge':     self._node.create_client(Trigger, '/robot_decision/cancel_recharge', callback_group=self._cb_group),
            # Empty service
            'quit_mapping_mode':   self._node.create_client(Empty, '/robot_decision/quit_mapping_mode', callback_group=self._cb_group),
            # Complex services
            'start_cov_task':      self._node.create_client(StartCoverageTask, '/robot_decision/start_cov_task', callback_group=self._cb_group),
            'save_map':            self._node.create_client(SaveMap, '/robot_decision/save_map', callback_group=self._cb_group),
            'nav_to_recharge':     self._node.create_client(Charging, '/robot_decision/nav_to_recharge', callback_group=self._cb_group),
            'gen_preview_path':    self._node.create_client(GenerateCoveragePath, '/robot_decision/generate_preview_cover_path', callback_group=self._cb_group),
            'delete_map':          self._node.create_client(DeleteMap, '/robot_decision/delete_map', callback_group=self._cb_group),
            'save_charging_pose':  self._node.create_client(SetChargingPose, '/robot_decision/save_charging_pose', callback_group=self._cb_group),
            'map_position':        self._node.create_client(NovabotCommon, '/robot_decision/map_position', callback_group=self._cb_group),
        }
        log(f"ROS2 node created with {len(self._service_clients)} service clients")

        # ── Topic subscribers (for status reporting to MQTT) ─────────────
        from decision_msgs.msg import RobotStatus
        from std_msgs.msg import String as StringMsg, UInt8

        self._status_sub = self._node.create_subscription(
            RobotStatus, '/robot_decision/robot_status',
            self._on_robot_status, 10, callback_group=self._cb_group)

        # Battery from chassis driver
        self._battery_sub = self._node.create_subscription(
            StringMsg, '/battery_message',
            self._on_battery_message, 10, callback_group=self._cb_group)

        # Chassis incident (errors)
        self._incident_sub = self._node.create_subscription(
            StringMsg, '/chassis_incident',
            self._on_chassis_incident, 10, callback_group=self._cb_group)

        # OTA status from ota_client_node
        self._ota_status_sub = self._node.create_subscription(
            StringMsg, '/ota/upgrade_status',
            self._on_ota_status, 10, callback_group=self._cb_group)

        # Map events from novabot_mapping
        self._map_csv_sub = self._node.create_subscription(
            StringMsg, '/novabot_mapping/save_csv_file',
            self._on_map_csv_saved, 10, callback_group=self._cb_group)

        # Path data for app display
        self._plan_path_sub = self._node.create_subscription(
            StringMsg, '/robot_decision/plan_path_json',
            self._on_plan_path, 10, callback_group=self._cb_group)
        self._cover_path_sub = self._node.create_subscription(
            StringMsg, '/robot_decision/covered_path_json',
            self._on_cover_path, 10, callback_group=self._cb_group)
        self._preview_path_sub = self._node.create_subscription(
            StringMsg, '/robot_decision/preview_cover_path_json',
            self._on_preview_path, 10, callback_group=self._cb_group)

        log("Subscribed to robot_status, battery, chassis, OTA, mapping, paths")

        # ── Publishers for joystick + LED ────────────────────────────────
        from geometry_msgs.msg import Twist
        self._cmd_vel_pub = self._node.create_publisher(Twist, '/cmd_vel', 10)
        self._led_pub = self._node.create_publisher(UInt8, '/led_set', 10)

        # ── Cached state for reports ─────────────────────────────────────
        self._last_battery_data = {}
        self._last_incident = None
        self._last_plan_path = None
        self._last_cover_path = None
        self._last_preview_path = None
        self._connection_published = False
        self._para_cache = {}  # Cached parameters from set_para_info

        return self._node

    # ── MQTT -> ROS2 command dispatch ────────────────────────────────────

    def on_mqtt_message(self, topic, payload):
        """Handle incoming MQTT message — decrypt if needed, dispatch to ROS2."""
        is_extended = 'novabot/extended/' in topic

        # Try plaintext first (extended commands are unencrypted)
        json_str = None
        try:
            json_str = payload.decode('utf-8')
            json.loads(json_str)  # Validate JSON
        except (UnicodeDecodeError, json.JSONDecodeError):
            json_str = aes_decrypt(payload, self.sn)

        if not json_str:
            log_warn(f"Could not decode MQTT payload ({len(payload)} bytes)")
            return

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            log_warn(f"Invalid JSON: {json_str[:100]}")
            return

        # Dispatch command
        cmd_name = list(data.keys())[0] if data else None
        if not cmd_name:
            return

        cmd_params = data[cmd_name] if isinstance(data[cmd_name], dict) else {}
        log(f"CMD: {cmd_name}" + (" (extended)" if is_extended else ""))

        response = self._dispatch_command(cmd_name, cmd_params)
        if response:
            if is_extended:
                # Extended commands: respond unencrypted on extended_response topic
                resp_topic = f"novabot/extended_response/{self.sn}"
                self.mqtt.publish(resp_topic, json.dumps(response))
            else:
                self._publish_encrypted(response)

    def _dispatch_command(self, cmd, params):
        """Route MQTT command to ROS2 service call, return response dict."""
        from decision_msgs.srv import (
            StartMap, StartCoverageTask, SaveMap,
            GenerateCoveragePath, DeleteMap,
        )
        from std_srvs.srv import SetBool, Trigger, Empty

        # ── Mowing ───────────────────────────────────────────────────
        if cmd == 'start_run':
            req = StartCoverageTask.Request()
            req.cov_mode = int(params.get('cov_mode', 0))
            req.request_type = int(params.get('request_type', 0x11))
            req.map_ids = int(params.get('map_ids', 0))
            req.blade_heights = [int(params.get('blade_height', 40))]
            req.cov_direction = int(params.get('cov_direction', 0))
            req.specify_direction = params.get('specify_direction', False)
            req.light = int(params.get('light', 1))
            req.perception_level = int(params.get('perception_level', 1))
            req.specify_perception_level = True
            result = self._call_service('start_cov_task', req)
            return {'start_run_respond': {'result': 1 if result and result.result else 0}}

        if cmd in ('stop_run', 'stop_navigation', 'stop_erase_map', 'stop_move'):
            req = SetBool.Request()
            req.data = True
            result = self._call_service('stop_task', req)
            if cmd == 'stop_move':
                self._publish_joystick_stop()
            return {f'{cmd}_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'pause_run':
            # Pause = stop motors but keep task active
            req = SetBool.Request()
            req.data = True
            result = self._call_service('stop_task', req)
            return {'pause_run_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'resume_run':
            # Resume = restart coverage task (robot_decision resumes from last position)
            req = StartCoverageTask.Request()
            req.cov_mode = int(params.get('cov_mode', 0))
            req.request_type = int(params.get('request_type', 0x11))
            req.map_ids = int(params.get('map_ids', 0))
            req.blade_heights = [int(params.get('blade_height', 40))]
            result = self._call_service('start_cov_task', req)
            return {'resume_run_respond': {'result': 1 if result and result.result else 0}}

        # ── Navigation ───────────────────────────────────────────────
        if cmd == 'start_navigation':
            # Point-to-point navigation — uses nav2 goal
            self._handle_start_navigation(params)
            return {'start_navigation_respond': {'result': 1}}

        if cmd == 'pause_navigation':
            req = SetBool.Request()
            req.data = True
            result = self._call_service('stop_task', req)
            return {'pause_navigation_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'resume_navigation':
            self._handle_start_navigation(params)
            return {'resume_navigation_respond': {'result': 1}}

        # ── Charging ─────────────────────────────────────────────────
        if cmd in ('go_to_charge', 'auto_recharge'):
            req = Trigger.Request()
            result = self._call_service('auto_recharge', req)
            return {f'{cmd}_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'stop_to_charge':
            req = Trigger.Request()
            result = self._call_service('cancel_recharge', req)
            return {'stop_to_charge_respond': {'result': 1 if result and result.success else 0}}

        # ── Mapping ──────────────────────────────────────────────────
        if cmd == 'start_scan_map':
            req = StartMap.Request()
            req.model = params.get('model', '')
            req.mapname = params.get('mapname', 'home0')
            req.type = 0  # work_area
            result = self._call_service('start_mapping', req)
            return {'start_scan_map_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'stop_scan_map':
            req = SetBool.Request()
            req.data = True
            result = self._call_service('map_stop_record', req)
            return {'stop_scan_map_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'add_scan_map':
            req = StartMap.Request()
            req.model = params.get('model', '')
            req.mapname = params.get('mapname', '')
            req.type = int(params.get('type', 1))  # obstacle
            result = self._call_service('add_area', req)
            return {'add_scan_map_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'save_map':
            req = SaveMap.Request()
            req.mapname = params.get('mapname', 'home0')
            req.resolution = float(params.get('resolution', 0.05))
            req.type = int(params.get('type', 0))
            result = self._call_service('save_map', req, timeout=15.0)
            return {'save_map_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'delete_map':
            req = DeleteMap.Request()
            req.maptype = int(params.get('maptype', 0))
            req.mapname = params.get('mapname', '')
            result = self._call_service('delete_map', req)
            return {'delete_map_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'start_assistant_build_map':
            req = SetBool.Request()
            req.data = True
            result = self._call_service('start_assistant', req)
            return {'start_assistant_build_map_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'start_erase_map':
            req = SetBool.Request()
            req.data = True
            result = self._call_service('start_erase', req)
            return {'start_erase_map_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'quit_mapping_mode':
            req = Empty.Request()
            result = self._call_service('quit_mapping_mode', req)
            return {'quit_mapping_mode_respond': {'result': 1}}

        if cmd == 'save_recharge_pos':
            from mapping_msgs.srv import SetChargingPose
            req = SetChargingPose.Request()
            req.control_mode = 1  # write
            req.map_file_name = params.get('map_file_name', 'home0')
            req.child_map_file_name = params.get('child_map_file_name', 'map0')
            result = self._call_service('save_charging_pose', req)
            return {'save_recharge_pos_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'generate_preview_cover_path':
            req = GenerateCoveragePath.Request()
            req.map_ids = int(params.get('map_ids', 0))
            req.specify_direction = params.get('specify_direction', False)
            req.cov_direction = int(params.get('cov_direction', 0))
            result = self._call_service('gen_preview_path', req)
            return {'generate_preview_cover_path_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'get_recharge_pos':
            from mapping_msgs.srv import SetChargingPose
            req = SetChargingPose.Request()
            req.control_mode = 0  # read
            req.map_file_name = params.get('map_file_name', 'home0')
            req.child_map_file_name = params.get('child_map_file_name', 'map0')
            result = self._call_service('save_charging_pose', req)
            if result and result.result:
                return {'get_recharge_pos_respond': {
                    'result': 1,
                    'x': result.charging_pose.position.x,
                    'y': result.charging_pose.position.y,
                    'theta': result.charging_pose.orientation.z,
                }}
            return {'get_recharge_pos_respond': {'result': 0}}

        if cmd == 'go_pile':
            # Same as go_to_charge
            req = Trigger.Request()
            result = self._call_service('auto_recharge', req)
            return {'go_pile_respond': {'result': 1 if result and result.success else 0}}

        if cmd == 'reset_map':
            req = StartMap.Request()
            req.mapname = params.get('mapname', '')
            result = self._call_service('reset_mapping', req)
            return {'reset_map_respond': {'result': 1 if result and result.result else 0}}

        if cmd == 'request_map_ids':
            # Return available map IDs from filesystem
            return self._build_map_ids()

        if cmd == 'get_map_outline':
            # Publish map outline data via report
            self._publish_map_outline(params)
            return None  # Sent as report_state_map_outline

        if cmd == 'get_map_plan_path':
            if self._last_plan_path:
                return {'get_map_plan_path_respond': {'result': 1, 'data': self._last_plan_path}}
            return {'get_map_plan_path_respond': {'result': 0}}

        if cmd == 'get_preview_cover_path':
            if self._last_preview_path:
                return {'get_preview_cover_path_respond': {'result': 1, 'data': self._last_preview_path}}
            return {'get_preview_cover_path_respond': {'result': 0}}

        # ── Joystick / manual control ────────────────────────────────
        if cmd == 'start_move':
            self._publish_joystick_start(params)
            return {'start_move_respond': {'result': 1}}

        if cmd == 'mst':
            self._publish_joystick_velocity(params)
            return None  # No response for velocity updates

        # ── Parameters ───────────────────────────────────────────────
        if cmd == 'get_para_info':
            return self._build_para_info()

        if cmd == 'set_para_info':
            self._handle_set_para_info(params)
            return {'set_para_info_respond': {'result': 1}}

        # ── PIN code ─────────────────────────────────────────────────
        if cmd == 'dev_pin_info':
            return self._handle_pin_info(params)

        # ── Config writes (replaces BLE set_*_info for MQTT path) ────
        if cmd == 'set_wifi_info':
            self._write_config_wifi(params)
            return {'set_wifi_info_respond': {'result': 1}}

        if cmd == 'set_mqtt_info':
            # NO domain whitelist — accept any address!
            self._write_config_mqtt(params)
            return {'set_mqtt_info_respond': {'result': 1}}

        if cmd == 'set_cfg_info':
            self._write_config_cfg(params)
            return {'set_cfg_info_respond': {'result': 1}}

        # ── OTA ──────────────────────────────────────────────────────
        if cmd == 'ota_upgrade_cmd':
            self._handle_ota_command(params)
            return None  # OTA progress reported via topic

        if cmd == 'ota_version_info':
            version = read_firmware_version()
            return {'ota_version_info_respond': {'version': version}}

        # ── Map list ─────────────────────────────────────────────────
        if cmd == 'get_map_list':
            return self._build_map_list()

        # ── Timer/planning ───────────────────────────────────────────
        if cmd == 'timer_task':
            log(f"Timer task: {params}")
            return None  # Acknowledged, handled by robot_decision schedule

        # ── Auto connect ─────────────────────────────────────────────
        if cmd == 'auto_connect':
            return None  # Acknowledged

        # ── Extended commands (replaces extended_commands.py) ─────────
        if cmd == 'set_robot_reboot':
            log("Reboot requested, rebooting in 3s...")
            threading.Thread(target=lambda: (time.sleep(3), os.system('reboot')), daemon=True).start()
            return {'set_robot_reboot_respond': {'result': 0}}

        if cmd == 'get_system_info':
            return {'get_system_info_respond': self._get_system_info()}

        if cmd == 'verify_pin':
            return self._handle_verify_pin(params)

        if cmd == 'query_pin':
            pin_file = "/userdata/lfi/pin_code.txt"
            has_pin = os.path.exists(pin_file)
            return {'query_pin_respond': {'result': 0, 'has_pin': has_pin}}

        if cmd == 'clear_error':
            return self._handle_clear_error()

        if cmd == 'set_perception_mode':
            return self._handle_set_perception_mode(params)

        if cmd == 'set_semantic_mode':
            return self._handle_set_semantic_mode(params)

        if cmd == 'get_perception_status':
            return {'get_perception_status_respond': self._get_perception_status()}

        if cmd == 'set_mqtt_config':
            self._write_config_mqtt(params)
            return {'set_mqtt_config_respond': {'result': 0, 'addr': params.get('addr', '')}}

        if cmd == 'set_wifi_config':
            self._handle_set_wifi_config_extended(params)
            return {'set_wifi_config_respond': {'result': 0, 'ssid': params.get('ssid', '')}}

        if cmd == 'clean_ota_cache':
            return self._handle_clean_ota_cache()

        if cmd == 'get_lora_info':
            return self._handle_get_lora_info()

        if cmd == 'set_lora_info':
            return self._handle_set_lora_info(params)

        # ── Unknown command — log but don't error ────────────────────
        log_warn(f"Unknown command: {cmd}")
        return None

    # ── ROS2 service call helper ─────────────────────────────────────

    def _call_service(self, name, request, timeout=5.0):
        """Synchronous ROS2 service call."""
        client = self._service_clients.get(name)
        if not client:
            log_err(f"No service client for: {name}")
            return None
        if not client.wait_for_service(timeout_sec=2.0):
            log_warn(f"Service {client.srv_name} not available")
            return None
        future = client.call_async(request)
        deadline = time.monotonic() + timeout
        while not future.done():
            if time.monotonic() > deadline:
                log_warn(f"Service {client.srv_name} timed out ({timeout}s)")
                return None
            time.sleep(0.05)
        try:
            return future.result()
        except Exception as e:
            log_err(f"Service {client.srv_name} failed: {e}")
            return None

    # ── Joystick control (topics, not services) ──────────────────────

    def _publish_joystick_start(self, params):
        log(f"Joystick start: {params}")

    def _publish_joystick_velocity(self, params):
        from geometry_msgs.msg import Twist
        msg = Twist()
        msg.linear.x = float(params.get('x_w', 0))
        msg.angular.z = float(params.get('y_v', 0))
        self._cmd_vel_pub.publish(msg)

    def _publish_joystick_stop(self):
        from geometry_msgs.msg import Twist
        self._cmd_vel_pub.publish(Twist())  # Zero velocity
        log("Joystick stop")

    # ── Navigation ───────────────────────────────────────────────────

    def _handle_start_navigation(self, params):
        """Publish nav2 goal for point-to-point navigation."""
        from geometry_msgs.msg import PoseStamped
        if not hasattr(self, '_nav_goal_pub'):
            self._nav_goal_pub = self._node.create_publisher(
                PoseStamped, '/goal_pose', 10)
        goal = PoseStamped()
        goal.header.frame_id = 'map'
        goal.pose.position.x = float(params.get('x', 0))
        goal.pose.position.y = float(params.get('y', 0))
        goal.pose.orientation.z = float(params.get('theta', 0))
        goal.pose.orientation.w = 1.0
        self._nav_goal_pub.publish(goal)
        log(f"Navigation goal: x={goal.pose.position.x}, y={goal.pose.position.y}")

    # ── Parameters ───────────────────────────────────────────────────

    def _handle_set_para_info(self, params):
        """Write mower parameters (blade height, perception, etc.)."""
        from std_msgs.msg import UInt8
        if 'target_height' in params:
            # Blade height control via chassis
            log(f"Set blade height: {params['target_height']}")
        if 'light' in params:
            msg = UInt8()
            msg.data = int(params['light'])
            self._led_pub.publish(msg)
            log(f"Set LED: {params['light']}")
        # Store params in state for get_para_info
        self._para_cache.update(params)

    # ── PIN code handling ────────────────────────────────────────────

    def _handle_pin_info(self, params):
        """Handle PIN code query/set/verify."""
        action = params.get('action', 'query')
        if action == 'query':
            # Check if PIN is set
            pin_file = "/userdata/lfi/pin_code.txt"
            has_pin = os.path.exists(pin_file)
            return {'dev_pin_info_respond': {
                'result': 1,
                'has_pin': has_pin,
                'no_set_pin_code': not has_pin,
            }}
        if action == 'set':
            pin = params.get('pin', '')
            try:
                with open("/userdata/lfi/pin_code.txt", 'w') as f:
                    f.write(pin)
                return {'dev_pin_info_respond': {'result': 1}}
            except Exception as e:
                log_err(f"PIN set failed: {e}")
                return {'dev_pin_info_respond': {'result': 0}}
        if action == 'verify':
            pin = params.get('pin', '')
            try:
                with open("/userdata/lfi/pin_code.txt") as f:
                    stored = f.read().strip()
                return {'dev_pin_info_respond': {'result': 1 if pin == stored else 0}}
            except Exception:
                return {'dev_pin_info_respond': {'result': 0}}
        return {'dev_pin_info_respond': {'result': 0}}

    # ── Config write commands (replaces BLE + stock mqtt_node whitelist) ──

    def _write_config_wifi(self, params):
        """Write WiFi config to json_config.json + trigger nmcli."""
        ssid = params.get('ssid', params.get('addr', ''))
        password = params.get('password', params.get('pass', ''))
        if not ssid:
            return
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            cfg.setdefault('wifi', {}).setdefault('value', {})
            cfg['wifi']['value']['ssid'] = ssid
            cfg['wifi']['value']['password'] = password
            with open(CONFIG_FILE, 'w') as f:
                json.dump(cfg, f, indent=2)
            log(f"Config: WiFi -> {ssid}")
            # Trigger nmcli to switch WiFi
            os.system(f'nmcli device wifi connect "{ssid}" password "{password}" 2>/dev/null &')
        except Exception as e:
            log_err(f"WiFi config write failed: {e}")

    def _write_config_mqtt(self, params):
        """Write MQTT config to json_config.json — NO domain whitelist!"""
        addr = params.get('addr', '')
        port = int(params.get('port', 1883))
        if not addr:
            return
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            cfg.setdefault('mqtt', {}).setdefault('value', {})
            cfg['mqtt']['value']['addr'] = addr
            cfg['mqtt']['value']['port'] = port
            with open(CONFIG_FILE, 'w') as f:
                json.dump(cfg, f, indent=2)
            log(f"Config: MQTT -> {addr}:{port}")
        except Exception as e:
            log_err(f"MQTT config write failed: {e}")

    def _write_config_cfg(self, params):
        """Write timezone and other config."""
        tz = params.get('tz', params.get('timezone', ''))
        if tz:
            try:
                tz_file = "/userdata/lfi/timezone.txt"
                with open(tz_file, 'w') as f:
                    f.write(tz)
                log(f"Config: timezone -> {tz}")
            except Exception as e:
                log_err(f"Timezone write failed: {e}")

    # ── Extended command implementations (replaces extended_commands.py) ──

    def _ros2_run(self, args, timeout=10):
        """Run ros2 CLI command with proper environment."""
        import subprocess
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
            capture_output=True, text=True, timeout=timeout, env=env)

    def _get_system_info(self):
        """Collect system diagnostics (CPU, memory, disk, firmware, ROS nodes)."""
        import subprocess
        info = {}
        info["firmware_version"] = read_firmware_version()
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                info["cpu_temp_c"] = int(f.read().strip()) / 1000
        except Exception:
            info["cpu_temp_c"] = None
        try:
            with open("/proc/uptime") as f:
                info["uptime_s"] = float(f.read().split()[0])
        except Exception:
            info["uptime_s"] = None
        try:
            with open("/proc/meminfo") as f:
                mem = {}
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2:
                        mem[parts[0].rstrip(':')] = int(parts[1])
                info["mem_total_mb"] = mem.get("MemTotal", 0) // 1024
                info["mem_free_mb"] = mem.get("MemAvailable", mem.get("MemFree", 0)) // 1024
        except Exception:
            pass
        try:
            st = os.statvfs("/userdata")
            info["disk_total_mb"] = (st.f_blocks * st.f_frsize) // (1024 * 1024)
            info["disk_free_mb"] = (st.f_bavail * st.f_frsize) // (1024 * 1024)
        except Exception:
            pass
        try:
            result = self._ros2_run(['ros2', 'node', 'list'], timeout=5)
            if result.returncode == 0:
                info["ros_nodes"] = [n.strip() for n in result.stdout.strip().split('\n') if n.strip()]
        except Exception:
            info["ros_nodes"] = []
        return info

    def _handle_verify_pin(self, params):
        """Verify PIN code via ROS2 action or file check."""
        code = params.get('code', params.get('pin', ''))
        if not code:
            return {'verify_pin_respond': {'result': 1, 'error': 'missing code/pin parameter'}}
        try:
            with open("/userdata/lfi/pin_code.txt") as f:
                stored = f.read().strip()
            ok = (code == stored)
            return {'verify_pin_respond': {'result': 0 if ok else 1}}
        except Exception:
            return {'verify_pin_respond': {'result': 1, 'error': 'no pin file'}}

    def _handle_clear_error(self):
        """Clear STM32 error state via serial command."""
        import subprocess
        try:
            subprocess.run(["killall", "chassis_control_node"], capture_output=True)
            time.sleep(0.5)
            # Serial clear error command (CMD 0x23 type=3)
            log("Clear error: killing chassis_control_node + serial reset")
            return {'clear_error_respond': {'result': 0}}
        except Exception as e:
            return {'clear_error_respond': {'result': 1, 'error': str(e)}}

    def _handle_set_perception_mode(self, params):
        """Switch AI inference model (1=seg, 2=detect, 3=seg_high, 4=seg_low)."""
        mode = int(params.get('mode', 1))
        if mode not in (1, 2, 3, 4):
            return {'set_perception_mode_respond': {'result': 1, 'error': 'mode must be 1-4'}}
        mode_names = {1: "segmentation", 2: "detection", 3: "seg_high", 4: "seg_low"}
        try:
            result = self._ros2_run(
                ["ros2", "service", "call", "/perception/set_infer_model",
                 "general_msgs/srv/SetUint8", f"'{{value: {mode}}}'"], timeout=10)
            return {'set_perception_mode_respond': {
                'result': 0 if result.returncode == 0 else 1,
                'mode': mode, 'mode_name': mode_names.get(mode, 'unknown'),
            }}
        except Exception as e:
            return {'set_perception_mode_respond': {'result': 1, 'error': str(e)}}

    def _handle_set_semantic_mode(self, params):
        """Set costmap semantic mode (0=lawn, 1=free, 2=boundary, 3=ignore)."""
        mode = int(params.get('mode', 0))
        if mode not in (0, 1, 2, 3):
            return {'set_semantic_mode_respond': {'result': 1, 'error': 'mode must be 0-3'}}
        mode_names = {0: "lawn_cover", 1: "free_move", 2: "boundary_follow", 3: "ignore_semantic"}
        try:
            result = self._ros2_run(
                ["ros2", "service", "call", "/local_costmap/set_semantic_mode",
                 "nav2_msgs/srv/SemanticMode", f"'{{semantic_mode: {mode}}}'"], timeout=10)
            if result.returncode == 0:
                try:
                    with open("/tmp/semantic_mode", "w") as f:
                        f.write(str(mode))
                except Exception:
                    pass
            return {'set_semantic_mode_respond': {
                'result': 0 if result.returncode == 0 else 1,
                'mode': mode, 'mode_name': mode_names.get(mode, 'unknown'),
            }}
        except Exception as e:
            return {'set_semantic_mode_respond': {'result': 1, 'error': str(e)}}

    def _get_perception_status(self):
        """Query perception system status."""
        import subprocess
        info = {}
        try:
            result = subprocess.run(
                ["bash", "-c", "ps -eo args 2>/dev/null | grep -E 'perception_node|robot_decision|nav2_single_node' | grep -v grep"],
                capture_output=True, text=True, timeout=3)
            procs = result.stdout.strip()
            info["perception_running"] = "perception_node" in procs
            info["decision_running"] = "robot_decision" in procs
            info["navigation_running"] = "nav2_single_node" in procs
        except Exception:
            info["perception_running"] = False
        try:
            result = self._ros2_run(
                ["ros2", "param", "get", "/perception_node", "infer_mode"], timeout=10)
            if result.returncode == 0 and "value is:" in result.stdout:
                info["perception_mode"] = int(result.stdout.strip().split(":")[-1].strip())
        except Exception:
            pass
        try:
            with open("/tmp/semantic_mode") as f:
                info["semantic_mode"] = int(f.read().strip())
        except Exception:
            info["semantic_mode"] = 0
        return info

    def _handle_set_wifi_config_extended(self, params):
        """Set WiFi config + nmcli switch + kill mqtt_node (extended_commands pattern)."""
        ssid = params.get('ssid', '')
        password = params.get('password', '')
        if not ssid:
            return
        # Write to json_config.json (flat, not nested under "ap")
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            cfg.setdefault('wifi', {}).setdefault('value', {})
            cfg['wifi']['value']['ssid'] = ssid
            cfg['wifi']['value']['password'] = password
            with open(CONFIG_FILE, 'w') as f:
                json.dump(cfg, f, indent=2)
            log(f"Config: WiFi -> {ssid}")
        except Exception as e:
            log_err(f"WiFi config write failed: {e}")
            return
        # nmcli to switch WiFi immediately
        import subprocess
        try:
            subprocess.Popen(
                ["bash", "-c", f'sleep 1 && nmcli device wifi connect "{ssid}" password "{password}" 2>/dev/null'],
                start_new_session=True)
            log(f"WiFi switch to {ssid} via nmcli (1s delay)")
        except Exception as e:
            log_err(f"nmcli failed: {e}")

    def _handle_get_lora_info(self):
        """Read LoRa config from json_config.json."""
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            lora = cfg.get("lora", {}).get("value", {})
            return {'get_lora_info_respond': {
                'result': 0,
                'addr': lora.get('addr'),
                'channel': lora.get('channel'),
                'hc': lora.get('hc', 20),
                'lc': lora.get('lc', 14),
            }}
        except Exception as e:
            return {'get_lora_info_respond': {'result': 1, 'error': str(e)}}

    def _handle_set_lora_info(self, params):
        """Write LoRa config to json_config.json."""
        addr = params.get('addr')
        channel = params.get('channel')
        if addr is None or channel is None:
            return {'set_lora_info_respond': {'result': 1, 'error': 'addr and channel required'}}
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            cfg.setdefault('lora', {}).setdefault('value', {})
            cfg['lora']['value']['addr'] = int(addr)
            cfg['lora']['value']['channel'] = int(channel)
            cfg['lora']['value']['hc'] = int(params.get('hc', 20))
            cfg['lora']['value']['lc'] = int(params.get('lc', 14))
            with open(CONFIG_FILE, 'w') as f:
                json.dump(cfg, f, indent=2)
            log(f"LoRa config set: addr={addr} channel={channel}")
            return {'set_lora_info_respond': {'result': 0, 'addr': int(addr), 'channel': int(channel)}}
        except Exception as e:
            return {'set_lora_info_respond': {'result': 1, 'error': str(e)}}

    def _handle_clean_ota_cache(self):
        """Clean OTA cache + reboot (required after failed OTA)."""
        import subprocess
        try:
            subprocess.run(["rm", "-rf", "/userdata/ota/upgrade_pkg/"], capture_output=True)
            os.makedirs("/userdata/ota/upgrade_pkg", exist_ok=True)
            with open("/userdata/ota/upgrade.txt", "w") as f:
                f.write("0")
            log("OTA cache cleaned, rebooting in 3s...")
            threading.Thread(target=lambda: (time.sleep(3), os.system('reboot')), daemon=True).start()
            return {'clean_ota_cache_respond': {'result': 0}}
        except Exception as e:
            return {'clean_ota_cache_respond': {'result': 1, 'error': str(e)}}

    # ── OTA forwarding ───────────────────────────────────────────────

    def _handle_ota_command(self, params):
        """Forward OTA command to ota_client_node via ROS2 service."""
        log(f"OTA command: {json.dumps(params)[:200]}")
        # ota_client_node listens on /ota_upgrade_srv
        # For now, publish the command as a string topic that ota_client picks up
        from std_msgs.msg import String as StringMsg
        if not hasattr(self, '_ota_cmd_pub'):
            self._ota_cmd_pub = self._node.create_publisher(
                StringMsg, '/ota/upgrade_cmd', 10)
        msg = StringMsg()
        msg.data = json.dumps({'ota_upgrade_cmd': params})
        self._ota_cmd_pub.publish(msg)

    def _on_ota_status(self, msg):
        """Forward OTA status from ota_client_node to MQTT."""
        try:
            status = json.loads(msg.data)
            self._publish_encrypted({'ota_upgrade_state': status})
        except (json.JSONDecodeError, Exception) as e:
            log_warn(f"OTA status parse error: {e}")

    # ── ROS2 topic callbacks ─────────────────────────────────────────

    def _on_robot_status(self, msg):
        """Cache latest robot status for periodic MQTT publishing."""
        self._last_status = msg

    def _on_battery_message(self, msg):
        """Cache battery data from chassis driver."""
        try:
            self._last_battery_data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError):
            pass

    def _on_chassis_incident(self, msg):
        """Cache chassis incident for exception reporting."""
        self._last_incident = msg.data

    def _on_map_csv_saved(self, msg):
        """Map CSV saved by novabot_mapping — trigger map list update."""
        log(f"Map CSV saved: {msg.data}")

    def _on_plan_path(self, msg):
        """Cache plan path JSON for get_map_plan_path."""
        try:
            self._last_plan_path = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError):
            pass

    def _on_cover_path(self, msg):
        """Cache covered path JSON."""
        try:
            self._last_cover_path = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError):
            pass

    def _on_preview_path(self, msg):
        """Cache preview coverage path JSON."""
        try:
            self._last_preview_path = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError):
            pass

    # ── Status publishing (periodic, called from main loop) ──────────

    def publish_status(self):
        """Publish all status reports as encrypted MQTT."""
        self._publish_robot_status()
        self._publish_battery_status()
        self._publish_work_status()
        self._publish_exception_status()
        self._publish_connection_state()

    def _publish_robot_status(self):
        """report_state_robot — main robot status."""
        if not self._last_status:
            return
        msg = self._last_status
        report = {
            'report_state_robot': {
                'task_mode': msg.task_mode,
                'work_status': msg.work_status,
                'recharge_status': msg.recharge_status,
                'error_status': msg.error_status,
                'msg': getattr(msg, 'msg', ''),
                'error_msg': getattr(msg, 'error_msg', ''),
                'battery_power': msg.battery_capacity,
                'battery_capacity': msg.battery_capacity,
                'loc_quality': msg.loc_quality,
                'cpu_temperature': getattr(msg, 'cpu_temperature', 0),
                'cpu_usage': getattr(msg, 'cpu_usage', 0),
                'memory_remaining': getattr(msg, 'memory_remaining', 0),
                'disk_remaining': getattr(msg, 'disk_remaining', 0),
                'x': msg.x,
                'y': msg.y,
                'theta': msg.theta,
                'cov_ratio': msg.cov_ratio,
                'cov_area': msg.cov_area,
                'cov_work_time': msg.cov_work_time,
                'request_map_ids': msg.request_map_ids,
                'current_map_ids': msg.current_map_ids,
                'target_height': msg.target_height,
                'perception_level': msg.perception_level,
                'light': msg.light,
                'map_num': msg.map_num,
                'finished_num': msg.finished_num,
            }
        }
        self._publish_encrypted(report)

    def _publish_battery_status(self):
        """report_state_battery — battery details."""
        if not self._last_battery_data:
            return
        bd = self._last_battery_data
        report = {
            'report_state_battery': {
                'battery_capacity': bd.get('capacity', 0),
                'battery_state': bd.get('state', 0),
                'battery_voltage': bd.get('voltage', 0),
                'battery_current': bd.get('current', 0),
            }
        }
        self._publish_encrypted(report)

    def _publish_work_status(self):
        """report_state_work — mowing progress."""
        if not self._last_status:
            return
        msg = self._last_status
        report = {
            'report_state_work': {
                'task_mode': msg.task_mode,
                'work_status': msg.work_status,
                'work_mode': getattr(msg, 'work_mode', 0),
                'work_state': getattr(msg, 'work_state', 0),
                'mowing_progress': int(msg.cov_ratio * 100) if msg.cov_ratio else 0,
                'error_status': msg.error_status,
                'error_code': getattr(msg, 'error_code', 0),
                'cov_ratio': msg.cov_ratio,
                'cov_area': msg.cov_area,
                'cov_work_time': msg.cov_work_time,
            }
        }
        self._publish_encrypted(report)

    def _publish_exception_status(self):
        """report_exception_state — errors/warnings."""
        if not self._last_status or not self._last_status.error_status:
            return
        msg = self._last_status
        if msg.error_status == 0:
            return
        report = {
            'report_exception_state': {
                'error_status': msg.error_status,
                'error_msg': getattr(msg, 'error_msg', ''),
                'error_code': getattr(msg, 'error_code', 0),
            }
        }
        self._publish_encrypted(report)

    def _publish_connection_state(self):
        """connection_state — sent once after MQTT connect."""
        if self._connection_published:
            return
        self._connection_published = True
        self._publish_encrypted({'connection_state': {'connected': True}})

    # ── Info builders ────────────────────────────────────────────────

    def _build_para_info(self):
        """Build get_para_info response with all parameters."""
        version = read_firmware_version()
        status = self._last_status
        para = getattr(self, '_para_cache', {})
        return {'get_para_info_respond': {
            'result': 1,
            'sysVersion': version,
            'target_height': para.get('target_height', status.target_height if status else 40),
            'defaultCuttingHeight': para.get('defaultCuttingHeight', 40),
            'cutGrassHeight': para.get('cutGrassHeight', 40),
            'path_direction': para.get('path_direction', 0),
            'obstacle_avoidance_sensitivity': para.get('obstacle_avoidance_sensitivity', 1),
            'perception_level': status.perception_level if status else 1,
            'light': status.light if status else 1,
        }}

    def _build_map_list(self):
        """Build get_map_list response with ZIP + MD5 from filesystem."""
        import glob
        import hashlib
        map_dir = "/userdata/lfi/maps/home0"
        csv_dir = f"{map_dir}/csv_file"
        maps = []
        try:
            for f in sorted(glob.glob(f"{csv_dir}/*.csv")):
                name = os.path.basename(f).replace('.csv', '')
                # Compute MD5 of CSV file
                md5 = ''
                try:
                    h = hashlib.md5()
                    with open(f, 'rb') as fh:
                        for chunk in iter(lambda: fh.read(4096), b''):
                            h.update(chunk)
                    md5 = h.hexdigest()
                except Exception:
                    pass
                maps.append({
                    'fileName': name,
                    'type': 0,
                    'fileHash': md5,
                    'mapArea': '0',
                })
        except Exception:
            pass

        # Check for ZIP file
        zip_path = f"{map_dir}/{self.sn}.zip"
        zip_md5 = ''
        if os.path.exists(zip_path):
            try:
                h = hashlib.md5()
                with open(zip_path, 'rb') as fh:
                    for chunk in iter(lambda: fh.read(4096), b''):
                        h.update(chunk)
                zip_md5 = h.hexdigest()
            except Exception:
                pass

        return {'get_map_list_respond': {
            'result': 1,
            'maps': maps,
            'md5': zip_md5,
        }}

    def _build_map_ids(self):
        """Build request_map_ids response from filesystem."""
        import glob
        csv_dir = "/userdata/lfi/maps/home0/csv_file"
        map_ids = []
        try:
            for i, f in enumerate(sorted(glob.glob(f"{csv_dir}/*.csv"))):
                map_ids.append(i)
        except Exception:
            pass
        return {'request_map_ids_respond': {'result': 1, 'map_ids': map_ids}}

    def _publish_map_outline(self, params):
        """Read map outline from CSV and publish as report_state_map_outline."""
        map_name = params.get('mapname', params.get('map_name', ''))
        csv_path = f"/userdata/lfi/maps/home0/csv_file/{map_name}.csv"
        points = []
        try:
            with open(csv_path) as f:
                for line in f:
                    parts = line.strip().split(',')
                    if len(parts) >= 2:
                        points.append({'x': float(parts[0]), 'y': float(parts[1])})
        except Exception:
            pass
        self._publish_encrypted({
            'report_state_map_outline': {
                'mapname': map_name,
                'points': points,
                'result': 1 if points else 0,
            }
        })

    # ── Encrypted MQTT publish ───────────────────────────────────────

    def _publish_encrypted(self, data):
        """Encrypt JSON and publish to Dart/Receive_mqtt/<SN>."""
        topic = f"Dart/Receive_mqtt/{self.sn}"
        json_str = json.dumps(data)
        encrypted = aes_encrypt(json_str, self.sn)
        self.mqtt.publish(topic, encrypted)

    def destroy(self):
        if self._node:
            self._node.destroy_node()
            self._node = None


# ── HTTP health check (replaces net_check_fun in stock mqtt_node) ────────────

def net_check_thread():
    """Periodically POST to server to verify connectivity."""
    import urllib.request
    fail_count = 0

    try:
        with open(HTTP_ADDR_FILE) as f:
            http_addr = f.read().strip()
    except Exception:
        log_warn("No http_address.txt — health checks disabled")
        return

    url = f"http://{http_addr}/api/nova-network/network/connection"
    log(f"Health check URL: {url}")

    while True:
        time.sleep(NET_CHECK_INTERVAL)
        try:
            req = urllib.request.Request(url, data=b'{}',
                                         headers={'Content-Type': 'application/json'},
                                         method='POST')
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    fail_count = 0
                    continue
        except Exception:
            pass

        fail_count += 1
        if fail_count >= 3:
            log_warn(f"HTTP health check failed {fail_count}x — server unreachable")
            # Stock mqtt_node would trigger WiFi reconnect here
            # For now just log — nmcli reconnect could be added later


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    log("=" * 50)
    log("  open_node — MQTT<->ROS2 Bridge")
    log(f"  PID={os.getpid()}")
    log("=" * 50)

    try:
        signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
    except ValueError:
        pass  # Not in main thread (e.g. test harness)

    # Read configuration
    sn, mqtt_addr, mqtt_port = read_config()
    if not sn:
        log_err("No SN configured — cannot start. Run BLE provisioning first.")
        sys.exit(1)

    version = read_firmware_version()
    log(f"SN={sn}, MQTT={mqtt_addr}:{mqtt_port}, FW={version}")

    # Client ID must match stock mqtt_node format for broker compatibility
    client_id = f"{sn}_6688"
    send_topic = f"Dart/Send_mqtt/{sn}"

    # Start HTTP health check thread
    health_thread = threading.Thread(target=net_check_thread, daemon=True)
    health_thread.start()

    # MQTT reconnect loop
    bridge = None
    while True:
        try:
            # Create MQTT client
            mqtt = MiniMQTT(mqtt_addr, mqtt_port, client_id)

            # Create bridge (ROS2 init happens once)
            if bridge is None:
                bridge = MqttRos2Bridge(sn, mqtt)
                ros2_node = bridge.init_ros2()

                # Spin ROS2 in background thread
                import rclpy
                from rclpy.executors import MultiThreadedExecutor
                executor = MultiThreadedExecutor(num_threads=4)
                executor.add_node(ros2_node)
                ros2_thread = threading.Thread(target=executor.spin, daemon=True)
                ros2_thread.start()
                log("ROS2 executor started (4 threads)")
            else:
                bridge.mqtt = mqtt

            # Set MQTT message handler
            mqtt.on_message = bridge.on_mqtt_message

            # Connect and subscribe
            mqtt.connect()
            log(f"MQTT connected to {mqtt_addr}:{mqtt_port} as {client_id}")
            mqtt.subscribe(send_topic)
            # Also subscribe to extended commands topic (backward compat)
            mqtt.subscribe(f"novabot/extended/{sn}")
            log(f"Subscribed to {send_topic}")

            # Status publish timer
            last_status_publish = time.time()

            # Main loop
            while mqtt._connected:
                # MQTT packet processing (with short timeout for interleaving)
                try:
                    if time.time() - last_status_publish > STATUS_PUBLISH_INTERVAL:
                        bridge.publish_status()
                        last_status_publish = time.time()

                    # Process one MQTT packet
                    old_timeout = mqtt._sock.gettimeout()
                    mqtt._sock.settimeout(0.5)
                    try:
                        pkt_type, data = mqtt._read_packet()
                        if pkt_type is not None:
                            if pkt_type == 0x30 or (pkt_type & 0xF0) == 0x30:
                                mqtt._handle_publish(data)
                            elif pkt_type == 0xD0:
                                pass  # PINGRESP
                    except socket.timeout:
                        pass
                    finally:
                        mqtt._sock.settimeout(old_timeout)

                    # Keepalive
                    if not hasattr(mqtt, '_last_ping'):
                        mqtt._last_ping = time.time()
                    if time.time() - mqtt._last_ping > MQTT_KEEPALIVE * 0.8:
                        mqtt._send_packet(0xC0, b'')
                        mqtt._last_ping = time.time()

                except (ConnectionError, OSError):
                    break

        except KeyboardInterrupt:
            log("Interrupted")
            break
        except Exception as e:
            log_err(f"MQTT error: {e}")

        log(f"Reconnecting in {MQTT_RECONNECT_INTERVAL}s...")
        time.sleep(MQTT_RECONNECT_INTERVAL)

    if bridge:
        bridge.destroy()
    log("Stopped")


if __name__ == '__main__':
    main()
