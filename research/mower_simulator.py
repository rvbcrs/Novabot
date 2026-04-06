#!/usr/bin/env python3
"""
Novabot Mower Simulator — simulates mqtt_node + ota_client for ESP32 OTA tool testing.

Single-threaded MQTT + subprocess curl download to avoid socket corruption.

Usage:
  python3 mower_simulator.py
  python3 mower_simulator.py --broker 10.0.0.1 --sn LFIN0000000001
  python3 mower_simulator.py --stock --not-charging
"""

import argparse
import hashlib
import json
import os
import socket
import struct
import subprocess
import time

DEFAULT_SN = "LFIN0000000001"
DEFAULT_BROKER = "10.0.0.1"
DEFAULT_PORT = 1883
FIRMWARE_VERSION = "v0.0.0-simulator"
REPORT_INTERVAL = 10


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] [SIM] {msg}", flush=True)


class MiniMQTT:
    """Minimal MQTT 3.1.1 client — single-threaded, non-blocking recv."""

    def __init__(self, host, port, client_id):
        self.host = host
        self.port = port
        self.client_id = client_id
        self._sock = None
        self._connected = False
        self._pkt_id = 0
        self._on_message = None

    def connect(self):
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(1)  # Short timeout for non-blocking poll
        self._sock.connect((self.host, self.port))

        cid = self.client_id.encode()
        var_header = b'\x00\x04MQTT\x04\x02' + struct.pack('!H', 60)
        payload = struct.pack('!H', len(cid)) + cid
        self._send(0x10, var_header + payload)

        # Wait for CONNACK with longer timeout
        self._sock.settimeout(10)
        pkt_type, data = self._recv()
        self._sock.settimeout(1)
        if pkt_type != 0x20 or (len(data) >= 2 and data[1] != 0):
            raise ConnectionError(f"CONNACK failed: {data}")
        self._connected = True
        log(f"MQTT connected: {self.client_id}")

    def subscribe(self, topic):
        self._pkt_id += 1
        t = topic.encode()
        payload = struct.pack('!H', self._pkt_id) + struct.pack('!H', len(t)) + t + b'\x00'
        self._send(0x82, payload)

    def publish(self, topic, payload_str):
        if not self._connected:
            return
        t = topic.encode()
        p = payload_str.encode() if isinstance(payload_str, str) else payload_str
        data = struct.pack('!H', len(t)) + t + p
        self._send(0x30, data)

    def poll(self):
        """Non-blocking: process one incoming packet if available. Returns True if a message was handled."""
        try:
            pkt_type, data = self._recv()
            if pkt_type is None:
                return False
            if (pkt_type & 0xF0) == 0x30:
                if len(data) >= 2:
                    tlen = struct.unpack('!H', data[0:2])[0]
                    topic = data[2:2+tlen].decode('utf-8', errors='replace')
                    payload = data[2+tlen:]
                    if self._on_message:
                        self._on_message(topic, payload)
                return True
            return False
        except socket.timeout:
            return False
        except (ConnectionError, OSError):
            self._connected = False
            return False

    def ping(self):
        if self._connected:
            try:
                self._send(0xC0, b'')
            except:
                self._connected = False

    def disconnect(self):
        self._connected = False
        if self._sock:
            try:
                self._send(0xE0, b'')
                self._sock.close()
            except:
                pass
            self._sock = None

    def _send(self, pkt_type, payload):
        remaining = len(payload)
        header = bytes([pkt_type])
        enc = bytearray()
        while True:
            byte = remaining % 128
            remaining //= 128
            if remaining > 0:
                byte |= 0x80
            enc.append(byte)
            if remaining == 0:
                break
        self._sock.sendall(header + bytes(enc) + payload)

    def _recv(self):
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
                raise ConnectionError("Connection lost")
            data.extend(chunk)
        return bytes(data)


