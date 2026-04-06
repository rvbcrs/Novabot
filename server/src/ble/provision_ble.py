#!/usr/bin/env python3
"""
Novabot BLE provisioner — uses gatttool (raw HCI) for reliable ESP32 connections on RPi.

gatttool bypasses BlueZ D-Bus and uses raw HCI directly, same as hcitool lecc.
This works where bleak/node-ble (BlueZ D-Bus) fails due to connection parameter issues.

Usage: python3 provision_ble.py <json_params>
  Output: JSON result on stdout, logs on stderr
"""

import json
import subprocess
import sys
import time
import threading

CHUNK_SIZE = 20
INTER_CHUNK_DELAY = 0.05   # 50ms between chunks
POST_WRITE_DELAY = 0.1     # 100ms after ble_end
RESPONSE_TIMEOUT = 12.0


def log(msg):
    print(f"[BLE-PY] {msg}", file=sys.stderr, flush=True)


def to_hex(s: str) -> str:
    """Encode string to hex for gatttool."""
    return s.encode('utf-8').hex()


def chunks_hex(payload: str) -> list[str]:
    """Split payload into <=20-byte hex chunks."""
    data = payload.encode('utf-8')
    return [data[i:i+CHUNK_SIZE].hex() for i in range(0, len(data), CHUNK_SIZE)]


