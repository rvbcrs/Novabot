#!/usr/bin/env python3
"""Which MQTT broker should a helper connect to right now?

Shared by extended_commands.py, led_bridge.py and auto_map_node.py (through
extended_commands.connect_mqtt). They used to read the broker address once at
start and reconnect to that address forever, so a server that moved kept them
on the old one (GH #160). They call resolve_broker() before every connect.

The answer is json_config.json's broker, read anew on every call: the same
address mqtt_node uses. Which server that is, is decided in one place,
server_address.py (opennova_discovery.py keeps it current and restarts the
helpers when the broker moves). This module used to try its own list of names
first, and picked the public mqtt.lfibot.com over the configured local broker
on a mower without a DNS redirect (GH #169).

Before the first server is found the configured address is still the stock
mqtt.lfibot.com; it is returned as is, so the ESP32 setup AP (whose DNS
answers that name with itself) keeps working.

Stdlib only. build_custom_firmware.sh copies it next to the helpers in
/root/novabot/scripts/.
"""
import json

CONFIG_FILE = "/userdata/lfi/json_config.json"
LAST_KNOWN_FILE = "/userdata/lfi/server_ip.txt"
DEFAULT_ADDR = "127.0.0.1"
DEFAULT_PORT = 1883


def configured_broker(path=CONFIG_FILE):
    """(addr, port) of the mqtt section in json_config.json; addr None when unreadable."""
    try:
        with open(path) as fh:
            value = (json.load(fh).get("mqtt") or {}).get("value") or {}
        return (str(value["addr"]) if value.get("addr") else None,
                int(value.get("port") or DEFAULT_PORT))
    except Exception:
        return None, DEFAULT_PORT


def last_known_server(path=LAST_KNOWN_FILE):
    try:
        with open(path) as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def resolve_broker(config_file=CONFIG_FILE, last_known_file=LAST_KNOWN_FILE):
    """(addr, port) to connect to now. Reads the files on every call."""
    configured, port = configured_broker(config_file)
    return configured or last_known_server(last_known_file) or DEFAULT_ADDR, port