class MowerSimulator:
    def __init__(self, sn, broker, port, stock_mode=False, charging=True, battery=85, fw_version=FIRMWARE_VERSION):
        self.sn = sn
        self.broker = broker
        self.port = port
        self.stock_mode = stock_mode
        self.charging = charging
        self.battery = battery
        self.firmware_version = fw_version
        self.mqtt = None
        self.ext_mqtt = None
        self.running = True
        self.ota_proc = None  # curl subprocess
        self.ota_file = None
        self.ota_total = 0
        self.ota_md5 = ""
        self.ota_version = ""
        self.ota_phase = None  # 'download', 'unpack', 'install', 'success', 'reboot'

    def start(self):
        log(f"SN: {self.sn}, Broker: {self.broker}:{self.port}")
        log(f"Mode: {'STOCK' if self.stock_mode else 'CUSTOM'}, Charging: {self.charging}")

        while self.running:
            try:
                self._run()
            except KeyboardInterrupt:
                break
            except Exception as e:
                log(f"Error: {e}")
                time.sleep(5)

    def _run(self):
        # Connect main MQTT
        self.mqtt = MiniMQTT(self.broker, self.port, f"{self.sn}_6688")
        self.mqtt._on_message = self._on_message
        self.mqtt.connect()
        self.mqtt.subscribe(f"Dart/Send_mqtt/{self.sn}")

        # Connect ext MQTT
        if not self.stock_mode:
            self.ext_mqtt = MiniMQTT(self.broker, self.port, f"ext_cmd_{self.sn}")
            self.ext_mqtt._on_message = self._on_ext_message
            self.ext_mqtt.connect()
            self.ext_mqtt.subscribe(f"novabot/extended/{self.sn}")

        # Single-threaded main loop
        last_report = 0
        last_ping = time.time()
        last_ota_pct = -1

        while self.running and self.mqtt._connected:
            now = time.time()

            # Poll MQTT (non-blocking, 1s timeout)
            self.mqtt.poll()
            if self.ext_mqtt:
                self.ext_mqtt.poll()

            # MQTT keepalive every 30s
            if now - last_ping > 30:
                self.mqtt.ping()
                if self.ext_mqtt:
                    self.ext_mqtt.ping()
                last_ping = now

            # OTA download monitoring
            if self.ota_proc is not None:
                self._monitor_ota(last_ota_pct)
                # Update last reported pct
                if self.ota_file and os.path.exists(self.ota_file) and self.ota_total > 0:
                    fsize = os.path.getsize(self.ota_file)
                    pct_int = int((fsize / self.ota_total) * 62)
                    if pct_int > last_ota_pct:
                        last_ota_pct = pct_int

            # OTA post-download phases
            elif self.ota_phase == 'unpack':
                self._do_unpack()
            elif self.ota_phase == 'install':
                self._do_install()
            elif self.ota_phase == 'reboot':
                self._do_reboot()
                break  # Exit loop to reconnect

            # Periodic status reports (only when not in OTA)
            elif now - last_report > REPORT_INTERVAL:
                self._send_status()
                last_report = now

    def _send_status(self):
        topic = f"Dart/Receive_mqtt/{self.sn}"
        rs = 9 if self.charging else 0
        bs = "CHARGING" if self.charging else "NOT_CHARGING"

        self.mqtt.publish(topic, json.dumps({"report_state_robot":{
            "battery_power":self.battery,"recharge_status":rs,
            "msg":f"Recharge: {'FINISHED' if self.charging else 'IDLE'}",
            "error_status":151,"loc_quality":100,"task_mode":1,"work_status":0
        }}, separators=(',',':')))

        self.mqtt.publish(topic, json.dumps({"report_state_timer_data":{
            "battery_capacity":self.battery,"battery_state":bs,"timer_task":0
        }}, separators=(',',':')))

        log(f"Status sent (battery={self.battery}%, charging={self.charging})")

    def _on_message(self, topic, payload):
        try:
            data = json.loads(payload.decode())
            if "ota_upgrade_cmd" in data:
                self._start_ota(data["ota_upgrade_cmd"])
            elif "set_wifi_info" in data:
                log(f"WiFi config received")
            elif "set_mqtt_info" in data:
                log(f"MQTT info: {data['set_mqtt_info'].get('addr','?')}")
            else:
                log(f"CMD: {list(data.keys())}")
        except:
            pass

    def _on_ext_message(self, topic, payload):
        try:
            data = json.loads(payload.decode())
            resp_topic = f"novabot/extended_response/{self.sn}"

            if "get_system_info" in data:
                self.ext_mqtt.publish(resp_topic, json.dumps({"get_system_info_respond":{
                    "firmware_version":self.firmware_version,"cpu_temp_c":42.0
                }}))
                log(f"System info sent (fw: {self.firmware_version})")
            elif "set_mqtt_config" in data:
                addr = data["set_mqtt_config"].get("addr","?")
                self.ext_mqtt.publish(resp_topic, json.dumps({"set_mqtt_config_respond":{"result":0,"addr":addr}}))
                log(f"MQTT config → {addr}")
            elif "set_wifi_config" in data:
                ssid = data["set_wifi_config"].get("ssid","?")
                self.ext_mqtt.publish(resp_topic, json.dumps({"set_wifi_config_respond":{"result":0,"ssid":ssid}}))
                log(f"WiFi config → {ssid}")
            elif "clean_ota_cache" in data:
                self.ext_mqtt.publish(resp_topic, json.dumps({"clean_ota_cache_respond":{"result":0}}))
                log("OTA cache cleaned, rebooting...")
                self.ota_phase = 'reboot'
            else:
                log(f"EXT CMD: {list(data.keys())}")
        except:
            pass

    def _start_ota(self, cmd):
        url = cmd.get("url", "")
        self.ota_version = cmd.get("version", "?")
        self.ota_md5 = cmd.get("md5", "")
        log(f"OTA: {self.ota_version} from {url}")

        if not self.charging:
            log("OTA REJECTED: not charging")
            return

        # Send 0% progress
        topic = f"Dart/Receive_mqtt/{self.sn}"
        self.mqtt.publish(topic, json.dumps(
            {"ota_upgrade_state":{"percentage":0,"status":"upgrade"}},
            separators=(',',':')))

        # Start curl download as subprocess (separate process = separate TCP socket)
        self.ota_file = f"/tmp/sim_fw_{self.sn}.deb"
        if os.path.exists(self.ota_file):
            os.remove(self.ota_file)

        # Get file size from first few bytes of response (curl writes incrementally)
        self.ota_total = 0
        self.ota_proc = subprocess.Popen(
            ["curl", "-s", "-o", self.ota_file, "-w", "%{size_download}", url],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        # Estimate total from MD5 context (we know it's ~35MB)
        self.ota_total = 35000000  # Will be corrected after download
        log("Download started (curl subprocess)")

    def _monitor_ota(self, last_pct):
        """Called from main loop — check curl progress, send MQTT updates."""
        if self.ota_proc is None:
            return

        # Check if curl is done
        retcode = self.ota_proc.poll()

        # Report progress based on file size
        if self.ota_file and os.path.exists(self.ota_file):
            fsize = os.path.getsize(self.ota_file)
            if self.ota_total > 0:
                pct = (fsize / self.ota_total) * 0.62
                pct_int = int(pct * 100)
                if pct_int >= last_pct + 2:
                    topic = f"Dart/Receive_mqtt/{self.sn}"
                    self.mqtt.publish(topic, json.dumps(
                        {"ota_upgrade_state":{"percentage":pct,"status":"upgrade"}},
                        separators=(',',':')))
                    log(f"Download: {pct_int}% ({fsize} bytes)")

        if retcode is not None:
            # curl finished
            stdout = self.ota_proc.stdout.read().decode() if self.ota_proc.stdout else ""
            self.ota_proc = None

            fsize = os.path.getsize(self.ota_file) if os.path.exists(self.ota_file) else 0
            self.ota_total = fsize  # Correct total

            if fsize > 1000:
                md5 = hashlib.md5(open(self.ota_file, 'rb').read()).hexdigest()
                log(f"Download complete: {fsize} bytes, MD5: {md5}")
                if self.ota_md5 and md5 != self.ota_md5:
                    log(f"MD5 MISMATCH!")
                    topic = f"Dart/Receive_mqtt/{self.sn}"
                    self.mqtt.publish(topic, json.dumps(
                        {"ota_upgrade_state":{"percentage":0,"status":"fail"}},
                        separators=(',',':')))
                    return
                self.ota_phase = 'unpack'
            else:
                log(f"Download failed: only {fsize} bytes")
                topic = f"Dart/Receive_mqtt/{self.sn}"
                self.mqtt.publish(topic, json.dumps(
                    {"ota_upgrade_state":{"percentage":0,"status":"fail"}},
                    separators=(',',':')))

            # Cleanup
            try:
                os.remove(self.ota_file)
            except:
                pass

    def _do_unpack(self):
        log("Unpacking...")
        topic = f"Dart/Receive_mqtt/{self.sn}"
        for pct in [0.63, 0.65, 0.68]:
            self.mqtt.publish(topic, json.dumps(
                {"ota_upgrade_state":{"percentage":pct,"status":"upgrade"}},
                separators=(',',':')))
            time.sleep(1)
        self.ota_phase = 'install'

    def _do_install(self):
        log("Installing...")
        topic = f"Dart/Receive_mqtt/{self.sn}"
        for p in range(70, 101, 10):
            self.mqtt.publish(topic, json.dumps(
                {"ota_upgrade_state":{"percentage":p/100.0,"status":"upgrade"}},
                separators=(',',':')))
            time.sleep(1)

        log(f"OTA SUCCESS! Version: {self.ota_version}")
        self.firmware_version = self.ota_version
        self.mqtt.publish(topic, json.dumps(
            {"ota_upgrade_state":{"percentage":1.0,"status":"success"}},
            separators=(',',':')))
        time.sleep(3)
        self.ota_phase = 'reboot'

    def _do_reboot(self):
        log("Rebooting (offline 30s)...")
        self.ota_phase = None
        self.mqtt.disconnect()
        if self.ext_mqtt:
            self.ext_mqtt.disconnect()
        time.sleep(30)
        log("Reboot complete")


def main():
    p = argparse.ArgumentParser(description="Novabot Mower Simulator")
    p.add_argument("--broker", default=DEFAULT_BROKER)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--sn", default=DEFAULT_SN)
    p.add_argument("--stock", action="store_true")
    p.add_argument("--not-charging", action="store_true")
    p.add_argument("--battery", type=int, default=85)
    p.add_argument("--fw-version", default=FIRMWARE_VERSION)
    a = p.parse_args()

    print("=" * 50)
    print("  Novabot Mower Simulator")
    print(f"  SN: {a.sn}  Broker: {a.broker}:{a.port}")
    print(f"  Mode: {'STOCK' if a.stock else 'CUSTOM'}  Charging: {not a.not_charging}")
    print("=" * 50)

    sim = MowerSimulator(a.sn, a.broker, a.port, a.stock, not a.not_charging, a.battery, a.fw_version)
    try:
        sim.start()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