class GattSession:
    """
    Interactive gatttool session via subprocess.
    gatttool -b <MAC> -I starts an interactive session.
    We write commands to stdin and read responses from stdout.
    """

    def __init__(self, mac: str):
        self.mac = mac
        self.proc: subprocess.Popen | None = None
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None

    def start(self) -> None:
        self.proc = subprocess.Popen(
            ['gatttool', '-b', self.mac, '-I'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()

    def _read_stdout(self) -> None:
        for line in self.proc.stdout:
            line = line.rstrip()
            if line:
                log(f"GATT< {line}")
                with self._lock:
                    self._lines.append(line)

    def cmd(self, command: str) -> None:
        log(f"GATT> {command}")
        self.proc.stdin.write(command + '\n')
        self.proc.stdin.flush()

    def wait_for(self, pattern: str, timeout: float = 10.0) -> str | None:
        deadline = time.monotonic() + timeout
        checked = 0
        while time.monotonic() < deadline:
            with self._lock:
                for line in self._lines[checked:]:
                    if pattern.lower() in line.lower():
                        return line
                checked = len(self._lines)
            time.sleep(0.1)
        return None

    def stop(self) -> None:
        try:
            self.cmd('quit')
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            pass


class NotifyCapture:
    """Captures BLE notifications in a background thread."""

    def __init__(self, mac: str, char_handle: str):
        self.mac = mac
        self.char_handle = char_handle
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._proc = subprocess.Popen(
            ['gatttool', '-b', self.mac, '--listen', '--char-read', '-a', self.char_handle],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        for line in self._proc.stdout:
            line = line.rstrip()
            if 'notification handle' in line.lower() or 'value:' in line.lower():
                log(f"NOTIFY< {line}")
                with self._lock:
                    self._lines.append(line)

    def stop(self) -> None:
        try:
            self._proc.terminate()
        except Exception:
            pass

    def get_lines(self) -> list[str]:
        with self._lock:
            return list(self._lines)


def hex_to_bytes(hex_str: str) -> bytes:
    """Convert notification hex string to bytes."""
    # Format: "Notification handle = 0x0021 value: 62 6c 65 5f 73 74 61 72 74"
    if 'value:' in hex_str:
        hex_part = hex_str.split('value:')[1].strip()
    else:
        hex_part = hex_str.strip()
    return bytes.fromhex(hex_part.replace(' ', ''))


# GATT characteristic handles (handle addresses for mower and charger)
# These are the ATT handles corresponding to the UUIDs.
# We discover them dynamically using char-desc.
KNOWN_HANDLES = {
    'mower': {
        'write': None,   # UUID 0x0011 — discovered
        'notify': None,  # UUID 0x0021 — discovered
    },
    'charger': {
        'write': None,   # UUID 0x2222 — discovered
        'notify': None,  # UUID 0x2222 — discovered
    },
}

WRITE_UUIDS = {
    'mower': '00000011-0000-1000-8000-00805f9b34fb',
    'charger': '00002222-0000-1000-8000-00805f9b34fb',
}
NOTIFY_UUIDS = {
    'mower': '00000021-0000-1000-8000-00805f9b34fb',
    'charger': '00002222-0000-1000-8000-00805f9b34fb',
}


def discover_handles(mac: str, device_type: str) -> tuple[str, str]:
    """Discover write and notify characteristic handles via gatttool char-disc."""
    write_uuid = WRITE_UUIDS[device_type].replace('-', '').lower()
    notify_uuid = NOTIFY_UUIDS[device_type].replace('-', '').lower()

    try:
        result = subprocess.run(
            ['gatttool', '-b', mac, '--char-disc'],
            capture_output=True, text=True, timeout=20,
        )
        write_handle = None
        notify_handle = None
        for line in result.stdout.splitlines():
            line_lower = line.lower()
            if write_uuid in line_lower:
                # Extract handle: "handle = 0x0011, ..."
                parts = line.split(',')
                for p in parts:
                    if 'handle' in p.lower():
                        write_handle = p.split('=')[1].strip().split()[0]
                        break
            if notify_uuid in line_lower and notify_uuid != write_uuid:
                parts = line.split(',')
                for p in parts:
                    if 'handle' in p.lower():
                        notify_handle = p.split('=')[1].strip().split()[0]
                        break
        if not write_handle:
            raise Exception(f"Write characteristic not found (UUID {write_uuid})")
        if not notify_handle:
            notify_handle = write_handle
        log(f"Handles: write={write_handle} notify={notify_handle}")
        return write_handle, notify_handle
    except subprocess.TimeoutExpired:
        raise Exception("char-disc timed out")


def write_frame_sync(mac: str, write_handle: str, payload: str) -> None:
    """Write a BLE frame synchronously using gatttool char-write-cmd."""
    def gatt_write(data_hex: str) -> None:
        subprocess.run(
            ['gatttool', '-b', mac, '--char-write-cmd', '-a', write_handle, '-n', data_hex],
            timeout=10, check=True, capture_output=True,
        )

    gatt_write(to_hex('ble_start'))
    time.sleep(INTER_CHUNK_DELAY)

    for chunk_hex in chunks_hex(payload):
        gatt_write(chunk_hex)
        time.sleep(INTER_CHUNK_DELAY)

    gatt_write(to_hex('ble_end'))
    time.sleep(POST_WRITE_DELAY)


def wait_for_response_sync(capture: NotifyCapture, expected_type: str, timeout: float = RESPONSE_TIMEOUT) -> dict:
    """Wait for a complete BLE response frame from the notify capture."""
    buffer = ''
    collecting = False
    seen = 0
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        lines = capture.get_lines()
        for line in lines[seen:]:
            seen += 1
            try:
                data = hex_to_bytes(line)
                s = data.decode('utf-8', errors='replace').replace('\x00', '')
            except Exception:
                continue

            if s == 'ble_start':
                collecting = True
                buffer = ''
            elif s == 'ble_end' and collecting:
                collecting = False
                try:
                    parsed = json.loads(buffer)
                except Exception:
                    parsed = buffer
                resp_type = parsed.get('type', '') if isinstance(parsed, dict) else ''
                if resp_type and expected_type not in resp_type:
                    log(f"Draining stale: {resp_type} (want {expected_type})")
                    continue
                return parsed
            elif collecting:
                buffer += s
        time.sleep(0.1)

    raise TimeoutError(f'Response timeout after {timeout}s waiting for {expected_type}')


def send_command_sync(mac: str, write_handle: str, capture: NotifyCapture,
                      payload: str, label: str, timeout: float = RESPONSE_TIMEOUT) -> dict:
    log(f"→ {label}: {payload}")
    write_frame_sync(mac, write_handle, payload)
    response = wait_for_response_sync(capture, label, timeout)
    log(f"← {label}: {json.dumps(response)}")
    result = response.get('message', {}).get('result') if isinstance(response, dict) else None
    ok = result == 0 or result is None
    return {'response': response, 'ok': ok}


def provision(params: dict) -> dict:
    target_mac = params['targetMac']
    wifi_ssid = params['wifiSsid']
    wifi_password = params['wifiPassword']
    mqtt_addr = params.get('mqttAddr', 'mqtt.lfibot.com')
    mqtt_port = params.get('mqttPort', 1883)
    lora_addr = params.get('loraAddr', 718)
    lora_channel = params.get('loraChannel', 15)
    lora_hc = params.get('loraHc', 20)
    lora_lc = params.get('loraLc', 14)
    timezone = params.get('timezone', 'Europe/Amsterdam')
    device_type = params.get('deviceType', 'mower')
    steps = []

    # ── Step 1: Discover handles ─────────────────────────────────────────
    log(f"Discovering GATT handles for {target_mac}...")
    last_err = None
    for attempt in range(1, 4):
        try:
            write_handle, notify_handle = discover_handles(target_mac, device_type)
            break
        except Exception as e:
            last_err = str(e)
            log(f"Discover attempt {attempt} failed: {last_err}")
            if attempt < 3:
                log("Retrying in 3s...")
                time.sleep(3)
    else:
        raise Exception(f"Handle discovery failed after 3 attempts: {last_err}")

    # ── Step 2: Set up notify capture ────────────────────────────────────
    capture = NotifyCapture(target_mac, notify_handle)
    capture.start()
    time.sleep(1.0)

    try:
        # ── Step 3: get_signal_info ──────────────────────────────────────
        try:
            r = send_command_sync(target_mac, write_handle, capture,
                                  json.dumps({'get_signal_info': 0}), 'get_signal_info', 5.0)
            steps.append({'command': 'get_signal_info', 'sent': {'get_signal_info': 0}, **r})
        except Exception as e:
            log(f"get_signal_info no response (non-fatal): {e}")
            steps.append({'command': 'get_signal_info', 'sent': {'get_signal_info': 0}, 'response': None, 'ok': False})
        time.sleep(1.0)

        # ── Step 4: set_wifi_info ────────────────────────────────────────
        if device_type == 'mower':
            wifi_payload = {'set_wifi_info': {'ap': {'ssid': wifi_ssid, 'passwd': wifi_password, 'encrypt': 0}}}
        else:
            wifi_payload = {'set_wifi_info': {
                'sta': {'ssid': wifi_ssid, 'passwd': wifi_password, 'encrypt': 0},
                'ap': {'ssid': 'CHARGER_PILE', 'passwd': '12345678', 'encrypt': 0},
            }}
        try:
            r = send_command_sync(target_mac, write_handle, capture,
                                  json.dumps(wifi_payload), 'set_wifi_info', 15.0)
            steps.append({'command': 'set_wifi_info', 'sent': wifi_payload, **r})
        except Exception as e:
            log(f"set_wifi_info no response (non-fatal): {e}")
            steps.append({'command': 'set_wifi_info', 'sent': wifi_payload, 'response': None, 'ok': False})
        time.sleep(1.0)

        # ── Step 5: set_lora_info ────────────────────────────────────────
        lora_payload = {'set_lora_info': {'addr': lora_addr, 'channel': lora_channel, 'hc': lora_hc, 'lc': lora_lc}}
        try:
            r = send_command_sync(target_mac, write_handle, capture,
                                  json.dumps(lora_payload), 'set_lora_info', 15.0)
            steps.append({'command': 'set_lora_info', 'sent': lora_payload, **r})
        except Exception as e:
            log(f"set_lora_info no response (non-fatal): {e}")
            steps.append({'command': 'set_lora_info', 'sent': lora_payload, 'response': None, 'ok': False})
        time.sleep(1.0)

        # ── Step 6: set_mqtt_info ────────────────────────────────────────
        mqtt_payload = {'set_mqtt_info': {'addr': mqtt_addr, 'port': mqtt_port}}
        try:
            r = send_command_sync(target_mac, write_handle, capture,
                                  json.dumps(mqtt_payload), 'set_mqtt_info', 15.0)
            steps.append({'command': 'set_mqtt_info', 'sent': mqtt_payload, **r})
        except Exception as e:
            log(f"set_mqtt_info no response (non-fatal): {e}")
            steps.append({'command': 'set_mqtt_info', 'sent': mqtt_payload, 'response': None, 'ok': False})
        time.sleep(1.0)

        # ── Step 7: set_cfg_info (commit) ────────────────────────────────
        if device_type == 'mower':
            cfg_payload = {'set_cfg_info': {'cfg_value': 1, 'tz': timezone}}
        else:
            cfg_payload = {'set_cfg_info': 1}
        try:
            r = send_command_sync(target_mac, write_handle, capture,
                                  json.dumps(cfg_payload), 'set_cfg_info', 15.0)
            steps.append({'command': 'set_cfg_info', 'sent': cfg_payload, **r})
        except Exception as e:
            msg = str(e)
            if any(x in msg.lower() for x in ['timeout', 'disconnect', 'not connected', 'closed', 'broken']):
                log("set_cfg_info caused disconnect (expected — device restarting)")
                steps.append({'command': 'set_cfg_info', 'sent': cfg_payload, 'response': None, 'ok': True})
            else:
                raise

        return {'success': True, 'steps': steps}

    finally:
        capture.stop()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'No params provided'}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        result = provision(params)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'success': False, 'steps': [], 'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
